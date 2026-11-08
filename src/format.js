// Текстовые форматы: сводка, пустой результат, досье события, таблица источников.
import {
  formatDateTimeRu, formatTimeRu, timeAgoRu, truncate, wrapText,
} from './util.js';

export const REGION_NAMES = { ru: 'Россия', world: 'Мир', all: 'Всё' };

export function plural(n, one, few, many) {
  const abs = Math.abs(n) % 100;
  const last = abs % 10;
  if (abs > 10 && abs < 20) return many;
  if (last === 1) return one;
  if (last >= 2 && last <= 4) return few;
  return many;
}

export function scoreLevel(score) {
  if (score >= 0.8) return 'высокая значимость';
  if (score >= 0.65) return 'заметное событие';
  if (score >= 0.55) return 'умеренное событие';
  return 'низкая значимость';
}

function sourceNames(event) {
  const names = [];
  const seen = new Set();
  for (const article of event.articles) {
    if (seen.has(article.sourceId)) continue;
    seen.add(article.sourceId);
    names.push(article.sourceName);
  }
  return names;
}

export function formatDigest(digest, options = {}) {
  const width = Math.min(options.width || 96, 110);
  const regionName = REGION_NAMES[digest.region] || digest.region;
  const filterParts = [];
  if (digest.category && digest.category !== 'all' && digest.filters?.category?.label) {
    filterParts.push(`тема: ${digest.filters.category.label}`);
  }
  if (digest.city && digest.city !== 'all' && digest.filters?.city?.label) {
    filterParts.push(`город: ${digest.filters.city.label}`);
  }
  const filterSuffix = filterParts.length ? ` · ${filterParts.join(' · ')}` : '';
  const lines = [];
  lines.push(`ОБОЗРЕВАТЕЛЬ · ${regionName.toUpperCase()}${filterSuffix} · ${formatDateTimeRu(digest.generatedAt)} · порог ${digest.threshold.toFixed(2)}`);
  const sourceLine = digest.stats.demo
    ? 'Источники: демо-набор (без сети)'
    : `Источники: ${digest.stats.sourcesOk}/${digest.stats.sourcesTotal}`;
  lines.push(
    `${sourceLine} · публикаций: ${digest.stats.articlesUsed} · ` +
    `событий: ${digest.stats.events} · прошло фильтр: ${digest.stats.passed}`,
  );
  lines.push('');

  if (!digest.passed.length) {
    lines.push(...formatEmpty(digest).split('\n'));
  } else {
    digest.passed.forEach((event, index) => {
      const names = sourceNames(event);
      lines.push(`${index + 1}. [${event.score.toFixed(2)}] ${truncate(event.title, width - 12)}`);
      const wrapped = wrapText(event.summary || '', width - 5);
      const summaries = wrapped.slice(0, 2);
      if (wrapped.length > summaries.length && summaries.length) {
        summaries[summaries.length - 1] = truncate(`${summaries[summaries.length - 1]}…`, width - 5);
      }
      for (const line of summaries) lines.push(`    ${line}`);
      lines.push(
        `    ${names.join(', ')} — ${event.domains.length} ${plural(event.domains.length, 'источник', 'источника', 'источников')}` +
        ` · ${timeAgoRu(event.latestAt)} · ${event.claims.length} ${plural(event.claims.length, 'тезис', 'тезиса', 'тезисов')}`,
      );
      if (event.wiki?.length) {
        lines.push(`    Фон: ${event.wiki.slice(0, 2).map((ref) => ref.title).join(', ')}`);
      }
      lines.push(`    ▸ oboz item ${event.id}`);
      lines.push('');
    });
    const rest = digest.stats.passed - digest.passed.length;
    if (rest > 0) lines.push(`… ещё ${rest} ${plural(rest, 'событие', 'события', 'событий')} выше порога — поднимите --limit`);
  }

  if (options.explain && digest.rejected.length) {
    lines.push('');
    lines.push('— НЕ ПРОШЛИ ФИЛЬТР (для настройки порога) —');
    for (const event of digest.rejected) {
      lines.push(`  [${event.score.toFixed(2)}] ${truncate(event.title, width - 12)}`);
      lines.push(`        ${event.reasons.join('; ')}`);
    }
  }

  lines.push('');
  lines.push('Интерактивный разбор стрелками: oboz tui   ·   JSON: oboz news --json');
  return lines.join('\n');
}

export function formatEmpty(digest) {
  const lines = [];
  lines.push('— Ничего существенного не произошло.');
  const checked = digest.stats.demo
    ? `Демо-набор: ${digest.stats.articlesUsed} публикаций, ${digest.stats.events} событий`
    : `Проверено ${digest.stats.sourcesOk} ${plural(digest.stats.sourcesOk, 'источник', 'источника', 'источников')}, ` +
      `${digest.stats.articlesUsed} ${plural(digest.stats.articlesUsed, 'публикация', 'публикации', 'публикаций')}, ` +
      `${digest.stats.events} ${plural(digest.stats.events, 'событие', 'события', 'событий')}`;
  lines.push(`${checked}. Ни одно не превысило порог ${digest.threshold.toFixed(2)}.`);
  return lines.join('\n');
}

export function formatScoreBreakdown(event, config) {
  const w = config?.weights || { severity: 0.4, corroboration: 0.25, recency: 0.15, confidence: 0.2 };
  return [
    `значимость ${event.severity.toFixed(2)} × ${w.severity} = ${(event.severity * w.severity).toFixed(2)}`,
    `подтверждения ${event.corroboration.toFixed(2)} × ${w.corroboration} = ${(event.corroboration * w.corroboration).toFixed(2)}`,
    `свежесть ${event.recency.toFixed(2)} × ${w.recency} = ${(event.recency * w.recency).toFixed(2)}`,
    `достоверность ${event.confidence.toFixed(2)} × ${w.confidence} = ${(event.confidence * w.confidence).toFixed(2)}`,
  ];
}

const KIND_LABELS = { statement: 'тезис', number: 'цифры', attribution: 'со ссылкой на источник' };

export function formatDossier(event, config) {
  const width = 92;
  const lines = [];
  const sep = '═'.repeat(width);
  lines.push(sep);
  lines.push(` ${truncate(event.title, width - 2)}`);
  lines.push(
    ` Оценка ${event.score.toFixed(2)} · подтверждено ${event.domains.length} ` +
    `${plural(event.domains.length, 'независимым источником', 'независимыми источниками', 'независимыми источниками')} · ` +
    `достоверность ${event.confidence.toFixed(2)}`,
  );
  lines.push(sep);
  lines.push('');

  lines.push('ЧТО ПРОИЗОШЛО');
  for (const line of wrapText(event.summary || event.title, width - 2)) lines.push(`  ${line}`);
  lines.push('');

  lines.push('ТЕЗИСЫ');
  event.claims.forEach((claim, index) => {
    const kind = KIND_LABELS[claim.kind] || claim.kind;
    lines.push(`  ${index + 1}. (${kind}) ${truncate(claim.text, width - 10)}`);
    const numbers = claim.numbers.map((n) => `${n.value} ${n.unit}`).join(', ');
    if (numbers) lines.push(`     цифры: ${numbers}`);
    if (claim.support?.length) lines.push(`     подтверждений: ${claim.support.length}`);
  });
  if (!event.claims.length) lines.push('  — нет выделенных тезисов');
  lines.push('');

  lines.push(`ПОДТВЕРЖДЕНИЯ (${event.articles.length})`);
  event.articles.forEach((article, index) => {
    const flags = [article.tier === 'A' ? 'высокое доверие' : article.tier === 'B' ? 'среднее доверие' : 'низкое доверие'];
    if (article.region === 'world') flags.push('зарубежный источник');
    lines.push(`  ${index + 1}. ${article.sourceName} — ${flags.join(', ')} · ${formatTimeRu(article.publishedAt)}`);
    lines.push(`     ${truncate(article.title, width - 5)}`);
    lines.push(`     ${article.link}`);
  });
  lines.push('');

  lines.push('ПРОВЕРКА');
  const official = event.attribution?.official
    ? `да — ${event.attribution.markers.slice(0, 4).join(', ')}`
    : 'нет прямой ссылки на официальный первоисточник';
  lines.push(`  · Официальный первоисточник: ${official}`);
  if (event.conflicts?.length) {
    for (const conflict of event.conflicts) {
      lines.push(`  · Расхождение: ${conflict.label} — ${conflict.note}`);
    }
  } else {
    lines.push('  · Расхождений в цифрах между источниками не найдено');
  }
  if (event.attribution?.speculative?.length) {
    lines.push(`  · Осторожно, формулировки: ${event.attribution.speculative.join(', ')}`);
  }
  for (const note of event.notes || []) {
    if (/официальн|расхожден|формулировк/i.test(note)) continue; // уже показано выше
    lines.push(`  · ${note}`);
  }
  lines.push('');
  for (const line of formatScoreBreakdown(event, config)) lines.push(`  ${line}`);
  lines.push('');

  if (event.wiki?.length) {
    lines.push('ФОН: ВИКИПЕДИЯ');
    for (const ref of event.wiki) {
      lines.push(`  · ${ref.title} — ${ref.url}`);
      for (const line of wrapText(ref.extract || '', width - 6).slice(0, 3)) lines.push(`      ${line}`);
    }
    lines.push('');
  }

  lines.push('Разбор построчно: oboz tui → Enter на событии.');
  return lines.join('\n');
}

export function formatSourcesTable(sources, checks = null) {
  const lines = [];
  lines.push('ИСТОЧНИКИ');
  lines.push('');
  const rows = sources.map((source) => {
    const check = checks?.[source.id];
    const status = !source.enabled ? 'выкл'
      : !check ? '—'
      : check.ok ? `${check.items} нов.` : `ошибка: ${check.error}`;
    return {
      id: source.id,
      name: truncate(source.name, 28),
      region: source.region,
      tier: source.tier,
      type: source.type,
      status,
    };
  });
  const widths = { id: 16, name: 30, region: 7, tier: 4, type: 17, status: 24 };
  const header = ['ID'.padEnd(widths.id), 'НАЗВАНИЕ'.padEnd(widths.name), 'РЕГИОН'.padEnd(widths.region),
    'ТИР'.padEnd(widths.tier), 'ТИП'.padEnd(widths.type), 'СТАТУС'];
  lines.push(header.join(' '));
  lines.push('-'.repeat(110));
  for (const row of rows) {
    lines.push([
      row.id.padEnd(widths.id),
      row.name.padEnd(widths.name),
      row.region.padEnd(widths.region),
      row.tier.padEnd(widths.tier),
      row.type.padEnd(widths.type),
      row.status,
    ].join(' '));
  }
  return lines.join('\n');
}

export function publicEvent(event) {
  return {
    id: event.id,
    title: event.title,
    summary: event.summary,
    scope: event.scope,
    topics: event.topics || [],
    cities: event.cities || [],
    score: event.score,
    severity: event.severity,
    corroboration: event.corroboration,
    confidence: event.confidence,
    recency: event.recency,
    domains: event.domains,
    publishedAt: event.publishedAt,
    latestAt: event.latestAt,
    reasons: event.reasons,
    attribution: event.attribution,
    conflicts: event.conflicts,
    claims: event.claims,
    wiki: event.wiki,
    articles: event.articles.map((a) => ({
      sourceId: a.sourceId,
      sourceName: a.sourceName,
      tier: a.tier,
      type: a.type,
      title: a.title,
      link: a.link,
      publishedAt: a.publishedAt,
      excerpt: a.excerpt || a.summary || '',
    })),
  };
}
