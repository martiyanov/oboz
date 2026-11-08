// Оценка события: значимость, подтверждённость, свежесть, достоверность.
import { clamp, round } from './util.js';

const TIER_DEFAULT = { A: 1.0, B: 0.85, C: 0.6 };
const SPECIALIZED_TOPICS = new Set(['tech', 'music', 'culture', 'science', 'sport']);
const BASE_WEIGHTS = { severity: 0.4, corroboration: 0.25, recency: 0.15, confidence: 0.2 };

export function severityOf(text, config = {}) {
  const groups = config?.severity?.groups || [];
  const base = config?.severity?.base ?? 0.1;
  // Нижний регистр, ё→е, пунктуация → пробел (чтобы ключевые слова не склеивались между словами).
  const hay = String(text || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^a-zа-я0-9]+/g, ' ')
    .trim();
  let maxWeight = 0;
  let matches = 0;
  for (const group of groups) {
    let groupHit = false;
    for (const word of group.words || []) {
      const needle = String(word || '')
        .toLowerCase()
        .replace(/ё/g, 'е')
        .replace(/[^a-zа-я0-9]+/g, ' ')
        .trim();
      if (needle && hay.includes(needle)) {
        groupHit = true;
        matches += 1;
      }
    }
    if (groupHit) maxWeight = Math.max(maxWeight, group.weight || 0);
  }
  if (maxWeight === 0) return round(base * 0.5, 3);
  const bonus = 0.03 * Math.min(3, Math.max(0, matches - 1));
  return round(clamp(maxWeight + bonus), 3);
}

export function tierAverage(articles, tierWeights = TIER_DEFAULT) {
  if (!articles.length) return 0;
  const sum = articles.reduce((acc, article) => acc + (tierWeights[article.tier] ?? 0.6), 0);
  return sum / articles.length;
}

export function corroborationOf(domainsCount, tierAvg = 0.85) {
  const base =
    domainsCount >= 5 ? 1
    : domainsCount === 4 ? 0.85
    : domainsCount === 3 ? 0.7
    : domainsCount === 2 ? 0.5
    : 0.05;
  const quality = 0.7 + 0.3 * clamp(tierAvg);
  return round(clamp(base * quality), 3);
}

export function recencyOf(latestAt, now = Date.now()) {
  if (!latestAt) return 0.2;
  const hours = Math.max(0, (now - latestAt) / 3_600_000);
  return round(clamp(Math.exp(-hours / 18)), 3);
}

export function confidenceOf({
  domainsCount,
  tierAvg,
  attribution = { score: 0, official: false, speculative: [] },
  conflicts = [],
}) {
  let value = 0.2 + 0.44 * corroborationOf(domainsCount, tierAvg) + 0.22 * (attribution.score || 0) + 0.14 * clamp(tierAvg);
  if (domainsCount === 1) {
    const topTier = tierAvg >= 0.95;
    value = Math.min(value, attribution.official && topTier ? 0.6 : 0.42);
  }
  if (conflicts.length) value -= 0.18;
  value -= Math.min(0.24, (attribution.speculative?.length || 0) * 0.12);
  return round(clamp(value, 0.02, 0.98), 3);
}

export function evaluateEvent(cluster, config = {}, now = Date.now(), evidence = {}) {
  const weights = { ...BASE_WEIGHTS, ...(config.weights || {}) };
  const tierWeights = { ...TIER_DEFAULT, ...(config.tierWeights || {}) };
  const minDomains = config.minDomains ?? 2;
  const minConfidence = config.minConfidence ?? 0.5;

  let severity = severityOf(`${cluster.title} ${cluster.summary}`, config);
  // Тематические (не политические) события редко попадают в «жёсткие» новостные ключевые слова:
  // даём им базовую значимость, чтобы категории «Технологии»/«Музыка» не были пустыми.
  if ((cluster.topics || []).some((topic) => SPECIALIZED_TOPICS.has(topic))) {
    severity = Math.max(severity, config.specializedSeverityFloor ?? 0.35);
  }
  const tierAvg = tierAverage(cluster.articles, tierWeights);
  const domainsCount = cluster.domains.length;
  const corroboration = corroborationOf(domainsCount, tierAvg);
  const recency = recencyOf(cluster.latestAt, now);
  const attribution = evidence.attribution || { score: 0, official: false, markers: [], speculative: [] };
  const confidence = confidenceOf({
    domainsCount,
    tierAvg,
    attribution,
    conflicts: evidence.conflicts || [],
  });
  const total = weights.severity + weights.corroboration + weights.recency + weights.confidence;
  const score = round(
    clamp(
      (weights.severity * severity +
        weights.corroboration * corroboration +
        weights.recency * recency +
        weights.confidence * confidence) /
        (total || 1),
    ),
    3,
  );

  const checks = {
    scoreOk: score >= (config.threshold ?? 0.55),
    domainsOk: domainsCount >= minDomains,
    confidenceOk: confidence >= minConfidence,
    articlesOk: cluster.articles.length >= 2,
  };
  return {
    ...cluster,
    severity,
    corroboration,
    recency,
    confidence,
    score,
    tierAvg: round(tierAvg, 3),
    checks,
  };
}

export function gateReasons(event, config = {}) {
  const reasons = [];
  const threshold = config.threshold ?? 0.55;
  const minDomains = config.minDomains ?? 2;
  const minConfidence = config.minConfidence ?? 0.5;
  if (event.score < threshold) reasons.push(`оценка ${event.score.toFixed(2)} ниже порога ${threshold.toFixed(2)}`);
  if (event.domains.length < minDomains) {
    reasons.push(`подтверждений ${event.domains.length} — нужно минимум ${minDomains} независимых источника`);
  }
  if (event.confidence < minConfidence) {
    reasons.push(`достоверность ${event.confidence.toFixed(2)} ниже ${minConfidence.toFixed(2)}`);
  }
  return reasons;
}

export function isPassing(event, threshold) {
  const t = threshold ?? 0.55;
  return event.checks.domainsOk && event.checks.confidenceOk && event.checks.articlesOk && event.score >= t;
}

export function verdictOf(event) {
  const level = event.score >= 0.8 ? 'высокая'
    : event.score >= 0.65 ? 'заметная'
    : event.score >= 0.55 ? 'умеренная'
    : 'низкая';
  return { level };
}
