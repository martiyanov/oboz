// Интеграционные тесты веб-версии: запускаем server.mjs в демо-режиме (без сети)
// и проверяем API/статику. Сетевые ленты здесь не нужны.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const PORT = 18_000 + Math.floor(Math.random() * 2000);
const BASE = `http://127.0.0.1:${PORT}`;
let child = null;
let output = '';

function waitHealth(timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = async () => {
      if (child.exitCode !== null) {
        reject(new Error(`server exited early (code ${child.exitCode}):\n${output.slice(-2000)}`));
        return;
      }
      try {
        const res = await fetch(`${BASE}/healthz`, { signal: AbortSignal.timeout(1000) });
        if (res.ok) {
          resolve();
          return;
        }
      } catch {
        /* ещё не поднялся */
      }
      if (Date.now() > deadline) {
        reject(new Error(`server did not start in ${timeoutMs}ms:\n${output.slice(-2000)}`));
        return;
      }
      setTimeout(tick, 100);
    };
    tick();
  });
}

before(async () => {
  child = spawn(process.execPath, ['web/server.mjs'], {
    cwd: ROOT,
    env: {
      ...process.env,
      OBOZ_WEB_PORT: String(PORT),
      OBOZ_WEB_NO_WARM: '1',
      OBOZ_WEB_DEMO: '1',
      OBOZ_WEB_WIKI: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk) => { output += chunk.toString(); });
  await waitHealth();
});

after(() => {
  if (child && child.exitCode === null) child.kill('SIGTERM');
});

test('web: healthz отвечает и отдаёт версию/кэш', async () => {
  const res = await fetch(`${BASE}/healthz`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.equal(typeof data.version, 'string');
  assert.equal(typeof data.uptimeSec, 'number');
  assert.ok(data.cache && typeof data.cache.entries === 'number');
});

test('web: статика index/app.js/style.css и относительные ссылки', async () => {
  const index = await fetch(`${BASE}/`);
  assert.equal(index.status, 200);
  assert.match(index.headers.get('content-type') || '', /text\/html/);
  const html = await index.text();
  assert.match(html, /ОБОЗРЕВАТЕЛЬ/i);
  assert.ok(!/src="\//.test(html), 'скрипты должны быть относительными (работа под /oboz/)');
  assert.ok(!/href="\//.test(html), 'стили должны быть относительными');
  assert.match(html, /id="theme-toggle"/, 'в шапке есть переключатель темы');
  assert.match(html, /src="theme\.js"/, 'theme.js подключается до отрисовки');
  assert.match(index.headers.get('content-security-policy') || '', /default-src 'self'/);

  for (const [file, type] of [['app.js', /javascript/], ['theme.js', /javascript/], ['style.css', /text\/css/], ['favicon.svg', /svg/]]) {
    const res = await fetch(`${BASE}/${file}`);
    assert.equal(res.status, 200, `${file} должен отдаваться`);
    assert.match(res.headers.get('content-type') || '', type);
  }
});

test('web: /api/digest в демо-режиме даёт 3 события из 7', async () => {
  const res = await fetch(`${BASE}/api/digest?region=ru`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.stats.demo, true);
  assert.equal(data.threshold, 0.55);
  assert.equal(data.stats.events, 7);
  assert.equal(data.passed.length, 3);
  assert.equal(data.empty, false);
  const [event] = data.passed;
  assert.match(event.id, /^[0-9a-f]{8}$/);
  assert.ok(event.score >= 0.55);
  assert.ok(event.articles.length >= 2);
  assert.ok(Array.isArray(event.claims));
  assert.ok(Array.isArray(event.wiki));
});

test('web: digest уважает region/threshold/limit', async () => {
  const strict = await (await fetch(`${BASE}/api/digest?region=ru&threshold=0.95`)).json();
  assert.equal(strict.empty, true);
  assert.equal(strict.passed.length, 0);
  assert.ok(strict.rejected.length > 0);

  const world = await (await fetch(`${BASE}/api/digest?region=world&threshold=0.55`)).json();
  assert.ok(world.passed.length >= 2);

  const limited = await (await fetch(`${BASE}/api/digest?region=ru&limit=6`)).json();
  assert.ok(limited.passed.length <= 6);
});

test('web: фильтры category/city и мета-каталог', async () => {
  const base = await (await fetch(`${BASE}/api/digest?region=ru`)).json();
  assert.equal(base.category, 'all');
  assert.equal(base.city, 'all');
  assert.ok(Array.isArray(base.meta.categories));
  assert.ok(base.meta.categories.some((item) => item.id === 'tech' && item.label === 'Технологии'));
  assert.ok(base.meta.categories.some((item) => item.id === 'music'));
  assert.ok(base.meta.cities.some((item) => item.id === 'moscow' && item.label === 'Москва'));
  assert.ok(base.meta.cities.some((item) => item.id === 'nizhny' && item.label === 'Нижний Новгород'));

  const tech = await (await fetch(`${BASE}/api/digest?region=ru&category=tech`)).json();
  assert.equal(tech.category, 'tech');
  for (const event of tech.passed) assert.ok(event.topics.includes('tech'));

  const city = await (await fetch(`${BASE}/api/digest?region=ru&city=moscow`)).json();
  assert.equal(city.city, 'moscow');
  for (const event of city.passed) assert.ok(event.cities.includes('moscow'));

  const bad = await (await fetch(`${BASE}/api/digest?region=ru&category=nonsense&city=ufa`)).json();
  assert.equal(bad.category, 'all');
  assert.equal(bad.city, 'all');
});

test('web: /api/event/<id> отдаёт досье, /api/sources — каталог', async () => {
  const digest = await (await fetch(`${BASE}/api/digest?region=ru`)).json();
  const id = digest.passed[0].id;
  const res = await fetch(`${BASE}/api/event/${id}`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.event.id, id);
  assert.ok(data.event.articles.length >= 2);
  assert.ok(data.event.claims.length >= 1);

  const sources = await (await fetch(`${BASE}/api/sources`)).json();
  assert.equal(sources.stats.total, 32);
  assert.equal(sources.stats.enabled, 32);
  assert.equal(sources.sources.length, 32);
  assert.ok(sources.sources.some((source) => source.city === 'moscow'));
  assert.ok(sources.sources.some((source) => source.city === 'nizhny'));
});

test('web: неизвестные пути и методы не ломают сервер', async () => {
  assert.equal((await fetch(`${BASE}/nope`)).status, 404);
  assert.equal((await fetch(`${BASE}/api/nope`)).status, 404);
  const post = await fetch(`${BASE}/api/digest`, { method: 'POST' });
  assert.equal(post.status, 405);
});
