// Интерфейс командной строки: oboz [tui|news|item|watch|sources] [флаги].
import { promises as fs } from 'node:fs';
import { buildDigest, enrichEvent } from './digest.js';
import { loadConfig, loadSources } from './config.js';
import { fetchAllSources } from './rss.js';
import { formatDigest, formatEmpty, formatDossier, formatSourcesTable, publicEvent, REGION_NAMES } from './format.js';
import { runWatch } from './watch.js';
import { runTui } from './tui.js';
import { parseDuration, formatDateTimeRu } from './util.js';
import { ROOT } from './paths.js';

const VALUE_FLAGS = new Set(['region', 'threshold', 'limit', 'every', 'cache-dir', 'width']);
const REGIONS = ['ru', 'world', 'all'];

function parseArgs(argv) {
  const flags = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') {
      flags._.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith('--')) {
      const body = arg.slice(2);
      const eq = body.indexOf('=');
      if (eq !== -1) {
        flags[body.slice(0, eq)] = body.slice(eq + 1);
        continue;
      }
      if (VALUE_FLAGS.has(body) && argv[i + 1] && !argv[i + 1].startsWith('--')) {
        flags[body] = argv[i + 1];
        i += 1;
        continue;
      }
      flags[body] = true;
      continue;
    }
    if (arg.startsWith('-') && arg.length > 1) {
      for (const letter of arg.slice(1)) flags[letter] = true;
      continue;
    }
    flags._.push(arg);
  }
  return flags;
}

function parseThreshold(value) {
  if (value === undefined || value === true) return undefined;
  const num = Number(String(value).replace(',', '.'));
  if (!Number.isFinite(num) || num < 0 || num > 1) {
    throw new Error('Порог должен быть числом от 0 до 1, например --threshold 0.55');
  }
  return num;
}

function parseRegion(value, fallback) {
  if (value === undefined || value === true) return fallback;
  if (!REGIONS.includes(value)) throw new Error(`Регион должен быть одним из: ${REGIONS.join(', ')}`);
  return value;
}

function parseLimit(value, fallback) {
  if (value === undefined || value === true) return fallback;
  const num = Number(value);
  if (!Number.isFinite(num) || num < 1) throw new Error('--limit должен быть положительным числом');
  return Math.floor(num);
}

function parsePositiveInt(value) {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? Math.floor(num) : null;
}

const HELP = `ОБОЗРЕВАТЕЛЬ — терминальный сторож новостей

Показывает только те события, которые превысили ваш порог значимости
и подтверждены несколькими независимыми источниками. Если ничего
существенного не произошло — сообщает об этом (или печатает пусто с --quiet).

КОМАНДЫ
  oboz                        интерактивный разбор (стрелки, Enter, Esc)
  oboz tui                    то же самое
  oboz news                   сводка в терминал
  oboz item <id>              полное досье события по id
  oboz watch [--every 60m]    периодический обзор (по умолчанию раз в час)
  oboz sources [--check]      список источников / проверка доступности
  oboz help                   эта справка

ФЛАГИ
  --region ru|world|all       регион повестки (по умолчанию ru)
  --threshold 0.55            порог значимости 0..1
  --limit 12                  сколько событий показать
  --json                      машинный вывод (news)
  --explain                   показать, что и почему не прошло фильтр
  --quiet                     пустой вывод, если ничего не произошло
  --demo                      демонстрационные данные без сети
  --no-cache                  заново скачать ленты
  --wiki                      подгрузить справку Википедии в news
  --every 60m                 период для watch (30s, 15m, 1h)
  --once                      один цикл watch и выход
  --width 96                  ширина обычного вывода

ПРИМЕРЫ
  oboz news --region ru --threshold 0.6
  oboz news --region world --explain
  oboz watch --every 1h --quiet
  oboz tui

ПОДРОБНЕЕ: README.md и docs/CONTRACTS.md`;

async function cmdNews(flags) {
  const config = await loadConfig();
  const region = parseRegion(flags.region, config.region);
  const threshold = parseThreshold(flags.threshold);
  const limit = parseLimit(flags.limit, config.limit);
  const digest = await buildDigest({
    region,
    threshold,
    limit,
    demo: Boolean(flags.demo),
    noCache: Boolean(flags['no-cache']),
    wiki: Boolean(flags.wiki),
  });

  if (flags.json) {
    const payload = {
      generatedAt: new Date(digest.generatedAt).toISOString(),
      region: digest.region,
      threshold: digest.threshold,
      empty: digest.empty,
      stats: digest.stats,
      passed: digest.passed.map(publicEvent),
      rejected: digest.rejected.map((event) => ({ id: event.id, title: event.title, score: event.score, reasons: event.reasons })),
    };
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return 0;
  }

  if (!digest.passed.length) {
    if (flags.quiet) return 0; // пустой вывод для скриптов
    process.stdout.write(`${formatEmpty(digest)}\n`);
    return 0;
  }

  process.stdout.write(`${formatDigest(digest, { explain: Boolean(flags.explain), width: parsePositiveInt(flags.width) || 96 })}\n`);
  return 0;
}

async function cmdItem(flags) {
  const id = flags._[1];
  if (!id) {
    process.stderr.write('Укажите id события: oboz item <id> (id виден в сводке)\n');
    return 2;
  }
  const config = await loadConfig();
  const region = parseRegion(flags.region, 'all');
  const digest = await buildDigest({
    region,
    threshold: 0,
    limit: 50,
    demo: Boolean(flags.demo),
    noCache: Boolean(flags['no-cache']),
    wiki: false,
  });
  const event = digest.events.find((candidate) => candidate.id === id || candidate.id.startsWith(id));
  if (!event) {
    process.stderr.write(`Событие «${id}» не найдено в текущем обзоре. Попробуйте --region all или --no-cache.\n`);
    return 1;
  }
  const enriched = await enrichEvent(event, { limit: 3 });
  process.stdout.write(`${formatDossier(enriched, config)}\n`);
  return 0;
}

async function cmdWatch(flags) {
  const config = await loadConfig();
  const region = parseRegion(flags.region, config.region);
  const threshold = parseThreshold(flags.threshold) ?? config.threshold;
  const limit = parseLimit(flags.limit, config.limit);
  const everyMs = flags.every
    ? parseDuration(flags.every)
    : (config.refreshEveryMinutes || 60) * 60_000;
  if (!everyMs) throw new Error('Не понял период --every. Примеры: 30s, 15m, 1h, 60m');
  await runWatch({
    region,
    threshold,
    limit,
    everyMs,
    demo: Boolean(flags.demo),
    quiet: Boolean(flags.quiet),
    once: Boolean(flags.once),
    notify: flags.notify !== false && config.notify !== false,
  });
  return 0;
}

async function cmdSources(flags) {
  const { sources, meta } = await loadSources();
  let checks = null;
  if (flags.check) {
    process.stdout.write('Проверяю источники…\n');
    const { results } = await fetchAllSources(sources, { cacheTtlSec: 60, noCache: true });
    checks = {};
    for (const result of results) {
      const latest = result.items.reduce((max, item) => Math.max(max, item.publishedAt || 0), 0);
      checks[result.source.id] = {
        ok: result.items.length > 0,
        items: result.items.length,
        latest,
        error: result.error,
        fromCache: result.fromCache,
      };
    }
    process.stdout.write(`${formatSourcesTable(sources, checks)}\n\n`);
    const ok = Object.values(checks).filter((c) => c.ok).length;
    process.stdout.write(`Итого: ${ok}/${sources.length} источников отвечают. Обновлено: ${meta.updatedAt || '—'}\n`);
    return 0;
  }
  process.stdout.write(`${formatSourcesTable(sources)}\n`);
  process.stdout.write(`\nОбновлено: ${meta.updatedAt || '—'}. Проверить доступность: oboz sources --check\n`);
  return 0;
}

async function cmdTui(flags) {
  const config = await loadConfig();
  const region = parseRegion(flags.region, config.region);
  const threshold = parseThreshold(flags.threshold);
  const limit = parseLimit(flags.limit, config.limit);
  const baseOptions = {
    region,
    threshold,
    limit,
    demo: Boolean(flags.demo),
    noCache: Boolean(flags['no-cache']),
  };
  const digest = await buildDigest({ ...baseOptions, wiki: false });
  return runTui({
    digest,
    config,
    options: baseOptions,
    rebuild: (extra = {}) => buildDigest({ ...baseOptions, ...extra, wiki: false }),
  });
}

async function cmdHelp() {
  process.stdout.write(`${HELP}\n`);
  return 0;
}

async function cmdVersion() {
  const pkg = JSON.parse(await fs.readFile(`${ROOT}/package.json`, 'utf8'));
  process.stdout.write(`oboz ${pkg.version}\n`);
  return 0;
}

export async function main(argv) {
  const flags = parseArgs(argv);
  const command = String(flags._[0] || (flags.demo ? 'tui' : 'tui')).toLowerCase();

  if (flags.help || command === 'help' || command === '-h' || command === 'h') return cmdHelp();
  if (flags.version || command === 'version' || command === 'v') return cmdVersion();

  switch (command) {
    case 'tui':
    case 'ui':
      return cmdTui(flags);
    case 'news':
    case 'digest':
      return cmdNews(flags);
    case 'item':
    case 'show':
      return cmdItem(flags);
    case 'watch':
    case 'loop':
      return cmdWatch(flags);
    case 'sources':
    case 'source':
      return cmdSources(flags);
    case 'config':
      process.stdout.write(`${JSON.stringify(await loadConfig(), null, 2)}\n`);
      return 0;
    default:
      process.stderr.write(`Неизвестная команда «${command}». Справка: oboz help\n`);
      return 2;
  }
}
