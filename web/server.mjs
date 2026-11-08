// Веб-версия «Обозревателя»: JSON API + статика поверх того же ядра, что и CLI/TUI.
// Без зависимостей: node:http, node:fs, node:zlib.
import http from 'node:http';
import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { buildDigest, enrichEvent } from '../src/digest.js';
import { loadConfig, loadSources } from '../src/config.js';
import { publicEvent } from '../src/format.js';
import { ROOT, STATE_DIR } from '../src/paths.js';
import { loadTopics, categoryList, cityList } from '../src/topics.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const HOST = process.env.OBOZ_WEB_HOST || '127.0.0.1';
const PORT = Number(process.env.OBOZ_WEB_PORT || 8788);
const CACHE_TTL_MS = Number(process.env.OBOZ_WEB_CACHE_TTL_MS || 180_000);
const MAX_CACHE_ENTRIES = 32;
const DEMO = process.env.OBOZ_WEB_DEMO === '1';
const WIKI = process.env.OBOZ_WEB_WIKI !== '0';

const REGIONS = ['ru', 'world', 'all'];
const REGION_NAMES = { ru: 'Россия', world: 'Мир', all: 'Всё' };
const MIN_THRESHOLD = 0.3;
const MAX_THRESHOLD = 0.95;
const MIN_LIMIT = 6;
const MAX_LIMIT = 30;

const FEEDBACK_FILE = path.join(STATE_DIR, 'feedback.jsonl');
const FEEDBACK_MAX_BYTES = 8 * 1024;
const FEEDBACK_MIN_ELAPSED_MS = 2500;
const FEEDBACK_PER_IP_PER_HOUR = 3;
const FEEDBACK_PER_IP_PER_DAY = 10;
const FEEDBACK_GLOBAL_PER_DAY = 200;
const feedbackSalt = crypto.randomBytes(16).toString('hex');
const feedbackAttempts = new Map(); // ipHash -> [timestamps]
let feedbackGlobalDay = []; // timestamps успешных отправок за сутки

const startedAt = Date.now();
const digestCache = new Map(); // key -> { at, value }
const inflight = new Map(); // key -> Promise
const eventCache = new Map(); // id -> { at, value }
let config = null;
let topicsCatalog = null;
let packageVersion = '0.0.0';
let stats = { builds: 0, buildMs: 0, lastBuildAt: 0, requests: 0, errors: 0 };

function log(...args) {
  process.stdout.write(`${new Date().toISOString()} ${args.join(' ')}\n`);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function roundThreshold(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  const num = Number(String(value).replace(',', '.'));
  if (!Number.isFinite(num)) return fallback;
  return Math.round(clamp(num, MIN_THRESHOLD, MAX_THRESHOLD) * 20) / 20;
}

function parseLimit(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.floor(clamp(num, MIN_LIMIT, MAX_LIMIT));
}

function parseRegion(value, fallback) {
  return REGIONS.includes(value) ? value : fallback;
}

function cacheKey(region, threshold, limit, category = 'all', city = 'all') {
  return `${region}|${threshold.toFixed(2)}|${limit}|${category}|${city}`;
}

function parseCategory(value, catalog) {
  return value && catalog.categoryIds.has(value) ? value : 'all';
}

function parseCity(value, catalog) {
  return value && catalog.cityIds.has(value) ? value : 'all';
}

function remember(cache, key, value, ttlMs) {
  cache.set(key, { at: Date.now(), value });
  if (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at)[0]?.[0];
    if (oldest !== undefined) cache.delete(oldest);
  }
  return value;
}

function digestPayload(digest) {
  return {
    category: digest.category || 'all',
    city: digest.city || 'all',
    generatedAt: digest.generatedAt,
    region: digest.region,
    threshold: digest.threshold,
    empty: digest.empty,
    stats: digest.stats,
    meta: {
      minDomains: config?.minDomains ?? 2,
      minConfidence: config?.minConfidence ?? 0.5,
      maxAgeHours: config?.maxAgeHours ?? 36,
      weights: config?.weights ?? { severity: 0.4, corroboration: 0.25, recency: 0.15, confidence: 0.2 },
      regions: REGION_NAMES,
      categories: categoryList(topicsCatalog),
      cities: cityList(topicsCatalog),
    },
    passed: digest.passed.map(publicEvent),
    rejected: digest.rejected.map((event) => ({
      id: event.id,
      title: event.title,
      score: event.score,
      reasons: event.reasons,
    })),
  };
}

async function buildAndCache(region, threshold, limit, refresh = false, category = 'all', city = 'all') {
  const key = cacheKey(region, threshold, limit, category, city);
  const cached = digestCache.get(key);
  if (!refresh && cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;

  if (inflight.has(key)) return inflight.get(key);

  const promise = (async () => {
    const t0 = Date.now();
    const digest = await buildDigest({ region, threshold, limit, wiki: false, demo: DEMO, category, city });
    const payload = digestPayload(digest);
    stats.builds += 1;
    stats.buildMs = Date.now() - t0;
    stats.lastBuildAt = Date.now();
    remember(digestCache, key, payload, CACHE_TTL_MS);
    log(`digest ${key} built in ${stats.buildMs}ms: passed=${payload.stats.passed}`);
    return payload;
  })().finally(() => inflight.delete(key));

  inflight.set(key, promise);
  return promise;
}

function serveStaleThenRebuild(region, threshold, limit, category, city) {
  const key = cacheKey(region, threshold, limit, category, city);
  const cached = digestCache.get(key);
  if (cached) {
    // Отдаём устаревший кэш мгновенно, обновление — в фоне.
    buildAndCache(region, threshold, limit, true, category, city).catch((error) => log('background rebuild failed:', error.message));
    return cached.value;
  }
  return buildAndCache(region, threshold, limit, false, category, city);
}

async function getDigest(region, threshold, limit, refresh, category = 'all', city = 'all') {
  const key = cacheKey(region, threshold, limit, category, city);
  const cached = digestCache.get(key);
  if (refresh) return buildAndCache(region, threshold, limit, true, category, city);
  if (!cached) return buildAndCache(region, threshold, limit, false, category, city);
  if (Date.now() - cached.at < CACHE_TTL_MS) return cached.value;
  return serveStaleThenRebuild(region, threshold, limit, category, city);
}

// Полный набор событий для досье любого id (включая те, что ниже порога).
async function getAllEvents() {
  const key = 'all|0.00|30|all|all';
  const cached = digestCache.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached;
  if (inflight.has(key)) return inflight.get(key);
  const promise = (async () => {
    const t0 = Date.now();
    // threshold 0 — берём все оценённые события; limit на список passed не влияет.
    const digest = await buildDigest({ region: 'all', threshold: 0, limit: 1, wiki: false, demo: DEMO });
    const entry = { at: Date.now(), value: digest };
    digestCache.set(key, entry);
    stats.builds += 1;
    stats.buildMs = Date.now() - t0;
    stats.lastBuildAt = Date.now();
    log(`digest all events built in ${stats.buildMs}ms: ${digest.events.length} events`);
    return entry;
  })().finally(() => inflight.delete(key));
  inflight.set(key, promise);
  return promise;
}

const STATIC_FILES = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8', cache: 'no-cache' },
  '/index.html': { file: 'index.html', type: 'text/html; charset=utf-8', cache: 'no-cache' },
  '/theme.js': { file: 'theme.js', type: 'text/javascript; charset=utf-8', cache: 'public, max-age=300' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8', cache: 'public, max-age=300' },
  '/style.css': { file: 'style.css', type: 'text/css; charset=utf-8', cache: 'public, max-age=300' },
  '/favicon.svg': { file: 'favicon.svg', type: 'image/svg+xml', cache: 'public, max-age=86400' },
  '/rating': { file: 'rating.html', type: 'text/html; charset=utf-8', cache: 'no-cache' },
  '/rating.html': { file: 'rating.html', type: 'text/html; charset=utf-8', cache: 'no-cache' },
  '/rating.js': { file: 'rating.js', type: 'text/javascript; charset=utf-8', cache: 'public, max-age=300' },
};

const staticCache = new Map(); // path -> Buffer

async function readStatic(filePath) {
  if (staticCache.has(filePath)) return staticCache.get(filePath);
  const buffer = await fs.readFile(filePath);
  staticCache.set(filePath, buffer);
  return buffer;
}

function gzipIfPossible(req, res, body, headers) {
  const acceptsGzip = /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''));
  if (acceptsGzip && body.length > 1024) {
    const compressed = zlib.gzipSync(body);
    res.writeHead(200, { ...headers, 'Content-Encoding': 'gzip', 'Content-Length': compressed.length });
    res.end(compressed);
    return;
  }
  res.writeHead(200, { ...headers, 'Content-Length': body.length });
  res.end(body);
}

function securityHeaders(isApi) {
  return {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Frame-Options': 'DENY',
    'Cache-Control': isApi ? 'no-store' : 'no-cache',
    'Content-Security-Policy':
      "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; " +
      "script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  };
}

const MIME_JSON = 'application/json; charset=utf-8';

function sendJson(req, res, status, payload, extraHeaders = {}) {
  const body = Buffer.from(JSON.stringify(payload));
  const headers = {
    'Content-Type': MIME_JSON,
    ...securityHeaders(true),
    ...extraHeaders,
  };
  if (status !== 200) {
    res.writeHead(status, headers);
    res.end(body);
    return;
  }
  gzipIfPossible(req, res, body, headers);
}

function sendError(req, res, status, message) {
  sendJson(req, res, status, { error: message });
}

function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return String(forwarded).split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

function hashIp(ip) {
  return crypto.createHash('sha256').update(`${feedbackSalt}:${ip}`).digest('hex').slice(0, 16);
}

function feedbackRateOk(ipHash) {
  const now = Date.now();
  const hourAgo = now - 60 * 60_000;
  const dayAgo = now - 24 * 60 * 60_000;
  const attempts = (feedbackAttempts.get(ipHash) || []).filter((ts) => ts > dayAgo);
  feedbackAttempts.set(ipHash, attempts);
  const lastHour = attempts.filter((ts) => ts > hourAgo).length;
  feedbackGlobalDay = feedbackGlobalDay.filter((ts) => ts > dayAgo);
  if (lastHour >= FEEDBACK_PER_IP_PER_HOUR) return { ok: false, reason: 'слишком много сообщений за час' };
  if (attempts.length >= FEEDBACK_PER_IP_PER_DAY) return { ok: false, reason: 'слишком много сообщений за сутки' };
  if (feedbackGlobalDay.length >= FEEDBACK_GLOBAL_PER_DAY) return { ok: false, reason: 'дневной лимит обратной связи исчерпан' };
  return { ok: true };
}

function feedbackRateNote(ipHash) {
  const now = Date.now();
  const attempts = (feedbackAttempts.get(ipHash) || []).filter((ts) => ts > now - 24 * 60 * 60_000);
  attempts.push(now);
  feedbackAttempts.set(ipHash, attempts.slice(-50));
  feedbackGlobalDay.push(now);
  feedbackGlobalDay = feedbackGlobalDay.slice(-500);
}

function readBody(req, limitBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    const fail = (status, message) => {
      if (done) return;
      done = true;
      reject(Object.assign(new Error(message), { status }));
    };
    const timer = setTimeout(() => fail(408, 'timeout'), 8000);
    timer.unref();
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        fail(413, 'payload too large');
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(Buffer.concat(chunks));
    });
    req.on('error', (error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function handleFeedback(req, res) {
  const origin = req.headers.origin;
  const host = req.headers['x-forwarded-host'] || req.headers.host || '';
  if (origin) {
    try {
      const parsed = new URL(origin);
      const allowedHosts = new Set([host, `www.${host}`]);
      if (!allowedHosts.has(parsed.host) || (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')) {
        sendError(req, res, 403, 'origin not allowed');
        return;
      }
    } catch {
      sendError(req, res, 403, 'origin not allowed');
      return;
    }
  }

  if (!String(req.headers['content-type'] || '').includes('application/json')) {
    sendError(req, res, 415, 'expected application/json');
    return;
  }

  const ipHash = hashIp(clientIp(req));
  const rate = feedbackRateOk(ipHash);
  if (!rate.ok) {
    sendError(req, res, 429, rate.reason);
    return;
  }
  // Любая попытка отправки считается в лимит, даже если потом не пройдёт валидацию.
  feedbackRateNote(ipHash);

  let payload;
  try {
    const body = await readBody(req, FEEDBACK_MAX_BYTES);
    payload = JSON.parse(body.toString('utf8') || '{}');
  } catch (error) {
    sendError(req, res, error.status || 400, 'не удалось прочитать сообщение');
    return;
  }

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    sendError(req, res, 400, 'неверный формат сообщения');
    return;
  }

  // Honeypot: скрытое поле должно остаться пустым. Ботам отвечаем как обычно,
  // но ничего не сохраняем.
  if (typeof payload.website === 'string' && payload.website.trim() !== '') {
    log('feedback: honeypot triggered, dropped');
    sendJson(req, res, 200, { ok: true });
    return;
  }

  const started = Number(payload.startedAt);
  if (!Number.isFinite(started)) {
    sendError(req, res, 400, 'форма отправлена некорректно');
    return;
  }
  const elapsed = Date.now() - started;
  if (elapsed < FEEDBACK_MIN_ELAPSED_MS) {
    sendError(req, res, 429, 'слишком быстро — попробуйте ещё раз');
    return;
  }
  if (elapsed > 2 * 60 * 60_000) {
    sendError(req, res, 400, 'форма устарела — обновите страницу');
    return;
  }

  const message = String(payload.message || '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim();
  const contact = String(payload.contact || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 200);
  if (message.length < 10) {
    sendError(req, res, 400, 'сообщение слишком короткое (минимум 10 символов)');
    return;
  }
  if (message.length > 2000) {
    sendError(req, res, 400, 'сообщение слишком длинное (максимум 2000 символов)');
    return;
  }

  const record = {
    ts: new Date().toISOString(),
    message,
    contact: contact || null,
    ipHash,
    ua: String(req.headers['user-agent'] || '').slice(0, 160),
  };
  try {
    await fs.mkdir(STATE_DIR, { recursive: true });
    await fs.appendFile(FEEDBACK_FILE, `${JSON.stringify(record)}\n`);
  } catch (error) {
    log('feedback: save failed:', error.message);
    sendError(req, res, 500, 'не удалось сохранить сообщение');
    return;
  }
  stats.feedback = (stats.feedback || 0) + 1;
  log(`feedback saved: len=${message.length} ipHash=${ipHash}`);
  sendJson(req, res, 200, { ok: true });
}

async function handleApi(req, res, url) {
  const { pathname, searchParams } = url;

  if (pathname === '/api/digest') {
    const region = parseRegion(searchParams.get('region'), config.region || 'ru');
    const threshold = roundThreshold(searchParams.get('threshold'), config.threshold ?? 0.55);
    const limit = parseLimit(searchParams.get('limit'), config.limit ?? 12);
    const refresh = searchParams.get('refresh') === '1';
    const category = parseCategory(searchParams.get('category'), topicsCatalog);
    const city = parseCity(searchParams.get('city'), topicsCatalog);
    const payload = await getDigest(region, threshold, limit, refresh, category, city);
    sendJson(req, res, 200, payload);
    return true;
  }

  if (pathname === '/api/sources') {
    const { sources, meta } = await loadSources();
    const enabled = sources.filter((source) => source.enabled !== false);
    sendJson(req, res, 200, {
      updatedAt: meta.updatedAt || null,
      stats: { total: sources.length, enabled: enabled.length },
      sources: sources.map((source) => ({
        id: source.id,
        name: source.name,
        region: source.region,
        tier: source.tier,
        type: source.type,
        topics: Array.isArray(source.topics) ? source.topics : [],
        city: source.city || null,
        enabled: source.enabled !== false,
        site: source.site || null,
      })),
    });
    return true;
  }

  if (pathname.startsWith('/api/event/')) {
    const id = decodeURIComponent(pathname.slice('/api/event/'.length)).trim();
    if (!/^[0-9a-f]{6,16}$/i.test(id)) {
      sendError(req, res, 400, 'bad event id');
      return true;
    }
    const cached = eventCache.get(id);
    if (cached && Date.now() - cached.at < 10 * 60_000) {
      sendJson(req, res, 200, { event: cached.value, cached: true });
      return true;
    }
    const entry = await getAllEvents();
    const digest = entry.value;
    const event = digest.events.find((candidate) => candidate.id === id || candidate.id.startsWith(id));
    if (!event) {
      sendError(req, res, 404, 'event not found');
      return true;
    }
    const enriched = WIKI ? await enrichEvent(event, { limit: 3 }) : event;
    const value = publicEvent(enriched);
    remember(eventCache, id, value, 10 * 60_000);
    sendJson(req, res, 200, { event: value });
    return true;
  }

  if (pathname === '/healthz') {
    sendJson(req, res, 200, {
      ok: true,
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      version: packageVersion,
      cache: { entries: digestCache.size, events: eventCache.size },
      resources: {
        rssMB: Number((process.memoryUsage().rss / 1048576).toFixed(1)),
        heapUsedMB: Number((process.memoryUsage().heapUsed / 1048576).toFixed(1)),
        caches: { digest: digestCache.size, events: eventCache.size, static: staticCache.size },
        feedbackStored: stats.feedback || 0,
      },
      stats,
    });
    return true;
  }

  return false;
}

async function handleStatic(req, res, pathname) {
  const spec = STATIC_FILES[pathname];
  if (!spec) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', ...securityHeaders(false) });
    res.end('Not Found\n');
    return;
  }
  try {
    const body = await readStatic(path.join(PUBLIC_DIR, spec.file));
    gzipIfPossible(req, res, body, {
      'Content-Type': spec.type,
      'Cache-Control': spec.cache,
      ...securityHeaders(false),
    });
  } catch (error) {
    if (error.code === 'ENOENT') {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', ...securityHeaders(false) });
      res.end('Not Found\n');
      return;
    }
    log('static read error:', error.message);
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Internal Server Error\n');
  }
}

const server = http.createServer(async (req, res) => {
  const started = process.hrtime.bigint();
  stats.requests += 1;
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch {
    sendError(req, res, 400, 'bad url');
    return;
  }

  const { pathname } = url;
  try {
    if (req.method === 'POST') {
      if (pathname === '/api/feedback') {
        await handleFeedback(req, res);
        return;
      }
      sendError(req, res, 405, 'method not allowed');
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendError(req, res, 405, 'method not allowed');
      return;
    }
    if (pathname === '/healthz' || pathname === '/api/healthz') {
      sendJson(req, res, 200, {
        ok: true,
        uptimeSec: Math.round((Date.now() - startedAt) / 1000),
        version: packageVersion,
        cache: { entries: digestCache.size, events: eventCache.size },
        resources: {
          rssMB: Number((process.memoryUsage().rss / 1048576).toFixed(1)),
          heapUsedMB: Number((process.memoryUsage().heapUsed / 1048576).toFixed(1)),
          caches: { digest: digestCache.size, events: eventCache.size, static: staticCache.size },
          feedbackStored: stats.feedback || 0,
        },
        stats,
      });
      return;
    }
    if (pathname.startsWith('/api/')) {
      const handled = await handleApi(req, res, url);
      if (!handled) sendError(req, res, 404, 'unknown api method');
      return;
    }
    await handleStatic(req, res, pathname);
  } catch (error) {
    stats.errors += 1;
    log('request error:', req.method, pathname, error.message);
    if (!res.headersSent) sendError(req, res, 500, 'internal error');
    else res.end();
  } finally {
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    if (ms > 250) log(`slow ${req.method} ${pathname} ${ms.toFixed(0)}ms`);
  }
});

async function main() {
  config = await loadConfig();
  topicsCatalog = await loadTopics();
  try {
    const pkg = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'));
    packageVersion = pkg.version || '0.0.0';
  } catch {
    /* версия не критична */
  }
  await fs.access(path.join(PUBLIC_DIR, 'index.html')).catch(() => {
    log(`ВНИМАНИЕ: нет ${PUBLIC_DIR}/index.html — статика ещё не собрана`);
  });

  const NO_WARM = process.env.OBOZ_WEB_NO_WARM === '1';
  server.listen(PORT, HOST, () => {
    log(`oboz web listening on http://${HOST}:${PORT} (version ${packageVersion})`);
    if (NO_WARM) return;
    // Прогреваем кэш, чтобы первый посетитель не ждал загрузку лент.
    getDigest('ru', config.threshold ?? 0.55, config.limit ?? 12, false, 'all', 'all')
      .catch((error) => log('warmup failed:', error.message));
  });

  if (!NO_WARM) {
    const warmTimer = setInterval(() => {
      getDigest('ru', config.threshold ?? 0.55, config.limit ?? 12, false, 'all', 'all')
        .catch((error) => log('warmup failed:', error.message));
    }, 120_000);
    warmTimer.unref();
  }

  const shutdown = (signal) => {
    log(`received ${signal}, shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((error) => {
  log('fatal:', error?.stack || error);
  process.exit(1);
});
