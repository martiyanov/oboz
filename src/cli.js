// Интерфейс командной строки: oboz [tui|news|item|watch|sources] [флаги].
import { promises as fs } from 'node:fs';
import { buildDigest, enrichEvent } from './digest.js';
import { loadConfig, loadSources } from './config.js';
import { fetchAllSources } from './rss.js';
import { formatDigest, formatEmpty, formatDossier, formatSourcesTable, publicEvent, REGION_NAMES } from './format.js';
import { runWatch } from './watch.js';
import { runTui } from './tui.js';
import { parseDuration, formatDateTimeRu } from './util.js';
import { loadTopics, categoryList, cityList } from './topics.js';
import { ROOT } from './paths.js';

class UserError extends Error {
  constructor(message) {
    super(message);
    this.isUserError = true;
  }
}

const VALUE_FLAGS = new Set(['region', 'threshold', 'limit', 'every', 'cache-dir', 'width', 'category', 'city']);
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
  if (value === undefined) return undefined;
  if (value === true || value === '') throw new UserError('--threshold требует числовое значение, например --threshold 0.55');
  const num = Number(String(value).replace(',', '.'));
  if (!Number.isFinite(num) || num < 0 || num > 1) {
    throw new UserError('Порог должен быть числом от 0 до 1, например --threshold 0.55');
  }
  return num;
}

function parseRegion(value, fallback) {
  if (value === undefined) return fallback;
  if (value === true || value === '') throw new UserError('--region требует значение: ru, world или all');
  if (!REGIONS.includes(value)) throw new UserError(`Регион должен быть одним из: ${REGIONS.join(', ')}`);
  return value;
}

async function parseCategory(value) {
  if (value === undefined) return 'all';
  if (value === true || value === '') throw new UserError('--category требует значение, например --category tech');
  const catalog = await loadTopics();
  if (value === 'all' || catalog.categoryIds.has(value)) return value;
  throw new UserError(`Неизвестная тема «${value}». Доступно: ${categoryList(catalog).map((item) => item.id).join(', ')}`);
}

async function parseCity(value) {
  if (value === undefined) return 'all';
  if (value === true || value === '') throw new UserError('--city требует значение, например --city moscow');
  const catalog = await loadTopics();
  if (value === 'all' || catalog.cityIds.has(value)) return value;
  throw new UserError(`Неизвестный город «${value}». Доступно: ${cityList(catalog).map((item) => item.id).join(', ')}`);
}

function parseLimit(value, fallback) {
  if (value === undefined) return fallback;
  if (value === true || value === '') throw new UserError('--limit требует число, например --limit 12');
  const num = Number(value);
  if (!Number.isFinite(num) || num < 1) throw new UserError('--limit должен быть положительным числом');
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
  --category all|tech|music|… тема: politics, economy, society, tech, music,
                              culture, science, sport, incidents (или all)
  --city all|moscow|nizhny    город: Москва или Нижний Новгород
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
  oboz news --category tech
  oboz news --city moscow --threshold 0.5
  oboz news --region world --explain
  oboz watch --every 1h --quiet
  oboz tui

ПОДРОБНЕЕ: README.md и docs/CONTRACTS.md`;

async function cmdNews(flags) {
  const config = await loadConfig();
  const region = parseRegion(flags.region, config.region);
  const threshold = parseThreshold(flags.threshold);
  const limit = parseLimit(flags.limit, config.limit);
  const category = await parseCategory(flags.category);
  const city = await parseCity(flags.city);
  const spinner = !flags.json && process.stderr.isTTY;
  if (spinner) process.stderr.write('Загружаю ленты…\r');
  const digest = await buildDigest({
    region,
    threshold,
    limit,
    demo: Boolean(flags.demo),
    noCache: Boolean(flags['no-cache']),
    wiki: Boolean(flags.wiki),
    category,
    city,
  });
  if (spinner) process.stderr.write('\r\x1b[K');

  if (!digest.stats.demo && digest.stats.sourcesOk === 0) {
    process.stderr.write('Не удалось загрузить ни один источник. Проверьте сеть: ./oboz sources --check\n');
    return 2;
  }

  if (flags.json) {
    const payload = {
      generatedAt: new Date(digest.generatedAt).toISOString(),
      region: digest.region,
      threshold: digest.threshold,
      category: digest.category,
      city: digest.city,
      filters: digest.filters,
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
    if (flags.explain) {
      // Показываем, что именно и почему отсеклось, даже если не прошло ничего.
      process.stdout.write(`${formatDigest(digest, { explain: true, width: parsePositiveInt(flags.width) || 96 })}\n`);
      return 0;
    }
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
  if (!everyMs) throw new UserError('Не понял период --every. Примеры: 30s, 15m, 1h, 60m');
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
  if (process.stderr.isTTY) process.stderr.write('Загружаю ленты…\r');
  const digest = await buildDigest({ ...baseOptions, wiki: false });
  if (process.stderr.isTTY) process.stderr.write('\r\x1b[K');
  if (!digest.stats.demo && digest.stats.sourcesOk === 0) {
    process.stderr.write('Не удалось загрузить ни один источник. Проверьте сеть: ./oboz sources --check\n');
    return 2;
  }
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

async function dispatch(argv) {
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

export async function main(argv) {
  try {
    return await dispatch(argv);
  } catch (error) {
    if (error?.isUserError) {
      process.stderr.write(`${error.message}\n`);
      return 2;
    }
    process.stderr.write(`Ошибка: ${error?.message || error}\n`);
    if (process.env.OBOZ_DEBUG) process.stderr.write(`${error?.stack || ''}\n`);
    return 1;
  }
}
