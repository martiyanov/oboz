// Кластеризация публикаций разных источников в одно событие + чистка дублей.
// Важно: сравнение идёт с «представителем» кластера, а не с любым его членом —
// это защищает от цепочки ложных склеек (A~B~C, где A и C — разные события).
import {
  dice, intersectionSize, titleTokens, extractEntities, hashId, canonicalDomain, countGeoHints, isGenericToken,
} from './util.js';

const TIER_RANK = { A: 0, B: 1, C: 2 };

function prepare(article, now) {
  const tokens = titleTokens(article.title);
  return {
    article,
    tokens: new Set(tokens),
    domain: canonicalDomain(article.domain || article.link),
    publishedAt: article.publishedAt || now,
  };
}

function documentFrequency(prepared) {
  const df = new Map();
  for (const entry of prepared) {
    for (const token of entry.tokens) df.set(token, (df.get(token) || 0) + 1);
  }
  return df;
}

function compare(a, b, df) {
  const shared = intersectionSize(a.tokens, b.tokens);
  if (shared === 0) return { match: false, similarity: 0 };
  const similarity = dice(a.tokens, b.tokens);
  if (similarity >= 0.66) return { match: true, similarity };
  // Общие редкие ОТЛИЧИТЕЛЬНЫЕ слова: география/«погиб»/«область» сами по себе
  // не делают события одним и тем же.
  const distinctiveRare = [...a.tokens].filter(
    (t) => b.tokens.has(t) && (df.get(t) || 1) <= 2 && !isGenericToken(t),
  );
  if (shared >= 2 && similarity >= 0.44 && distinctiveRare.length >= 1) {
    return { match: true, similarity };
  }
  // Никаких послаблений по одной общей фразе: «Роскомнадзор потребовал…» и
  // «Роскомнадзор взыскал…» — разные события. Срабатывает только сходство
  // заголовков + редкие отличительные слова.
  return { match: false, similarity };
}

function bestRepresentative(articles) {
  return [...articles].sort((a, b) => {
    const tier = (TIER_RANK[a.tier] ?? 3) - (TIER_RANK[b.tier] ?? 3);
    if (tier !== 0) return tier;
    return (b.summary || '').length + (b.title || '').length - ((a.summary || '').length + (a.title || '').length);
  })[0];
}

export function clusterArticles(articles, now = Date.now()) {
  const prepared = articles.map((article) => prepare(article, now));
  prepared.sort((a, b) => a.publishedAt - b.publishedAt);
  const df = documentFrequency(prepared);

  const groups = [];
  for (const entry of prepared) {
    let best = null;
    let bestSimilarity = 0;
    for (const group of groups) {
      const result = compare(entry, group.rep, df);
      if (result.match && result.similarity > bestSimilarity) {
        best = group;
        bestSimilarity = result.similarity;
      }
    }
    if (best) {
      best.entries.push(entry);
      const candidate = bestRepresentative(best.entries.map((e) => e.article));
      /* istanbul ignore next */
      if (candidate) best.rep = prepare(candidate, now);
    } else {
      groups.push({ rep: entry, entries: [entry] });
    }
  }

  return groups
    .map((group) => buildCluster(group.entries))
    .sort((a, b) => (b.latestAt || 0) - (a.latestAt || 0));
}

function buildCluster(entries) {
  const byDomain = new Map();
  for (const entry of entries) {
    const current = byDomain.get(entry.domain);
    if (!current) {
      byDomain.set(entry.domain, entry);
      continue;
    }
    const scoreCurrent = (current.article.summary || '').length + (current.article.title || '').length;
    const scoreNext = (entry.article.summary || '').length + (entry.article.title || '').length;
    if (scoreNext > scoreCurrent) byDomain.set(entry.domain, entry);
  }
  const articles = [...byDomain.values()].map((entry) => entry.article);
  const representative = bestRepresentative(articles);
  const headline = representative.title;
  const summary = [...articles].sort((a, b) => (b.summary || '').length - (a.summary || '').length)[0]?.summary || '';
  const publishedAt = Math.min(...articles.map((a) => a.publishedAt || Date.now()));
  const latestAt = Math.max(...articles.map((a) => a.publishedAt || 0));
  const domains = [...new Set(articles.map((a) => canonicalDomain(a.domain || a.link)))];
  const topics = [...new Set(articles.flatMap((a) => a.topics || []))];
  const sourceTopics = [...new Set(articles.flatMap((a) => a.sourceTopics || []))];
  const cities = [...new Set(articles.flatMap((a) => a.cities || []))];
  const sourceScope = new Set(articles.map((a) => (a.region === 'world' ? 'world' : 'ru')));
  const geo = countGeoHints(`${headline} ${summary}`);
  let scope;
  if (geo.russia > 0 && geo.world > 0) scope = ['ru', 'world'];
  else if (geo.russia > 0) scope = ['ru'];
  else if (geo.world > 0) scope = ['world'];
  else scope = [...sourceScope];
  const tokens = [...new Set(articles.flatMap((a) => titleTokens(a.title)))].sort();
  const id = hashId(tokens.join(' ') || headline);
  return {
    id,
    title: headline,
    summary,
    entities: extractEntities(`${headline}. ${summary}`, 6),
    scope,
    topics,
    sourceTopics,
    cities,
    articles,
    domains,
    publishedAt,
    latestAt,
    articlesCount: articles.length,
    tokens,
  };
}

export function clusterKey(cluster) {
  return cluster.tokens.join(' ');
}
