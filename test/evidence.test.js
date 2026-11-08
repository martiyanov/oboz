// Офлайн-тесты доказательного модуля «Обозреватель» (docs/CONTRACTS.md, раздел 2).
// Сетевой тест помечен префиксом "network:" и по умолчанию пропускается:
//   EVIDENCE_NETWORK=1 node --test --test-name-pattern="network:" test/evidence.test.js
// Обычный прогон `node --test test/` от сети не зависит.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, readdir, utimes } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  cleanText,
  splitSentences,
  extractNumbers,
  extractClaims,
  detectConflicts,
  attributionSignals,
  wikipediaFor,
  buildEvidence,
} from '../src/evidence.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, 'fixtures');
const EVIDENCE_SOURCE = path.join(HERE, '..', 'src', 'evidence.js');
const WIKI_PAGE = {
  pageid: 1,
  title: 'Курская область',
  extract: 'Курская область — субъект Российской Федерации, административный центр — Курск.',
};

async function fixture(name) {
  return JSON.parse(await readFile(path.join(FIXTURES, name), 'utf8'));
}

function tmpDir() {
  return mkdtemp(path.join(os.tmpdir(), 'oboz-evidence-'));
}

function okFetch(calls) {
  return async (url) => {
    calls.push(url);
    let pages = [WIKI_PAGE];
    try {
      const term = new URL(url).searchParams.get('gsrsearch');
      if (term && term !== WIKI_PAGE.title) {
        pages = [{ pageid: 2, title: term, extract: `Краткая справка: ${term}.` }];
      }
    } catch {
      /* оставляем страницу по умолчанию */
    }
    return { ok: true, status: 200, json: async () => ({ query: { pages } }) };
  };
}

function emptyWikiFetch(calls) {
  return async (url) => {
    calls.push(url);
    return { ok: true, status: 200, json: async () => ({ batchcomplete: true }) };
  };
}

function failingFetch(calls) {
  return async (url) => {
    calls.push(url);
    throw new Error('network down');
  };
}

function hangingFetch(calls) {
  return (url, { signal } = {}) => {
    calls.push(url);
    return new Promise((resolve, reject) => {
      if (!signal) return;
      signal.addEventListener('abort', () => {
        const error = new Error('aborted by timeout');
        error.name = 'TimeoutError';
        reject(error);
      });
    });
  };
}

function article(overrides = {}) {
  return {
    sourceId: 's1',
    sourceName: 'Источник',
    domain: 'example.ru',
    tier: 'A',
    type: 'independent',
    title: 'Заголовок',
    excerpt: 'Описание',
    link: 'https://example.ru/1',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Текст и числа
// ---------------------------------------------------------------------------

test('cleanText: CDATA, HTML-теги и сущности &laquo;/&nbsp;', () => {
  assert.equal(
    cleanText('<![CDATA[<p>&laquo;Привет&nbsp;мир&raquo;</p>]]>'),
    '«Привет мир»',
  );
  assert.equal(
    cleanText('&laquo;ТАСС&raquo;:&nbsp;&amp;&nbsp;&quot;цитата&quot;&hellip;'),
    '«ТАСС»: & "цитата"…',
  );
  assert.equal(cleanText('&#171;Число&#187; &#160;и &#x2014; тире'), '«Число» и — тире');
  assert.equal(cleanText('<p class="lead">Текст<br/>новости</p>'), 'Текст новости');
  assert.equal(cleanText(null), '');
  assert.equal(cleanText(undefined), '');
  assert.equal(cleanText('  много \n\n пробелов\t '), 'много пробелов');
});

test('splitSentences: не рвёт сокращения, склеивает обрывки', () => {
  const sentences = splitSentences('Погиб 1 человек. По данным МВД, это было в 2020 г. В области введён режим.');
  assert.deepEqual(sentences, [
    'Погиб 1 человек.',
    'По данным МВД, это было в 2020 г. В области введён режим.',
  ]);
  assert.deepEqual(splitSentences(''), []);
  assert.deepEqual(splitSentences('Коротко'), ['Коротко']);
});

test('extractNumbers: единицы, «тыс. человек», запятая как разделитель', () => {
  const numbers = extractNumbers('Погибли 2 тыс. человек, ущерб 5 млрд, инфляция 8%, 40 км, 2 часа, 3 млн');
  assert.deepEqual(
    numbers,
    [
      { value: 2000, unit: 'чел' },
      { value: 5, unit: 'млрд' },
      { value: 8, unit: '%' },
      { value: 40, unit: 'км' },
      { value: 2, unit: 'ч' },
      { value: 3, unit: 'млн' },
    ],
  );
  assert.deepEqual(extractNumbers('15 000 человек и 1,5%'), [
    { value: 15000, unit: 'чел' },
    { value: 1.5, unit: '%' },
  ]);
  assert.deepEqual(extractNumbers('без чисел'), []);
});

// ---------------------------------------------------------------------------
// extractClaims
// ---------------------------------------------------------------------------

test('extractClaims: 1–5 тезисов, первый — из title, есть number/statement', async () => {
  const event = await fixture('evidence-kursk.json');
  const claims = extractClaims(event);

  assert.ok(Array.isArray(claims));
  assert.ok(claims.length >= 1 && claims.length <= 5, `claims=${claims.length}`);
  assert.equal(claims[0].text, event.title);
  assert.deepEqual(claims.map((claim) => claim.id), claims.map((_, index) => `c${index + 1}`));

  for (const claim of claims) {
    assert.equal(typeof claim.text, 'string');
    assert.ok(claim.text.length <= 220, `длина тезиса ${claim.text.length}`);
    assert.ok(typeof claim.text === 'string' && claim.text.length > 0);
    assert.ok(['statement', 'number', 'attribution'].includes(claim.kind));
    assert.ok(Array.isArray(claim.numbers));
    assert.ok(Array.isArray(claim.support));
    assert.ok(claim.support.every((link) => event.articles.some((item) => item.link === link)));
  }

  const numbered = claims.find((claim) => claim.numbers.some((number) => number.value === 1 && number.unit === 'чел'));
  assert.ok(numbered, 'должен быть тезис с числом «1 человек»');
  assert.equal(numbered.kind, 'number');
  assert.equal(claims[0].kind, 'statement');
  assert.ok(claims[0].support.length >= 2, 'заголовок кластера подтверждён несколькими источниками');
  assert.ok(claims[0].support.includes('https://www.interfax.ru/russia/1127652'));
});

test('extractClaims: attribution-тезис без чисел', () => {
  const claims = extractClaims({
    title: 'Губернатор сообщил подробности атаки на регион',
    summary: '',
    articles: [],
  });
  assert.equal(claims.length, 1);
  assert.equal(claims[0].kind, 'attribution');
  assert.match(claims[0].text, /сообщил/);
});

test('extractClaims: длинное предложение режется до 220 символов', () => {
  const longTitle = 'Мужчина погиб при атаке беспилотника в Курской области '.repeat(12).trim();
  assert.ok(longTitle.length > 220);
  const [claim] = extractClaims({ title: longTitle });
  assert.ok(claim.text.length <= 220);
  assert.ok(claim.text.endsWith('…'));
});

test('extractClaims: похожие формулировки разных источников дедуплицируются', () => {
  const repeated = 'В результате атаки дрона на трактор погиб человек';
  const claims = extractClaims({
    title: 'Сводка происшествий за сутки',
    articles: [
      article({ title: 'Атака дрона на трактор', excerpt: repeated, link: 'https://a.ru/1' }),
      article({ title: 'Дрон атаковал трактор в районе', excerpt: repeated, link: 'https://b.ru/2' }),
    ],
  });
  const duplicates = claims.filter((claim) => claim.text.toLowerCase().includes('погиб человек'));
  assert.equal(duplicates.length, 1);
  assert.ok(duplicates[0].support.includes('https://a.ru/1'));
  assert.ok(duplicates[0].support.includes('https://b.ru/2'));
});

test('extractClaims: не больше 5 тезисов, пустое событие — пустой массив', () => {
  const articles = ['Пожар', 'Взрыв', 'Эвакуация', 'Пострадавшие', 'Причины', 'Следствие', 'Ущерб']
    .map((word) => article({ title: `${word} произошёл в регионе`, excerpt: '' }));
  const claims = extractClaims({ title: 'Сводка происшествий в регионе', articles });
  assert.equal(claims.length, 5);
  assert.deepEqual(extractClaims({}), []);
  assert.deepEqual(extractClaims(null), []);
});

// ---------------------------------------------------------------------------
// detectConflicts
// ---------------------------------------------------------------------------

test('detectConflicts: разные цифры погибших у источников', async () => {
  const event = await fixture('evidence-kursk.json');
  const conflicts = detectConflicts(event);

  assert.equal(conflicts.length, 1);
  const [conflict] = conflicts;
  assert.equal(conflict.kind, 'numbers');
  assert.equal(conflict.label, 'Число погибших');
  assert.deepEqual(new Set(conflict.values.map((value) => value.value)), new Set(['1', '2']));
  assert.ok(conflict.values.every((value) => value.unit === 'чел'));
  assert.match(conflict.note, /Источники расходятся/);
  assert.match(conflict.note, /1/);
  assert.match(conflict.note, /2/);
  const links = new Set(conflict.values.flatMap((value) => value.links));
  assert.ok(links.has('https://www.interfax.ru/russia/1127652'));
  assert.ok(links.has('https://tass.ru/proisshestviya/22500001'));
  assert.ok(links.has('https://www.bbc.com/russian/articles/c1234567890o'));
});

test('detectConflicts: несвязанные проценты не дают ложного конфликта', async () => {
  const event = await fixture('evidence-economy.json');
  assert.deepEqual(detectConflicts(event), []);
});

test('detectConflicts: проценты с общим контекстом — конфликт', () => {
  const conflicts = detectConflicts({
    articles: [
      article({ title: 'Инфляция ускорилась до 8%', excerpt: '', link: 'https://a.ru/1' }),
      article({ title: 'Инфляция замедлилась до 9%', excerpt: '', link: 'https://b.ru/2' }),
    ],
  });
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].label, 'Доля, %');
  assert.deepEqual(conflicts[0].values.map((value) => value.value), ['8', '9']);
  assert.equal(conflicts[0].values[0].unit, '%');
});

test('detectConflicts: суммы в млрд с общим контекстом — конфликт', () => {
  const conflicts = detectConflicts({
    articles: [
      article({
        title: 'Ущерб от паводка вырос',
        excerpt: 'Ущерб от паводка составил 5 млрд рублей, сообщили власти.',
        link: 'https://a.ru/1',
      }),
      article({
        title: 'Ущерб от паводка уточняют',
        excerpt: 'Ущерб от паводка составил 4 млрд рублей, по данным администрации.',
        link: 'https://b.ru/2',
      }),
    ],
  });
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].label, 'Сумма, млрд');
  assert.deepEqual(conflicts[0].values.map((value) => value.value), ['5', '4']);
  assert.match(conflicts[0].note, /млрд/);
});

test('detectConflicts: «2 человека» без контекста происшествия не конфликтуют', () => {
  const conflicts = detectConflicts({
    articles: [
      article({ title: 'На месте работают специалисты', excerpt: 'На месте работают 2 человека.', link: 'https://a.ru/1' }),
      article({ title: 'Задержаны подозреваемые', excerpt: 'Задержаны 3 человека.', link: 'https://b.ru/2' }),
    ],
  });
  assert.deepEqual(conflicts, []);
});

test('detectConflicts: погибшие и раненые — разные смысловые группы', () => {
  const conflicts = detectConflicts({
    articles: [
      article({ title: 'Погиб 1 человек', excerpt: '', link: 'https://a.ru/1' }),
      article({ title: 'Ранены 2 человека', excerpt: '', link: 'https://b.ru/2' }),
    ],
  });
  assert.deepEqual(conflicts, []);
});

test('detectConflicts: одинаковые цифры — не конфликт, пустое событие — []', () => {
  const conflicts = detectConflicts({
    articles: [
      article({ title: 'Погибли 2 человека', excerpt: '', link: 'https://a.ru/1' }),
      article({ title: 'Погибли 2 человека', excerpt: '', link: 'https://b.ru/2' }),
    ],
  });
  assert.deepEqual(conflicts, []);
  assert.deepEqual(detectConflicts({}), []);
  assert.deepEqual(detectConflicts(undefined), []);
});

// ---------------------------------------------------------------------------
// attributionSignals
// ---------------------------------------------------------------------------

test('attributionSignals: официальные маркеры и score', async () => {
  const event = await fixture('evidence-kursk.json');
  const signals = attributionSignals(event);
  assert.equal(signals.official, true);
  assert.ok(signals.markers.length >= 3);
  assert.ok(signals.markers.includes('губернатор'));
  assert.deepEqual(signals.speculative, []);
  assert.equal(signals.score, 0.95); // 0.5 + 3*0.15 (маркеры ограничены тремя)
});

test('attributionSignals: score граничных случаев', () => {
  assert.equal(attributionSignals({ title: 'Компания открыла новый завод' }).score, 0);
  assert.equal(attributionSignals({ title: 'Губернатор региона принял решение' }).score, 0.65);
  const speculative = attributionSignals({ title: 'Губернатор, якобы, выделил деньги на ремонт' });
  assert.equal(speculative.official, true);
  assert.deepEqual(speculative.speculative, ['якобы']);
  assert.equal(speculative.score, 0.45);
  assert.equal(attributionSignals({ title: 'Якобы всё хорошо' }).score, 0);
});

test('attributionSignals: подстроки маркеров не задваивают score', () => {
  const signals = attributionSignals({ title: 'Власти сообщили о чрезвычайной ситуации' });
  assert.deepEqual(signals.markers, ['сообщили']);
  assert.equal(signals.score, 0.65);
});

test('attributionSignals: списки маркеров передаются параметром', () => {
  const custom = attributionSignals(
    { title: 'Глава региона заявил, якобы готовится решение' },
    { officialMarkers: ['заявил'], speculativeMarkers: ['якобы'] },
  );
  assert.deepEqual(custom.markers, ['заявил']);
  assert.deepEqual(custom.speculative, ['якобы']);
  assert.equal(custom.official, true);
  assert.equal(custom.score, 0.45);

  const noMarker = attributionSignals(
    { title: 'Губернатор сообщил о решении' },
    { officialMarkers: ['заявил'], speculativeMarkers: [] },
  );
  assert.equal(noMarker.official, false);
  assert.equal(noMarker.score, 0);
});

test('attributionSignals: score всегда в диапазоне 0..1', () => {
  const events = [
    { title: '' },
    { title: 'якобы по слухам возможно вероятно', summary: 'не исключено' },
    { title: 'сообщил заявил пресс-служба минобороны губернатор кремль' },
  ];
  for (const event of events) {
    const { score } = attributionSignals(event);
    assert.ok(score >= 0 && score <= 1, `score=${score}`);
  }
});

// ---------------------------------------------------------------------------
// wikipediaFor (офлайн, сеть подменяется)
// ---------------------------------------------------------------------------

test('wikipediaFor: без сущностей не ходит в сеть', async () => {
  const dir = await tmpDir();
  const calls = [];
  assert.deepEqual(await wikipediaFor({ entities: [] }, { cacheDir: dir, fetch: failingFetch(calls) }), []);
  assert.deepEqual(await wikipediaFor({}, { cacheDir: dir, fetch: failingFetch(calls) }), []);
  assert.equal(calls.length, 0);
});

test('wikipediaFor: успешный ответ, ru.wikipedia.org, кэш на диске', async () => {
  const dir = await tmpDir();
  const calls = [];
  const refs = await wikipediaFor(
    { entities: ['Курская область'] },
    { cacheDir: dir, fetch: okFetch(calls), timeoutMs: 2000 },
  );

  assert.equal(refs.length, 1);
  assert.equal(refs[0].lang, 'ru');
  assert.equal(refs[0].title, 'Курская область');
  assert.match(refs[0].url, /^https:\/\/ru\.wikipedia\.org\/wiki\//);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /^https:\/\/ru\.wikipedia\.org\/w\/api\.php/);
  const url = new URL(calls[0]);
  assert.equal(url.searchParams.get('action'), 'query');
  assert.equal(url.searchParams.get('format'), 'json');

  const files = await readdir(dir);
  assert.ok(files.length >= 1, 'должен появиться файл кэша');

  const cachedCalls = [];
  const cached = await wikipediaFor(
    { entities: ['Курская область'] },
    { cacheDir: dir, fetch: failingFetch(cachedCalls), timeoutMs: 2000 },
  );
  assert.equal(cachedCalls.length, 0, 'кэш TTL 24ч: повторный запрос не нужен');
  assert.deepEqual(cached, refs);
});

test('wikipediaFor: кэширует и отрицательный результат', async () => {
  const dir = await tmpDir();
  const calls = [];
  assert.deepEqual(
    await wikipediaFor({ entities: ['Несуществующая сущность'] }, { cacheDir: dir, fetch: emptyWikiFetch(calls), timeoutMs: 2000 }),
    [],
  );
  assert.equal(calls.length, 1);
  const cachedCalls = [];
  assert.deepEqual(
    await wikipediaFor({ entities: ['Несуществующая сущность'] }, { cacheDir: dir, fetch: failingFetch(cachedCalls), timeoutMs: 2000 }),
    [],
  );
  assert.equal(cachedCalls.length, 0);
});

test('wikipediaFor: общие нарицательные «сущности» отбрасываются', async () => {
  const dir = await tmpDir();
  const calls = [];
  const refs = await wikipediaFor(
    { entities: ['Мужчина', 'Курская область', 'Россияне'] },
    { cacheDir: dir, fetch: okFetch(calls), timeoutMs: 2000 },
  );
  assert.equal(calls.length, 1);
  assert.equal(refs.length, 1);
  assert.equal(refs[0].title, 'Курская область');
});

test('wikipediaFor: сетевые ошибки не пробрасываются, не больше 3 запросов', async () => {
  const dir = await tmpDir();
  const calls = [];
  const refs = await wikipediaFor(
    { entities: ['Один', 'Два', 'Три', 'Четыре', 'Пять'] },
    { cacheDir: dir, fetch: failingFetch(calls), timeoutMs: 2000 },
  );
  assert.deepEqual(refs, []);
  assert.ok(calls.length <= 3, `запросов: ${calls.length}`);
  assert.equal(calls.length, 3);
});

test('wikipediaFor: limit больше 3 не увеличивает бюджет запросов', async () => {
  const dir = await tmpDir();
  const calls = [];
  await wikipediaFor(
    { entities: ['Один', 'Два', 'Три', 'Четыре'] },
    { cacheDir: dir, fetch: okFetch(calls), timeoutMs: 2000, limit: 10 },
  );
  assert.ok(calls.length <= 3);
});

test('wikipediaFor: TTL 24ч — устаревший кэш игнорируется', async () => {
  const dir = await tmpDir();
  const calls = [];
  await wikipediaFor({ entities: ['Курская область'] }, { cacheDir: dir, fetch: okFetch(calls), timeoutMs: 2000 });
  assert.equal(calls.length, 1);

  const [file] = await readdir(dir);
  const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
  await utimes(path.join(dir, file), old, old);

  const staleCalls = [];
  const refs = await wikipediaFor(
    { entities: ['Курская область'] },
    { cacheDir: dir, fetch: failingFetch(staleCalls), timeoutMs: 2000 },
  );
  assert.equal(staleCalls.length, 1, 'после TTL нужен новый запрос');
  assert.deepEqual(refs, []);
});

test('wikipediaFor: таймаут не бросает исключение', async () => {
  const dir = await tmpDir();
  const calls = [];
  const started = Date.now();
  const refs = await wikipediaFor(
    { entities: ['Курская область'] },
    { cacheDir: dir, fetch: hangingFetch(calls), timeoutMs: 150 },
  );
  const elapsed = Date.now() - started;
  assert.deepEqual(refs, []);
  assert.ok(elapsed < 3000, `таймаут сработал за ${elapsed} мс`);
  assert.ok(calls.length >= 1);
});

test('wikipediaFor: битый JSON не бросает исключение', async () => {
  const dir = await tmpDir();
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return { ok: true, status: 200, json: async () => { throw new Error('bad json'); } };
  };
  const refs = await wikipediaFor({ entities: ['Курская область'] }, { cacheDir: dir, fetch: fetchImpl, timeoutMs: 500 });
  assert.deepEqual(refs, []);
  assert.equal(calls.length, 1);
});

// ---------------------------------------------------------------------------
// buildEvidence
// ---------------------------------------------------------------------------

test('buildEvidence: полный блок без сети (wiki: false)', async () => {
  const event = await fixture('evidence-kursk.json');
  const calls = [];
  const result = await buildEvidence(event, { wiki: false, fetch: failingFetch(calls) });

  assert.deepEqual(Object.keys(result).sort(), ['attribution', 'claims', 'conflicts', 'notes', 'wiki']);
  assert.ok(result.claims.length >= 1 && result.claims.length <= 5);
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.attribution.official, true);
  assert.deepEqual(result.wiki, []);
  assert.deepEqual(calls, [], 'при wiki:false сеть не должна использоваться');
  assert.ok(result.notes.some((note) => /источника расходятся в цифрах/.test(note)));
  assert.ok(result.notes.some((note) => /официальный первоисточник/.test(note)));
});

test('buildEvidence: недоступная сеть не бросает исключение', async () => {
  const event = await fixture('evidence-kursk.json');
  const dir = await tmpDir();
  const calls = [];
  const result = await buildEvidence(event, {
    wiki: true,
    cacheDir: dir,
    fetch: failingFetch(calls),
    timeoutMs: 500,
  });

  assert.deepEqual(result.wiki, []);
  assert.ok(result.notes.some((note) => /Википедия недоступна/.test(note)));
  assert.ok(result.notes.some((note) => /фоновая справка Википедии не найдена/.test(note)));
  assert.ok(calls.length <= 3);
});

test('buildEvidence: Википедия подключается через opts и кэшируется', async () => {
  const event = await fixture('evidence-kursk.json');
  const dir = await tmpDir();
  const calls = [];
  const result = await buildEvidence(event, {
    wiki: true,
    cacheDir: dir,
    fetch: okFetch(calls),
    timeoutMs: 2000,
    limit: 3,
  });
  assert.equal(result.wiki.length, 3);
  assert.equal(calls.length, 3);
  assert.ok(result.wiki.every((ref) => ref.lang === 'ru'));
  assert.ok(!result.notes.some((note) => /не найдена/.test(note)));
});

test('buildEvidence: null/пустое событие — объект контрактной формы', async () => {
  const result = await buildEvidence(null);
  assert.deepEqual(result.claims, []);
  assert.deepEqual(result.conflicts, []);
  assert.deepEqual(result.wiki, []);
  assert.equal(typeof result.attribution.score, 'number');
  assert.ok(Array.isArray(result.notes));
});

test('buildEvidence: маркеры атрибуции можно передать параметром', async () => {
  const event = await fixture('evidence-kursk.json');
  const custom = await buildEvidence(event, {
    wiki: false,
    officialMarkers: ['губернатор'],
    speculativeMarkers: [],
  });
  assert.deepEqual(custom.attribution.markers, ['губернатор']);
  assert.equal(custom.attribution.official, true);
});

// ---------------------------------------------------------------------------
// Гигиена модуля
// ---------------------------------------------------------------------------

test('модуль импортирует только node:* (никаких зависимостей и внутренних модулей)', async () => {
  const source = await readFile(EVIDENCE_SOURCE, 'utf8');
  const specifiers = [...source.matchAll(/^import\s[^'"]*['"]([^'"]+)['"]/gm)].map((match) => match[1]);
  assert.ok(specifiers.length >= 1);
  for (const specifier of specifiers) {
    assert.ok(specifier.startsWith('node:'), `запрещённый импорт: ${specifier}`);
  }
  assert.ok(!/require\s*\(/.test(source), 'ESM-модуль не должен использовать require');
});

// ---------------------------------------------------------------------------
// Сетевой тест (по умолчанию пропускается)
// ---------------------------------------------------------------------------

const NETWORK_ENABLED = process.env.EVIDENCE_NETWORK === '1';

test(
  'network: wikipediaFor получает справку с ru.wikipedia.org',
  { skip: NETWORK_ENABLED ? false : 'сетевой тест: EVIDENCE_NETWORK=1 node --test --test-name-pattern="network:" test/evidence.test.js' },
  async () => {
    const dir = await tmpDir();
    const started = Date.now();
    const refs = await wikipediaFor({ entities: ['Курская область'] }, { cacheDir: dir, timeoutMs: 8000 });
    assert.ok(Date.now() - started <= 8500);
    assert.ok(Array.isArray(refs));
    if (refs.length) {
      assert.equal(refs[0].lang, 'ru');
      assert.match(refs[0].url, /^https:\/\/ru\.wikipedia\.org\/wiki\//);
      assert.ok(refs[0].title.length > 0);
    }
  },
);
