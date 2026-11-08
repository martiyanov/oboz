// Сборка сводки: загрузка → нормализация → кластеризация → оценка → порог.
import { loadConfig, loadSources } from './config.js';
import { fetchAllSources } from './rss.js';
import { clusterArticles } from './cluster.js';
import { evaluateEvent, isPassing, gateReasons } from './score.js';
import { extractClaims, detectConflicts, attributionSignals, wikipediaFor } from './evidence.js';
import { demoArticles } from './demo.js';
import { WIKI_CACHE_DIR } from './paths.js';
import { round } from './util.js';

function cleanOverrides(overrides) {
  const out = {};
  for (const [key, value] of Object.entries(overrides || {})) {
    if (value !== undefined && value !== null) out[key] = value;
  }
  return out;
}

function notesFor(event) {
  const notes = [];
  if (event.conflicts?.length) {
    notes.push(`${event.conflicts.length} расхождени${event.conflicts.length === 1 ? 'е' : 'я'} в цифрах`);
  }
  if (event.attribution?.official) notes.push('есть официальный первоисточник');
  if (event.attribution?.speculative?.length) notes.push('осторожные формулировки в тексте');
  return notes;
}

export async function buildDigest(options = {}) {
  const now = options.now || Date.now();
  const config = await loadConfig(cleanOverrides(options.config));
  const threshold = options.threshold ?? config.threshold ?? 0.55;
  const region = options.region ?? config.region ?? 'ru';
  const limit = options.limit ?? config.limit ?? 12;

  let articles = [];
  let sourceStats = { total: 0, ok: 0, failed: 0, cached: 0, stale: 0, failedSources: [], articles: 0 };

  if (options.demo) {
    articles = demoArticles(now);
  } else {
    const { sources } = await loadSources();
    const fetched = await fetchAllSources(sources, {
      cacheTtlSec: config.cacheTtlSec,
      noCache: Boolean(options.noCache),
    });
    articles = fetched.articles;
    sourceStats = fetched.stats;
  }

  const maxAgeMs = (config.maxAgeHours ?? 36) * 3_600_000;
  const normalized = [];
  for (const article of articles) {
    if (!article.title) continue;
    const publishedAt = article.publishedAt || now;
    if (now - publishedAt > maxAgeMs) continue;
    if (publishedAt > now + 6 * 3_600_000) continue; // будущее из-за кривых часов — отбрасываем
    normalized.push({ ...article, publishedAt });
  }

  const clusters = clusterArticles(normalized);

  const evaluated = [];
  for (const cluster of clusters) {
    const evidenceLite = {
      claims: extractClaims(cluster),
      conflicts: detectConflicts(cluster),
      attribution: attributionSignals(cluster),
    };
    if (!evidenceLite.attribution) {
      evidenceLite.attribution = { official: false, markers: [], speculative: [], score: 0 };
    }
    const event = evaluateEvent(cluster, config, now, evidenceLite);
    event.claims = evidenceLite.claims;
    event.conflicts = evidenceLite.conflicts;
    event.attribution = evidenceLite.attribution;
    event.notes = notesFor(event);
    event.wiki = [];
    event.wikiLoaded = false;
    event.reasons = gateReasons({ ...event, score: event.score }, config);
    event.region = cluster.scope;
    event.passed = isPassing(event, threshold);
    evaluated.push(event);
  }

  const scoped = evaluated.filter((event) => region === 'all' || event.scope.includes(region));
  scoped.sort((a, b) => b.score - a.score || (b.latestAt || 0) - (a.latestAt || 0));

  const passed = scoped.filter((event) => event.passed);
  const covered = passed.slice(0, limit);

  if (options.wiki) {
    await Promise.all(covered.slice(0, 6).map(async (event) => {
      const refs = await wikipediaFor(event, { limit: 2, cacheDir: WIKI_CACHE_DIR });
      event.wiki = refs;
      event.wikiLoaded = true;
    }));
  }

  const relevant = passed.length;
  const stats = {
    articlesRaw: sourceStats.articles || articles.length,
    articlesUsed: normalized.length,
    clusters: clusters.length,
    events: scoped.length,
    passed: relevant,
    shown: covered.length,
    sourcesTotal: sourceStats.total,
    sourcesOk: sourceStats.ok,
    sourcesFailed: sourceStats.failed,
    sourcesCached: sourceStats.cached,
    sourcesStale: sourceStats.stale,
    failedSources: sourceStats.failedSources || [],
    demo: Boolean(options.demo),
  };

  return {
    generatedAt: now,
    region,
    threshold: round(threshold, 3),
    config,
    stats,
    passed: covered,
    events: scoped,
    rejected: scoped.filter((event) => !event.passed).slice(0, 12),
    empty: covered.length === 0,
  };
}

// Ленивая загрузка фоновой справки Википедии для экрана события.
export async function enrichEvent(event, options = {}) {
  if (event.wikiLoaded && event.wiki?.length) return event;
  const refs = await wikipediaFor(event, {
    limit: options.limit ?? 3,
    cacheDir: WIKI_CACHE_DIR,
    timeoutMs: options.timeoutMs ?? 8000,
  });
  return {
    ...event,
    wiki: refs,
    wikiLoaded: true,
    notes: refs.length
      ? [...(event.notes || []).filter((n) => !n.includes('Википедии')), `в Википедии найдено ${refs.length} справк${refs.length === 1 ? 'а' : 'и'}`]
      : event.notes,
  };
}
