// Интеграционные тесты веб-версии: запускаем server.mjs в демо-режиме (без сети)
// и проверяем API/статику. Сетевые ленты здесь не нужны.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const PORT = 18_000 + Math.floor(Math.random() * 2000);
const BASE = `http://127.0.0.1:${PORT}`;
let child = null;
let output = '';
let stateDir = '';

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
  stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oboz-web-state-'));
  child = spawn(process.execPath, ['web/server.mjs'], {
    cwd: ROOT,
    env: {
      ...process.env,
      OBOZ_WEB_PORT: String(PORT),
      OBOZ_WEB_NO_WARM: '1',
      OBOZ_WEB_DEMO: '1',
      OBOZ_WEB_WIKI: '0',
      OBOZ_STATE_DIR: stateDir,
      OBOZ_PRIVATE_PASSWORD: 'test-password-123',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk) => { output += chunk.toString(); });
  await waitHealth();
});

after(async () => {
  if (child && child.exitCode === null) child.kill('SIGTERM');
  if (stateDir) await fs.rm(stateDir, { recursive: true, force: true });
});

async function feedbackLines() {
  try {
    const raw = await fs.readFile(path.join(stateDir, 'feedback.jsonl'), 'utf8');
    return raw.split('\n').filter(Boolean).length;
  } catch {
    return 0;
  }
}

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

test('web: фильтр q по ключевым словам (закладки)', async () => {
  const filtered = await (await fetch(`${BASE}/api/digest?region=ru&q=${encodeURIComponent('Курск')}`)).json();
  assert.deepEqual(filtered.query, ['курск']);
  assert.equal(filtered.stats.events, 1);
  assert.equal(filtered.passed.length, 1);
  assert.match(filtered.passed[0].title, /Курск/i);

  const none = await (await fetch(`${BASE}/api/digest?region=ru&q=${encodeURIComponent('музыка')}`)).json();
  assert.equal(none.empty, true);
  assert.equal(none.passed.length, 0);

  const bad = await (await fetch(`${BASE}/api/digest?region=ru&q=${encodeURIComponent('!!!')}`)).json();
  assert.deepEqual(bad.query, []);
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


test('web: страница «Как считается рейтинг» и форма обратной связи', async () => {
  const res = await fetch(`${BASE}/rating`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Как считается рейтинг новости/);
  assert.match(html, /score = 0\.40/);
  assert.match(html, /id="feedback-form"/);
  assert.match(html, /github\.com\/martiyanov\/oboz/);
  assert.equal((await fetch(`${BASE}/rating.js`)).status, 200);
  assert.equal((await fetch(`${BASE}/rating.html`)).status, 200);
});

test('web: обратная связь сохраняется, honeypot и лимиты работают', async () => {
  const message = `Тестовое сообщение ${Date.now()} про качество рейтинга.`;
  const ok = await fetch(`${BASE}/api/feedback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message,
      contact: 'tester@example.com',
      website: '',
      startedAt: Date.now() - 3000,
    }),
  });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).ok, true);
  const stored = await fs.readFile(path.join(stateDir, 'feedback.jsonl'), 'utf8');
  assert.ok(stored.includes(message));
  assert.ok(!stored.includes('tester@example.com') === false);

  const before = await feedbackLines();
  const honeypot = await fetch(`${BASE}/api/feedback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: 'Спам-сообщение от бота, должно быть отброшено.',
      website: 'https://spam.example',
      startedAt: Date.now() - 3000,
    }),
  });
  assert.equal(honeypot.status, 200);
  assert.equal(await feedbackLines(), before, 'honeypot не сохраняется');

  const short = await fetch(`${BASE}/api/feedback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'коротко', startedAt: Date.now() - 3000 }),
  });
  assert.equal(short.status, 400);

  const tooFast = await fetch(`${BASE}/api/feedback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'Слишком быстрая отправка формы ботом.', startedAt: Date.now() }),
  });
  assert.equal(tooFast.status, 429);

  const badOrigin = await fetch(`${BASE}/api/feedback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
    body: JSON.stringify({
      message: 'Сообщение с чужого origin не должно сохраняться.',
      startedAt: Date.now() - 3000,
    }),
  });
  assert.equal(badOrigin.status, 403);
});


test('web: анонимный профиль — сохранение, чтение, удаление', async () => {
  const token = crypto.randomBytes(32).toString('hex');
  const headers = { 'Content-Type': 'application/json', 'X-Oboz-Profile': token };
  const profile = {
    likes: ['event-1'],
    dislikes: ['event-2'],
    hiddenEvents: [{ id: 'event-2', title: 'Скрытая новость', at: Date.now() }],
    hiddenTopics: ['sport'],
    hiddenSources: ['rt-ru'],
    likedTopics: { tech: 3, music: 1 },
    likedSources: { tass: 2 },
    likedKeywords: { курск: 2 },
    sortMode: 'personal',
  };

  const missing = await fetch(`${BASE}/api/profile`, { headers: { 'X-Oboz-Profile': token } });
  assert.equal(missing.status, 404);

  const saved = await fetch(`${BASE}/api/profile`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, profile }),
  });
  assert.equal(saved.status, 200);

  const loaded = await fetch(`${BASE}/api/profile`, { headers: { 'X-Oboz-Profile': token } });
  assert.equal(loaded.status, 200);
  const data = await loaded.json();
  assert.deepEqual(data.profile.likes, ['event-1']);
  assert.deepEqual(data.profile.hiddenTopics, ['sport']);
  assert.deepEqual(data.profile.likedTopics, { tech: 3, music: 1 });
  assert.equal(data.profile.sortMode, 'personal');

  const invalid = await fetch(`${BASE}/api/profile`, { headers: { 'X-Oboz-Profile': 'not-a-token' } });
  assert.equal(invalid.status, 400);

  const removed = await fetch(`${BASE}/api/profile`, { method: 'DELETE', headers: { 'X-Oboz-Profile': token } });
  assert.equal(removed.status, 200);
  const afterDelete = await fetch(`${BASE}/api/profile`, { headers: { 'X-Oboz-Profile': token } });
  assert.equal(afterDelete.status, 404);
});


test('web: приватные «Мои новости» — вход, сессия, проекты, лента', async () => {
  const unauth = await fetch(`${BASE}/api/private/projects`);
  assert.equal(unauth.status, 401);

  const sessionBefore = await (await fetch(`${BASE}/api/private/session`)).json();
  assert.equal(sessionBefore.authenticated, false);

  const bad = await fetch(`${BASE}/api/private/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'wrong-password' }),
  });
  assert.equal(bad.status, 401);

  const login = await fetch(`${BASE}/api/private/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'test-password-123' }),
  });
  assert.equal(login.status, 200);
  const setCookie = login.headers.get('set-cookie') || '';
  assert.match(setCookie, /oboz_private=/);
  assert.match(setCookie, /HttpOnly/);
  const cookie = setCookie.split(';')[0];

  const session = await (await fetch(`${BASE}/api/private/session`, { headers: { Cookie: cookie } })).json();
  assert.equal(session.authenticated, true);

  const catalog = await (await fetch(`${BASE}/api/private/catalog`, { headers: { Cookie: cookie } })).json();
  assert.ok(Array.isArray(catalog.projects));
  assert.ok(catalog.categories.length > 0);
  assert.ok(catalog.sources.length > 0);

  const saved = await fetch(`${BASE}/api/private/projects`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({
      projects: [{
        id: 'my-project',
        name: 'Мой проект',
        keywords: ['новость', 'тест'],
        topics: ['tech'],
        priority: 4,
      }],
    }),
  });
  assert.equal(saved.status, 200);
  const savedData = await saved.json();
  assert.equal(savedData.projects.length, 1);
  assert.equal(savedData.projects[0].id, 'my-project');
  assert.deepEqual(savedData.projects[0].keywords, ['новость', 'тест']);

  const projects = await (await fetch(`${BASE}/api/private/projects`, { headers: { Cookie: cookie } })).json();
  assert.equal(projects.projects[0].name, 'Мой проект');

  const digest = await fetch(`${BASE}/api/private/digest?threshold=0.55`, { headers: { Cookie: cookie } });
  assert.equal(digest.status, 200);
  const digestData = await digest.json();
  assert.ok(Array.isArray(digestData.projects));
  assert.equal(typeof digestData.totalMatched, 'number');

  const logout = await fetch(`${BASE}/api/private/logout`, { method: 'POST', headers: { Cookie: cookie } });
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get('set-cookie') || '', /Max-Age=0/);
  const afterLogout = await (await fetch(`${BASE}/api/private/session`)).json();
  assert.equal(afterLogout.authenticated, false);
});
