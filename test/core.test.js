// Юнит-тесты ядра «Обозревателя»: util, cluster, score, digest, rss.
// Полностью офлайн: только локальные данные и фиксированный now, без сети и живых лент.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  stemRu, titleTokens, dice, truncate, wrapText, parseDuration, canonicalDomain,
  extractEntities, formatTimeRu, htmlToText, hashId,
} from '../src/util.js';
import { clusterArticles } from '../src/cluster.js';
import {
  severityOf, corroborationOf, confidenceOf, recencyOf, tierAverage,
  evaluateEvent, gateReasons, isPassing,
} from '../src/score.js';
import { buildDigest } from '../src/digest.js';
import { publicEvent } from '../src/format.js';
import { parseRss, fetchSource, fetchAllSources, deriveRegion } from '../src/rss.js';
import { DEFAULT_CONFIG } from '../src/config.js';

// Фиксированное «сейчас»: 8 ноября 2026, 12:00 MSK. Демо-набор считается от него,
// поэтому оценки и порядок событий детерминированы.
const NOW = Date.parse('2026-11-08T09:00:00Z');
const MIN = 60_000;

// --- Фикстуры --------------------------------------------------------------

function article(overrides = {}) {
  const domain = overrides.domain || 'interfax.ru';
  return {
    sourceId: overrides.sourceId || domain,
    sourceName: overrides.sourceName || domain,
    domain,
    link: overrides.link || `https://${domain}/news/1`,
    tier: overrides.tier || 'A',
    type: overrides.type || 'state-agency',
    title: overrides.title || 'Мужчина погиб при атаке БПЛА в Курской области',
    summary: overrides.summary || '',
    region: overrides.region || 'ru',
    publishedAt: overrides.publishedAt
      ?? (overrides.minutes != null ? NOW - overrides.minutes * MIN : NOW - 30 * MIN),
  };
}

function makeCluster({ count = 2, tier = 'A', title, summary = '', latestAt = NOW - 30 * MIN } = {}) {
  const pool = ['interfax.ru', 'tass.ru', 'rbc.ru', 'bbc.co.uk', 'lenta.ru'];
  const articles = pool.slice(0, count).map((domain, index) => article({
    domain,
    tier: Array.isArray(tier) ? tier[index] : tier,
    title: title || 'Мужчина погиб при атаке БПЛА в Курской области',
    summary,
    publishedAt: latestAt,
    link: `https://${domain}/news/${index}`,
  }));
  return {
    id: 'test-event',
    title: articles[0].title,
    summary,
    scope: ['ru'],
    articles,
    domains: articles.map((item) => item.domain),
    publishedAt: latestAt,
    latestAt,
    tokens: [],
  };
}

// ===========================================================================
// util
// ===========================================================================

test('util.stemRu: словоформы русского слова сводятся к одному стему', () => {
  assert.equal(stemRu('погибшего'), stemRu('погиб'));
  assert.equal(stemRu('атаке'), stemRu('атака'));
  assert.equal(stemRu('Курской'), 'курск');
  assert.equal(stemRu('дом'), 'дом', 'короткие слова не режем');
  assert.equal(stemRu(''), '');
  assert.equal(stemRu('ёлка'), stemRu('елка'), 'ё и е — одна буква');
});

test('util.titleTokens: стоп-слова отброшены, значимые слова — со стеммингом', () => {
  const tokens = titleTokens('Мужчина погиб при атаке БПЛА в Курской области');
  assert.ok(tokens.includes('погиб'));
  assert.ok(tokens.includes('атак'));
  assert.ok(tokens.includes('бпла'));
  assert.ok(tokens.includes('курск'));
  for (const stop of ['при', 'в', 'и', 'на']) assert.ok(!tokens.includes(stop), `стоп-слово ${stop} не должно попадать в токены`);
  assert.ok(titleTokens('Малкин набрал 1421 очко').includes('1421'), 'числа сохраняются');
  assert.deepEqual(titleTokens(''), []);
});

test('util.dice: коэффициент Дайса для множеств токенов', () => {
  assert.equal(dice(new Set(['a', 'b']), new Set(['a', 'b'])), 1);
  assert.equal(dice(new Set(['a', 'b']), new Set(['c', 'd'])), 0);
  assert.equal(dice(new Set(['a', 'b']), new Set(['a', 'b', 'c', 'd'])), 4 / 6);
  assert.equal(dice(new Set(), new Set(['a'])), 0);
});

test('util.truncate: обрезка по ширине с многоточием', () => {
  assert.equal(truncate('abc', 5), 'abc');
  assert.equal(truncate('abcdefgh', 5), 'abcd…');
  assert.equal([...truncate('abcdefgh', 5)].length, 5);
  assert.equal(truncate('abcdef', 1), 'a');
  assert.equal(truncate('', 3), '');
});

test('util.wrapText: перенос слов по ширине и разбиение длинного слова', () => {
  assert.deepEqual(wrapText('один два три четыре пять', 7), ['один', 'два три', 'четыре', 'пять']);
  assert.deepEqual(wrapText('aaaaaaaaaa', 4), ['aaaa', 'aaaa', 'aa']);
  assert.deepEqual(wrapText('', 10), ['']);
  for (const line of wrapText('Проверка переноса длинной строки', 6)) {
    assert.ok([...line].length <= 6);
  }
});

test('util.parseDuration: периоды watch (s/m/h/d, запятая, дефолт в минутах)', () => {
  assert.equal(parseDuration('30s'), 30_000);
  assert.equal(parseDuration('15m'), 900_000);
  assert.equal(parseDuration('1h'), 3_600_000);
  assert.equal(parseDuration('2d'), 172_800_000);
  assert.equal(parseDuration('60'), 3_600_000, 'без единицы — минуты');
  assert.equal(parseDuration('1,5h'), 5_400_000);
  assert.equal(parseDuration('1ч'), 3_600_000);
  assert.equal(parseDuration('1день'), 86_400_000);
  assert.equal(parseDuration('0s'), 1000, 'минимум 1 секунда');
  assert.equal(parseDuration('abc'), null);
  assert.equal(parseDuration(''), null);
});

test('util.canonicalDomain: зеркала и поддомены редакции считаются одним источником', () => {
  assert.equal(canonicalDomain('m.lenta.ru'), 'lenta.ru');
  assert.equal(canonicalDomain('lenta.ru'), 'lenta.ru');
  assert.equal(canonicalDomain('feeds.bbci.co.uk'), 'bbc.co.uk');
  assert.equal(canonicalDomain('bbc.com'), 'bbc.co.uk');
  assert.equal(canonicalDomain('www.rbc.ru'), 'rbc.ru');
  assert.equal(canonicalDomain('https://m.interfax.ru/russia/1'), 'interfax.ru');
  assert.equal(canonicalDomain('sub.example.com'), 'example.com');
  assert.equal(canonicalDomain('x.co.uk'), 'x.co.uk');
});

test('util.extractEntities: имена и топонимы из текста, с дедупом и лимитом', () => {
  const entities = extractEntities('Мужчина погиб после атаки дрона в Поныровском районе Курской области, сообщил губернатор Александр Хинштейн.');
  assert.ok(entities.includes('Александр Хинштейн'));
  assert.ok(entities.includes('Курской'));
  assert.equal(new Set(entities.map((e) => e.toLowerCase())).size, entities.length, 'без дублей');
  assert.ok(extractEntities('Пётр Петров и Иван Сидоров', 2).length <= 2);
});

test('util.formatTimeRu: сегодня — часы:минуты, раньше — дата, пусто — прочерк', () => {
  assert.equal(formatTimeRu(0), '—');
  assert.equal(formatTimeRu(undefined), '—');
  const now = Date.now();
  const today = new Date(now);
  const p = (n) => String(n).padStart(2, '0');
  assert.equal(formatTimeRu(now), `${p(today.getHours())}:${p(today.getMinutes())}`);
  const old = new Date(Date.UTC(2020, 0, 15, 10, 30));
  const expected = `${p(old.getDate())}.${p(old.getMonth() + 1)} ${p(old.getHours())}:${p(old.getMinutes())}`;
  assert.equal(formatTimeRu(old.getTime()), expected);
});

test('util.htmlToText: теги, сущности и CDATA превращаются в чистый текст', () => {
  assert.equal(htmlToText('<p>Привет&nbsp;мир &laquo;цитата&raquo;</p>'), 'Привет мир "цитата"');
  assert.equal(htmlToText('a &amp; b &lt;3'), 'a & b <3');
  assert.equal(htmlToText('&lt;p&gt;Двойное экранирование тегов&lt;/p&gt;'), 'Двойное экранирование тегов');
  assert.equal(htmlToText('<![CDATA[Текст <b>жирный</b> &mdash; тире]]>'), 'Текст жирный — тире');
  assert.equal(htmlToText('<br/>перенос   лишние   пробелы'), 'перенос лишние пробелы');
});

// ===========================================================================
// cluster
// ===========================================================================

test('cluster: одно событие из трёх перефразированных заголовков с трёх доменов', () => {
  const clusters = clusterArticles([
    article({ domain: 'interfax.ru', title: 'Мужчина погиб при атаке БПЛА в Курской области', minutes: 42 }),
    article({ domain: 'tass.ru', title: 'В Курской области мужчина погиб при атаке БПЛА', minutes: 38 }),
    article({ domain: 'rbc.ru', tier: 'B', title: 'При атаке дрона в Курской области погиб мужчина', minutes: 35 }),
  ], NOW);
  assert.equal(clusters.length, 1, 'три перефраза — одно событие');
  const [cluster] = clusters;
  assert.equal(cluster.articles.length, 3);
  assert.deepEqual([...cluster.domains].sort(), ['interfax.ru', 'rbc.ru', 'tass.ru']);
  assert.equal(cluster.id.length, 8);
  assert.ok(cluster.title.includes('БПЛА'));
});

test('cluster: стабильный id при другом порядке входных публикаций', () => {
  const fixtures = [
    article({ domain: 'interfax.ru', title: 'Мужчина погиб при атаке БПЛА в Курской области', minutes: 42 }),
    article({ domain: 'tass.ru', title: 'В Курской области мужчина погиб при атаке БПЛА', minutes: 38 }),
    article({ domain: 'rbc.ru', tier: 'B', title: 'При атаке дрона в Курской области погиб мужчина', minutes: 35 }),
  ];
  const forward = clusterArticles(fixtures, NOW);
  const backward = clusterArticles([...fixtures].reverse(), NOW);
  assert.equal(forward.length, 1);
  assert.equal(backward.length, 1);
  assert.equal(forward[0].id, backward[0].id, 'id не зависит от порядка лент');
});

test('cluster: разные события не склеиваются', () => {
  const clusters = clusterArticles([
    article({ domain: 'bbc.co.uk', region: 'world', title: 'Стрельба в Кракове: погибли шесть человек', summary: 'На центральной площади Кракова неизвестный открыл огонь по людям.' }),
    article({ domain: 'rbc.ru', title: 'Малкин вошел в топ-20 лучших бомбардиров в истории НХЛ', summary: 'Форвард Питтсбурга набрал 1421 очко.' }),
    article({ domain: 'theguardian.com', region: 'world', title: 'Землетрясение в Турции унесло жизни 12 человек', summary: 'Толчки магнитудой 6,2 произошли на востоке страны.' }),
  ], NOW);
  assert.equal(clusters.length, 3, 'три независимых события — три кластера');
  for (const cluster of clusters) assert.equal(cluster.articles.length, 1);
});

// Регрессия BUG-1: раньше общая «географическая» биграмма склеивала разные события.
// На кэше живых лент до фикса 14 из 70 прошедших событий содержали слабосвязанную публикацию.
test('регрессия BUG-1: разные события одного региона не склеиваются', () => {
  const clusters = clusterArticles([
    article({ domain: 'interfax.ru', title: 'В Курской области задержали подозреваемого в краже' }),
    article({ domain: 'tass.ru', title: 'В Курской области открыли новый мост через реку Сейм' }),
  ], NOW);
  assert.equal(clusters.length, 2, 'кража и открытие моста — разные события');
});

// Остаток BUG-1: гео/служебные токены больше не склеивают события, но общая
// «отличительная» пара «субъект + глагол» всё ещё может дать ложную склейку.
test('BUG-1b: общая пара «субъект + глагол» не должна склеивать разные события', () => {
  const clusters = clusterArticles([
    article({ domain: 'meduza.io', title: 'Роскомнадзор потребовал заблокировать «Дождь» в ютубе' }),
    article({ domain: 'iz.ru', title: 'Роскомнадзор потребовал взыскать штраф с блогера' }),
  ], NOW);
  assert.equal(clusters.length, 2, 'блокировка сервиса и штраф блогеру — разные события');
});

test('cluster: дубли одной редакции (lenta.ru / m.lenta.ru) — один источник', () => {
  const clusters = clusterArticles([
    article({ domain: 'lenta.ru', title: 'Мужчина погиб при атаке БПЛА в Курской области', summary: 'коротко', minutes: 42 }),
    article({ domain: 'm.lenta.ru', title: 'Мужчина погиб при атаке БПЛА в Курской области, подробности', summary: 'длинное описание произошедшего', minutes: 38 }),
    article({ domain: 'tass.ru', title: 'В Курской области мужчина погиб при атаке БПЛА', minutes: 35 }),
  ], NOW);
  assert.equal(clusters.length, 1);
  const [cluster] = clusters;
  assert.equal(cluster.articles.length, 2, 'дубль зеркала не считается отдельным подтверждением');
  assert.deepEqual([...cluster.domains].sort(), ['lenta.ru', 'tass.ru']);
  assert.ok(!cluster.domains.includes('m.lenta.ru'));
});

test('cluster: scope ru/world определяется по географии заголовка и лида', () => {
  const [ru] = clusterArticles([
    article({ title: 'Мужчина погиб при атаке БПЛА в Курской области', summary: 'Мужчина погиб после атаки дрона в Поныровском районе Курской области.' }),
  ], NOW);
  assert.deepEqual(ru.scope, ['ru']);

  const [world] = clusterArticles([
    article({ domain: 'bbc.co.uk', region: 'world', title: 'Стрельба в Кракове: погибли шесть человек', summary: 'На центральной площади Кракова неизвестный открыл огонь по людям.' }),
  ], NOW);
  assert.deepEqual(world.scope, ['world']);

  const [mixed] = clusterArticles([
    article({ title: 'Мужчина погиб при атаке БПЛА в Курской области', summary: 'Украинский беспилотник атаковал трактор в Поныровском районе.' }),
  ], NOW);
  assert.ok(mixed.scope.includes('ru') && mixed.scope.includes('world'), 'смешанная география даёт оба региона');
});

// ===========================================================================
// score
// ===========================================================================

test('score.severityOf: погибшие, БПЛА и санкции дают высокую значимость', () => {
  assert.equal(severityOf('Мужчина погиб', DEFAULT_CONFIG), 0.95);
  assert.equal(severityOf('Атака БПЛА', DEFAULT_CONFIG), 1);
  assert.equal(severityOf('ЕС ввёл новые санкции', DEFAULT_CONFIG), 0.85);
  assert.equal(severityOf('Погода в Москве', DEFAULT_CONFIG), 0.075);
  assert.equal(severityOf('При атаке БПЛА погиб мужчина', DEFAULT_CONFIG), 1, 'бонус за несколько слов зажат в 1');
});

test('score.corroborationOf: растёт с числом независимых доменов, учитывает тир', () => {
  const values = [1, 2, 3, 4, 5].map((count) => corroborationOf(count, 1));
  assert.deepEqual(values, [0.05, 0.5, 0.7, 0.85, 1]);
  for (let i = 1; i < values.length; i += 1) assert.ok(values[i] > values[i - 1]);
  assert.ok(corroborationOf(2, 0.6) < corroborationOf(2, 1), 'низкий тир снижает подтверждённость');
});

test('score.confidenceOf: падает при расхождениях и спекулятивных формулировках', () => {
  const base = confidenceOf({
    domainsCount: 3, tierAvg: 1,
    attribution: { score: 0.5, official: true, speculative: [] },
    conflicts: [],
  });
  const withConflict = confidenceOf({
    domainsCount: 3, tierAvg: 1,
    attribution: { score: 0.5, official: true, speculative: [] },
    conflicts: [{ kind: 'numbers' }],
  });
  const withSpeculation = confidenceOf({
    domainsCount: 3, tierAvg: 1,
    attribution: { score: 0.5, official: true, speculative: ['якобы', 'по слухам'] },
    conflicts: [],
  });
  assert.ok(withConflict < base, 'конфликт снижает достоверность');
  assert.ok(withSpeculation < base, 'спекулятивность снижает достоверность');
  assert.ok(base - withConflict > 0.1);
});

test('score.confidenceOf: один источник не может дать высокую достоверность', () => {
  const withoutOfficial = confidenceOf({ domainsCount: 1, tierAvg: 1, attribution: { score: 0, official: false, speculative: [] }, conflicts: [] });
  const withOfficial = confidenceOf({ domainsCount: 1, tierAvg: 1, attribution: { score: 0.5, official: true, speculative: [] }, conflicts: [] });
  assert.ok(withoutOfficial <= 0.42);
  assert.ok(withOfficial <= 0.6);
  assert.ok(withOfficial > withoutOfficial);
});

test('score.recencyOf: свежесть затухает экспоненциально', () => {
  assert.equal(recencyOf(NOW, NOW), 1);
  assert.equal(recencyOf(NOW - 18 * 3_600_000, NOW), 0.368);
  assert.equal(recencyOf(NOW - 36 * 3_600_000, NOW), 0.135);
  assert.equal(recencyOf(0, NOW), 0.2);
  assert.ok(recencyOf(NOW - 30 * MIN, NOW) > recencyOf(NOW - 10 * 3_600_000, NOW));
});

test('score.tierAverage: средний вес тира статей', () => {
  assert.equal(tierAverage([], DEFAULT_CONFIG.tierWeights), 0);
  assert.equal(tierAverage([{ tier: 'A' }, { tier: 'C' }], DEFAULT_CONFIG.tierWeights), 0.8);
  assert.equal(tierAverage([{ tier: 'A' }, { tier: 'A' }], DEFAULT_CONFIG.tierWeights), 1);
});

test('score.evaluateEvent: gate — 1 источник не проходит, 2 A-источника проходят', () => {
  const official = { score: 0.5, official: true, markers: ['губернатор'], speculative: [] };

  const single = evaluateEvent(makeCluster({ count: 1 }), DEFAULT_CONFIG, NOW, { attribution: official, conflicts: [] });
  assert.equal(isPassing(single, 0.55), false, 'одного источника недостаточно даже при официальном первоисточнике');
  assert.equal(single.checks.domainsOk, false);
  assert.equal(single.checks.articlesOk, false);
  const singleReasons = gateReasons(single, DEFAULT_CONFIG);
  assert.ok(singleReasons.some((reason) => reason.includes('нужно минимум 2')), 'причина отказа про minDomains');

  const pair = evaluateEvent(makeCluster({ count: 2 }), DEFAULT_CONFIG, NOW, { attribution: official, conflicts: [] });
  assert.deepEqual(pair.checks, { scoreOk: true, domainsOk: true, confidenceOk: true, articlesOk: true });
  assert.ok(pair.score >= 0.8);
  assert.equal(isPassing(pair, 0.55), true);
  assert.equal(isPassing(pair, 0.9), false, 'при пороге 0.9 того же события мало');
});

test('score: значимость влияет на итоговую оценку', () => {
  const loud = evaluateEvent(makeCluster({ count: 2 }), DEFAULT_CONFIG, NOW, {});
  const quiet = evaluateEvent(
    makeCluster({ count: 2, title: 'Фасады Петербурга украсят световые проекции ко Дню градостроительства' }),
    DEFAULT_CONFIG,
    NOW,
    {},
  );
  assert.ok(loud.score > quiet.score);
  assert.ok(loud.severity > quiet.severity);
});

test('score.gateReasons: причина ссылается на фактический порог', () => {
  const event = evaluateEvent(makeCluster({ count: 2 }), DEFAULT_CONFIG, NOW, {});
  const strict = { ...DEFAULT_CONFIG, threshold: 0.9 };
  const reasons = gateReasons(event, strict);
  assert.ok(reasons.some((reason) => reason.includes('ниже порога 0.90')), `получили: ${reasons.join('; ')}`);
});

// ===========================================================================
// digest (demo, фиксированный now)
// ===========================================================================

test('digest demo: при пороге 0.55 проходят 3 события из 7, при 0.95 — пусто', async () => {
  const digest = await buildDigest({ demo: true, now: NOW, wiki: false });
  assert.equal(digest.threshold, 0.55);
  assert.equal(digest.stats.demo, true);
  assert.equal(digest.stats.articlesUsed, 14);
  assert.equal(digest.stats.clusters, 8);
  assert.equal(digest.stats.events, 7);
  assert.equal(digest.stats.passed, 3);
  assert.equal(digest.passed.length, 3);
  assert.equal(digest.rejected.length, 4);
  assert.equal(digest.empty, false);
  for (const event of digest.passed) {
    assert.equal(event.passed, true);
    assert.ok(event.score >= 0.55);
    assert.ok(event.domains.length >= 2);
    assert.ok(event.confidence >= 0.5);
    assert.ok(Array.isArray(event.claims));
    assert.ok(Array.isArray(event.reasons));
    assert.ok(['ru', 'world'].some((region) => event.scope.includes(region)));
  }

  const strict = await buildDigest({ demo: true, now: NOW, threshold: 0.95, wiki: false });
  assert.equal(strict.passed.length, 0);
  assert.equal(strict.empty, true);
  assert.equal(strict.rejected.length, 7, 'все 7 событий региона отсеяны');
});

test('digest demo: region ru и world дают разные наборы событий', async () => {
  const ru = await buildDigest({ demo: true, now: NOW, region: 'ru', wiki: false });
  const world = await buildDigest({ demo: true, now: NOW, region: 'world', wiki: false });
  assert.equal(ru.region, 'ru');
  assert.equal(world.region, 'world');
  assert.equal(ru.passed.length, 3);
  assert.equal(world.passed.length, 3);

  const ruTitles = ru.passed.map((event) => event.title).join(' | ');
  const worldTitles = world.passed.map((event) => event.title).join(' | ');
  assert.match(worldTitles, /Краков/, 'стрельба в Кракове — мировая повестка');
  assert.doesNotMatch(ruTitles, /Краков/, 'в российскую сводку Краков не попадает');
  for (const event of world.passed) assert.ok(event.scope.includes('world'));
  for (const event of ru.passed) assert.ok(event.scope.includes('ru'));

  const union = new Set([...ru.passed, ...world.passed].map((event) => event.id));
  assert.equal(union.size, 4, 'часть событий относится к обеим повесткам');
});

test('digest: publicEvent JSON-сериализуем и не теряет ссылки/тезисы', async () => {
  const digest = await buildDigest({ demo: true, now: NOW, wiki: false });
  const payload = publicEvent(digest.passed[0]);
  const text = JSON.stringify(payload);
  assert.ok(text.length > 0);
  const parsed = JSON.parse(text);
  assert.deepEqual(JSON.parse(JSON.stringify(parsed)), parsed);
  assert.equal(parsed.id, digest.passed[0].id);
  assert.ok(Array.isArray(parsed.articles));
  assert.ok(parsed.articles.length >= 2);
  for (const article of parsed.articles) {
    assert.equal(typeof article.link, 'string');
    assert.match(article.link, /^https:\/\//);
  }
  assert.ok(Array.isArray(parsed.claims));
  assert.ok(parsed.claims.length >= 1);
  assert.equal(typeof parsed.score, 'number');
  assert.doesNotThrow(() => JSON.stringify({ passed: digest.passed.map(publicEvent) }));
});

test('digest: id событий стабильны между прогонами с разным now', async () => {
  const first = await buildDigest({ demo: true, now: NOW, wiki: false });
  const second = await buildDigest({ demo: true, now: NOW + 3_600_000, wiki: false });
  const firstIds = first.events.map((event) => event.id).sort();
  const secondIds = second.events.map((event) => event.id).sort();
  assert.deepEqual(firstIds, secondIds);
  for (const id of firstIds) assert.match(id, /^[0-9a-f]{8}$/);
});

// Регрессия BUG-3: раньше причины считались по порогу из config.json (0.55),
// поэтому при --threshold 0.9 отклонённые события получали пустые reasons.
test('регрессия BUG-3: причины отказа учитывают фактический порог', async () => {
  const digest = await buildDigest({ demo: true, now: NOW, threshold: 0.9, wiki: false });
  assert.equal(digest.rejected.length, 7);
  for (const event of digest.rejected) assert.ok(event.reasons.length > 0, `нет причины у «${event.title}»`);
});

// ===========================================================================
// rss (офлайн: парсинг фикстуры и деградация без сети)
// ===========================================================================

const RSS_FIXTURE = `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0"><channel><title>Тестовая лента</title>
  <item>
    <title><![CDATA[Мужчина погиб при атаке БПЛА в Курской области]]></title>
    <link>https://www.interfax.ru/russia/1127652</link>
    <description><![CDATA[<p>Мужчина погиб после атаки дрона &laquo;Ланцет&raquo; &amp; ещё детали</p>]]></description>
    <category>Происшествия</category>
    <pubDate>Sat, 08 Nov 2026 09:00:00 +0300</pubDate>
  </item>
  <item>
    <title>Второй заголовок</title>
    <link>https://tass.ru/proisshestviya/1</link>
    <pubDate>Sat, 08 Nov 2026 08:00:00 +0300</pubDate>
  </item>
</channel></rss>`;

test('rss.parseRss: заголовки, ссылки, даты, HTML и домены', () => {
  const source = {
    id: 'interfax', name: 'Интерфакс', url: 'https://www.interfax.ru/rss.asp',
    site: 'https://www.interfax.ru', lang: 'ru', region: 'ru', tier: 'A', type: 'state-agency',
  };
  const items = parseRss(RSS_FIXTURE, source);
  assert.equal(items.length, 2);
  const [first] = items;
  assert.equal(first.title, 'Мужчина погиб при атаке БПЛА в Курской области');
  assert.equal(first.link, 'https://www.interfax.ru/russia/1127652');
  assert.equal(first.domain, 'interfax.ru');
  assert.equal(first.summary, 'Мужчина погиб после атаки дрона "Ланцет" & ещё детали');
  assert.equal(first.publishedAt, Date.parse('2026-11-08T09:00:00+0300'));
  assert.deepEqual(first.categories, ['Происшествия']);
  assert.equal(first.region, 'ru');
  assert.equal(first.tier, 'A');
  assert.equal(first.id.length, 8);
  assert.equal(items[1].domain, 'tass.ru');
});

test('rss.deriveRegion: world-лента и рубрики «в мире»', () => {
  assert.equal(deriveRegion({ region: 'world' }, [], 'Любой заголовок'), 'world');
  assert.equal(deriveRegion({ region: 'ru' }, ['В мире'], 'Заголовок'), 'world');
  assert.equal(deriveRegion({ region: 'ru' }, ['В России'], 'Заголовок'), 'ru');
});

test('rss.fetchSource: сеть недоступна — не бросает, отдаёт пусто и ошибку', async () => {
  const cacheDir = mkdtempSync(path.join(tmpdir(), 'oboz-rss-'));
  try {
    const source = {
      id: 'offline', name: 'Офлайн', url: 'http://127.0.0.1:1/rss.xml',
      site: 'http://127.0.0.1:1', lang: 'ru', region: 'ru', tier: 'C', type: 'independent',
    };
    const result = await fetchSource(source, { cacheDir, noCache: true, timeoutMs: 1500 });
    assert.deepEqual(result.items, []);
    assert.equal(result.fromCache, false);
    assert.ok(result.error, 'ошибка должна быть описана, а не выброшена');
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test('rss.fetchSource: при ошибке сети отдаёт устаревший кэш', async () => {
  const cacheDir = mkdtempSync(path.join(tmpdir(), 'oboz-rss-cache-'));
  try {
    const source = {
      id: 'cached', name: 'Кэш', url: 'http://127.0.0.1:1/rss.xml',
      site: 'http://127.0.0.1:1', lang: 'ru', region: 'ru', tier: 'A', type: 'state-agency',
    };
    const cachePath = path.join(cacheDir, 'cached.xml');
    writeFileSync(cachePath, RSS_FIXTURE, 'utf8');
    // Гарантируем «устаревший» кэш: mtime на 10 секунд в прошлом (а не гонка в пределах миллисекунды).
    const past = new Date(Date.now() - 10_000);
    utimesSync(cachePath, past, past);
    const result = await fetchSource(source, { cacheDir, cacheTtlSec: 1, timeoutMs: 1500 });
    assert.equal(result.items.length, 2, 'публикации из кэша не потеряны');
    assert.equal(result.fromCache, true);
    assert.equal(result.stale, true);
    assert.ok(result.error);
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test('rss.fetchAllSources: пустой каталог источников не роняет сбор', async () => {
  const empty = await fetchAllSources([], {});
  assert.deepEqual(empty.articles, []);
  assert.equal(empty.stats.total, 0);
  assert.equal(empty.stats.ok, 0);
  assert.equal(empty.stats.failed, 0);

  const disabled = await fetchAllSources([
    { id: 'off', name: 'Выключенный', url: 'http://127.0.0.1:1/rss.xml', enabled: false, region: 'ru', tier: 'A' },
  ], {});
  assert.deepEqual(disabled.articles, []);
  assert.equal(disabled.stats.total, 0, 'выключенные ленты не загружаются');
});

test('util.hashId: стабильный id одной и той же строки', () => {
  assert.equal(hashId('мужчина погиб атак бпла'), hashId('мужчина погиб атак бпла'));
  assert.match(hashId('abc'), /^[0-9a-f]{8}$/);
  assert.match(hashId('abc', 4), /^[0-9a-f]{4}$/);
  assert.notEqual(hashId('abc'), hashId('abd'));
});
