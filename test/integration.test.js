// Интеграционные тесты CLI и watch: только офлайн (демо-набор), состояние и кэш — во временных папках.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, chmodSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

import { buildDigest } from '../src/digest.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OBOZ = path.join(ROOT, 'oboz');
const NOW = Date.parse('2026-11-08T09:00:00Z');

// Временное «рабочее место» для CLI: свой .state и .cache + заглушка osascript,
// чтобы watch не показывал настоящих системных уведомлений во время тестов.
function makeWorkspace() {
  const dir = mkdtempSync(path.join(tmpdir(), 'oboz-it-'));
  const stateDir = path.join(dir, 'state');
  const cacheDir = path.join(dir, 'cache');
  const binDir = path.join(dir, 'bin');
  for (const target of [stateDir, cacheDir, binDir]) mkdirSync(target, { recursive: true });
  const osascript = path.join(binDir, 'osascript');
  writeFileSync(osascript, '#!/bin/sh\nexit 0\n', 'utf8');
  chmodSync(osascript, 0o755);
  return {
    dir,
    stateDir,
    cacheDir,
    env: {
      OBOZ_STATE_DIR: stateDir,
      OBOZ_CACHE_DIR: cacheDir,
      PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}`,
    },
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function runCli(args, { workspace, timeout = 30_000 } = {}) {
  return spawnSync(process.execPath, [OBOZ, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout,
    env: { ...process.env, ...(workspace ? workspace.env : {}) },
  });
}

function assertNoStack(stderr) {
  assert.ok(!/\n\s+at /.test(stderr), `в stderr не должно быть stack trace:\n${stderr}`);
}

// Заранее заполняем кэш Википедии в temp-каталоге, чтобы `oboz item` в тестах
// не ходил в сеть. Ключ кэша — sha1('v2|ru|<сущность в нижнем регистре>'), см. src/evidence.js.
function seedWikiCache(cacheDir, entities, marker) {
  const wikiDir = path.join(cacheDir, 'wiki');
  mkdirSync(wikiDir, { recursive: true });
  for (const entity of entities || []) {
    const hash = createHash('sha1').update(`v2|ru|${entity.toLowerCase()}`).digest('hex').slice(0, 20);
    const refs = [{
      title: `Справка: ${entity}`,
      url: `https://ru.wikipedia.org/wiki/${encodeURIComponent(`Справка_${entity}`)}`,
      extract: marker,
      lang: 'ru',
    }];
    writeFileSync(
      path.join(wikiDir, `${hash}.json`),
      JSON.stringify({ refs, fetchedAt: new Date().toISOString() }),
      'utf8',
    );
  }
}

// ===========================================================================
// news: пустой вывод, JSON, регионы, ошибки аргументов
// ===========================================================================

test('CLI: news --demo --quiet --threshold 0.95 — ровно 0 байт stdout', () => {
  const ws = makeWorkspace();
  try {
    const result = runCli(['news', '--demo', '--quiet', '--threshold', '0.95'], { workspace: ws });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
    assert.equal(Buffer.byteLength(result.stdout), 0);
    assert.equal(result.stderr, '');
  } finally {
    ws.cleanup();
  }
});

test('CLI: news --demo --json — валидный JSON со stats/passed/rejected', () => {
  const ws = makeWorkspace();
  try {
    const result = runCli(['news', '--demo', '--json'], { workspace: ws });
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.deepEqual(
      Object.keys(payload),
      ['generatedAt', 'region', 'threshold', 'category', 'city', 'filters', 'empty', 'stats', 'passed', 'rejected'],
    );
    assert.equal(payload.region, 'ru');
    assert.equal(payload.threshold, 0.55);
    assert.equal(payload.category, 'all');
    assert.equal(payload.city, 'all');
    assert.equal(payload.empty, false);
    assert.ok(!Number.isNaN(Date.parse(payload.generatedAt)));
    assert.equal(payload.stats.demo, true);
    assert.equal(payload.stats.articlesUsed, 14);
    assert.equal(payload.stats.clusters, 8);
    assert.equal(payload.stats.events, 7);
    assert.equal(payload.stats.passed, 3);
    assert.equal(payload.passed.length, 3);
    assert.equal(payload.rejected.length, 4);

    for (const event of payload.passed) {
      assert.equal(typeof event.id, 'string');
      assert.match(event.id, /^[0-9a-f]{8}$/);
      assert.ok(event.score >= 0.55);
      assert.ok(Array.isArray(event.domains) && event.domains.length >= 2);
      assert.ok(Array.isArray(event.claims));
      assert.ok(Array.isArray(event.articles) && event.articles.length >= 2);
      for (const article of event.articles) assert.match(article.link, /^https:\/\//);
    }
    for (const event of payload.rejected) {
      assert.ok(Array.isArray(event.reasons));
      assert.equal(typeof event.score, 'number');
    }
  } finally {
    ws.cleanup();
  }
});

test('CLI: news --demo --json --threshold 0.95 — пустой результат, всё в rejected', () => {
  const ws = makeWorkspace();
  try {
    const result = runCli(['news', '--demo', '--json', '--threshold', '0.95'], { workspace: ws });
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.threshold, 0.95);
    assert.equal(payload.empty, true);
    assert.deepEqual(payload.passed, []);
    assert.equal(payload.rejected.length, 7);
    assert.equal(payload.stats.passed, 0);
  } finally {
    ws.cleanup();
  }
});

test('CLI: region world показывает мировую повестку', () => {
  const ws = makeWorkspace();
  try {
    const result = runCli(['news', '--demo', '--region', 'world'], { workspace: ws });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /ОБОЗРЕВАТЕЛЬ · МИР/);
    assert.match(result.stdout, /Краков/, 'событие из мировой повестки');
  } finally {
    ws.cleanup();
  }
});

test('CLI: неверные аргументы — код 2, понятное сообщение без stack trace', () => {
  const ws = makeWorkspace();
  try {
    const cases = [
      { args: ['news', '--demo', '--threshold', '2'], expected: /Порог должен быть числом от 0 до 1/ },
      { args: ['news', '--demo', '--region', 'mars'], expected: /Регион должен быть одним из/ },
      { args: ['news', '--demo', '--limit', '0'], expected: /--limit должен быть положительным числом/ },
      { args: ['news', '--demo', '--threshold', 'NaN'], expected: /Порог должен быть числом от 0 до 1/ },
      { args: ['news', '--demo', '--threshold=abc'], expected: /Порог должен быть числом от 0 до 1/ },
      { args: ['item'], expected: /Укажите id события/ },
    ];
    for (const { args, expected } of cases) {
      const result = runCli(args, { workspace: ws });
      assert.equal(result.status, 2, `${args.join(' ')}: ${result.stderr}`);
      assert.match(result.stderr, expected);
      assertNoStack(result.stderr);
    }
  } finally {
    ws.cleanup();
  }
});

test('CLI: help/config/sources/version работают офлайн', () => {
  const ws = makeWorkspace();
  try {
    const help = runCli(['help'], { workspace: ws });
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /КОМАНДЫ/);
    assert.match(help.stdout, /oboz news/);

    const config = runCli(['config'], { workspace: ws });
    assert.equal(config.status, 0, config.stderr);
    const configJson = JSON.parse(config.stdout);
    assert.equal(configJson.threshold, 0.55);
    assert.equal(configJson.minDomains, 2);

    const sources = runCli(['sources'], { workspace: ws });
    assert.equal(sources.status, 0, sources.stderr);
    assert.match(sources.stdout, /ИСТОЧНИКИ/);
    assert.match(sources.stdout, /tass/);

    const version = runCli(['--version'], { workspace: ws });
    assert.equal(version.status, 0, version.stderr);
    assert.match(version.stdout, /^oboz \d+\.\d+\.\d+/);
  } finally {
    ws.cleanup();
  }
});

test('CLI: несуществующий id у item — код 1', () => {
  const ws = makeWorkspace();
  try {
    const result = runCli(['item', 'zzzzzzzz', '--demo'], { workspace: ws });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /не найдено/);
  } finally {
    ws.cleanup();
  }
});

test('CLI: --explain показывает отклонённые события с причинами', () => {
  const ws = makeWorkspace();
  try {
    const result = runCli(['news', '--demo', '--explain'], { workspace: ws });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /НЕ ПРОШЛИ ФИЛЬТР/);
    assert.match(result.stdout, /Источник сообщил о возможной отставке/);
    assert.match(result.stdout, /ниже порога 0\.55/);
    assert.match(result.stdout, /нужно минимум 2/);
  } finally {
    ws.cleanup();
  }
});

// Регрессия BUG-2: раньше при пустом passed CLI печатал только formatEmpty
// и игнорировал --explain, поэтому при высоком пороге причины отказа не были видны.
test('регрессия BUG-2: --explain работает и когда ни одно событие не прошло', () => {
  const ws = makeWorkspace();
  try {
    const result = runCli(['news', '--demo', '--threshold', '0.9', '--explain'], { workspace: ws });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /НЕ ПРОШЛИ ФИЛЬТР/);
  } finally {
    ws.cleanup();
  }
});

// ===========================================================================
// item: досье события (сеть отключена подменой кэша Википедии)
// ===========================================================================

test('CLI: item <id> --demo — досье с разделами и офлайн-справкой', async () => {
  const ws = makeWorkspace();
  try {
    const news = runCli(['news', '--demo', '--json'], { workspace: ws });
    assert.equal(news.status, 0, news.stderr);
    const payload = JSON.parse(news.stdout);
    const id = payload.passed[0].id;

    // Находим событие в том же демо-наборе, чтобы узнать его сущности для кэша Википедии.
    const digest = await buildDigest({ demo: true, now: NOW, wiki: false });
    const event = digest.events.find((candidate) => candidate.id === id)
      || digest.passed.find((candidate) => candidate.id === id);
    assert.ok(event, 'демо-событие найдено по id');
    const marker = 'Фоновая справка из офлайн-фикстуры QA.';
    seedWikiCache(ws.cacheDir, event.entities, marker);

    const result = runCli(['item', id, '--demo'], { workspace: ws });
    assert.equal(result.status, 0, result.stderr);
    for (const section of [
      'ЧТО ПРОИЗОШЛО',
      'ТЕЗИСЫ',
      'ПОДТВЕРЖДЕНИЯ',
      'ПРОВЕРКА',
      'Официальный первоисточник',
      'ФОН: ВИКИПЕДИЯ',
    ]) {
      assert.ok(result.stdout.includes(section), `в досье нет раздела «${section}»`);
    }
    assert.ok(
      result.stdout.includes(marker),
      'досье должно брать Википедию из офлайн-кэша (сеть в тестах не используется)',
    );
  } finally {
    ws.cleanup();
  }
});

// ===========================================================================
// watch --once: состояние в OBOZ_STATE_DIR, без дублей
// ===========================================================================

test('CLI: watch --once пишет новые события, повторный прогон не дублирует', () => {
  const ws = makeWorkspace();
  try {
    const first = runCli(['watch', '--demo', '--once'], { workspace: ws });
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /Новые значимые события: 3/);
    assert.match(first.stdout, /Курской области/);

    const seenPath = path.join(ws.stateDir, 'seen.json');
    const logPath = path.join(ws.stateDir, 'digest.log');
    assert.ok(existsSync(seenPath), 'состояние пишется в OBOZ_STATE_DIR/seen.json');
    assert.ok(existsSync(logPath), 'журнал пишется в OBOZ_STATE_DIR/digest.log');

    const seenFirst = JSON.parse(readFileSync(seenPath, 'utf8'));
    assert.equal(seenFirst.ids.length, 3);
    for (const id of seenFirst.ids) assert.match(id, /^[0-9a-f]{8}$/);
    const logFirst = readFileSync(logPath, 'utf8');
    assert.match(logFirst, /3 новых событий/);

    const second = runCli(['watch', '--demo', '--once', '--quiet'], { workspace: ws });
    assert.equal(second.status, 0, second.stderr);
    assert.equal(second.stdout, '', 'новых событий нет — quiet-прогон молчит');

    const seenSecond = JSON.parse(readFileSync(seenPath, 'utf8'));
    assert.deepEqual(seenSecond.ids, seenFirst.ids, 'id не задвоились');
    assert.equal(readFileSync(logPath, 'utf8'), logFirst, 'журнал не переписан повторно');
  } finally {
    ws.cleanup();
  }
});

// ===========================================================================
// TUI headless (scripts/tui-headless.mjs) — без настоящего терминала
// ===========================================================================

test('TUI headless: стартовый экран, досье и тезисы отрисовываются', () => {
  const result = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'tui-headless.mjs')], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 60_000,
    env: process.env,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /===== Стартовый экран =====/);
  assert.match(result.stdout, /===== Досье события \(Enter\) =====/);
  assert.match(result.stdout, /ТЕЗИСЫ/);
  assert.match(result.stdout, /ПРОВЕРКА/);
});


test('CLI: --category и --city фильтруют события, неизвестная тема — код 2', () => {
  const ws = makeWorkspace();
  try {
    const tech = runCli(['news', '--demo', '--json', '--category', 'tech'], { workspace: ws });
    assert.equal(tech.status, 0, tech.stderr);
    const techPayload = JSON.parse(tech.stdout);
    assert.equal(techPayload.category, 'tech');
    assert.equal(techPayload.stats.events, 0);
    assert.equal(techPayload.empty, true);

    const moscow = runCli(['news', '--demo', '--json', '--city', 'moscow'], { workspace: ws });
    assert.equal(moscow.status, 0, moscow.stderr);
    assert.equal(JSON.parse(moscow.stdout).city, 'moscow');

    const bad = runCli(['news', '--demo', '--category', 'nonsense'], { workspace: ws });
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /Неизвестная тема/);

    const badCity = runCli(['news', '--demo', '--city', 'ufa'], { workspace: ws });
    assert.equal(badCity.status, 2);
    assert.match(badCity.stderr, /Неизвестный город/);
  } finally {
    ws.cleanup();
  }
});
