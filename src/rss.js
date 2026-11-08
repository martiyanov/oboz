// Загрузка и разбор RSS 2.0 без сторонних библиотек, с дисковым кэшем.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { htmlToText, domainOf, hashId, normalizeWord } from './util.js';
import { RSS_CACHE_DIR } from './paths.js';

// Браузерный UA: часть сайтов (известия и др.) режет незнакомые клиенты через DDoS-Guard.
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function tagContent(block, name) {
  const re = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i');
  const m = block.match(re);
  return m ? m[1].trim() : '';
}

function stripCdata(value) {
  return String(value || '').replace(/^\s*<!\[CDATA\[/, '').replace(/\]\]>\s*$/, '').trim();
}

function parseDate(value) {
  const text = stripCdata(value);
  if (!text) return null;
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? ms : null;
}

export function parseRss(xml, source) {
  const blocks = String(xml || '').match(/<item\b[\s\S]*?<\/item>/gi) || [];
  const items = [];
  for (const block of blocks) {
    const title = htmlToText(stripCdata(tagContent(block, 'title')));
    const rawLink = stripCdata(tagContent(block, 'link'));
    const guid = stripCdata(tagContent(block, 'guid'));
    const link = (rawLink || (/^https?:/.test(guid) ? guid : '')).trim();
    if (!title) continue;
    const description = htmlToText(
      stripCdata(tagContent(block, 'description') || tagContent(block, 'content:encoded')),
    );
    const categories = [...block.matchAll(/<category(?:\s[^>]*)?>([\s\S]*?)<\/category>/gi)]
      .map((m) => htmlToText(stripCdata(m[1])))
      .filter(Boolean);
    const publishedAt =
      parseDate(tagContent(block, 'pubDate')) ||
      parseDate(tagContent(block, 'dc:date')) ||
      parseDate(tagContent(block, 'updated')) ||
      null;
    const author = htmlToText(stripCdata(tagContent(block, 'author') || tagContent(block, 'dc:creator')));

    items.push({
      id: hashId(link || `${source.id}:${title}`),
      sourceId: source.id,
      sourceName: source.name,
      domain: domainOf(link) || domainOf(source.url) || new URL(source.site || source.url).hostname,
      tier: source.tier,
      type: source.type,
      title,
      summary: description,
      link,
      publishedAt,
      categories,
      author,
      region: deriveRegion(source, categories, title),
      sourceTopics: Array.isArray(source.topics) ? source.topics : [],
      sourceCity: source.city || null,
    });
  }
  return items;
}

export function deriveRegion(source, categories, title) {
  if (source.region === 'world') return 'world';
  const hay = `${(categories || []).join(' ')} ${title || ''}`.toLowerCase();
  if (/в мире|в европе|в сша|международ|за рубежом|миров(ая|ые|ой) повестк/.test(hay)) return 'world';
  return 'ru';
}

async function readCacheFile(cachePath) {
  try {
    const [stat, content] = await Promise.all([fs.stat(cachePath), fs.readFile(cachePath, 'utf8')]);
    return { content, mtimeMs: stat.mtimeMs };
  } catch {
    return null;
  }
}

export async function fetchSource(source, opts = {}) {
  const {
    cacheTtlSec = 300,
    noCache = false,
    timeoutMs = 12_000,
    cacheDir = RSS_CACHE_DIR,
  } = opts;
  const cachePath = path.join(cacheDir, `${source.id}.xml`);
  const cached = await readCacheFile(cachePath);
  const fresh = cached && Date.now() - cached.mtimeMs < cacheTtlSec * 1000;

  if (!noCache && fresh) {
    const items = parseRss(cached.content, source);
    return { source, items, error: null, fromCache: true, stale: false };
  }

  try {
    const res = await fetch(source.url, {
      headers: { 'User-Agent': UA, Accept: 'application/rss+xml, application/xml, text/xml, */*' },
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml = await res.text();
    const items = parseRss(xml, source);
    if (!items.length) throw new Error('в ленте нет <item>');
    try {
      await fs.mkdir(cacheDir, { recursive: true });
      await fs.writeFile(cachePath, xml);
    } catch {
      /* кэш не критичен */
    }
    return { source, items, error: null, fromCache: false, stale: false };
  } catch (error) {
    if (cached) {
      const items = parseRss(cached.content, source);
      return { source, items, error: String(error.message || error), fromCache: true, stale: true };
    }
    return { source, items: [], error: String(error.message || error), fromCache: false, stale: false };
  }
}

export async function fetchAllSources(sources, opts = {}) {
  const enabled = sources.filter((s) => s.enabled !== false);
  const results = await Promise.all(enabled.map((source) => fetchSource(source, opts)));
  const articles = [];
  const stats = { total: enabled.length, ok: 0, failed: 0, cached: 0, stale: 0, failedSources: [] };
  for (const result of results) {
    if (result.items.length) {
      stats.ok += 1;
      articles.push(...result.items);
      if (result.fromCache) stats.cached += 1;
      if (result.stale) stats.stale += 1;
    } else {
      stats.failed += 1;
      stats.failedSources.push({ id: result.source.id, name: result.source.name, error: result.error });
    }
  }
  const seen = new Set();
  const unique = [];
  for (const article of articles) {
    const key = article.link || `${article.sourceId}:${normalizeWord(article.title)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(article);
  }
  stats.articles = unique.length;
  return { articles: unique, stats, results };
}
