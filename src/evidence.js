// Доказательная база события: тезисы, расхождения, первоисточник, Википедия.
// Контракт: docs/CONTRACTS.md, раздел 2.
//
// Модуль импортирует только node:* и не ходит в сеть там, где это не требуется:
// extractClaims / detectConflicts / attributionSignals — чистые функции;
// wikipediaFor / buildEvidence — единственные сетевые точки (ru.wikipedia.org, с кэшем и таймаутами).

import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// ---------------------------------------------------------------------------
// Текстовые утилиты: HTML-сущности, CDATA, предложения, токены
// ---------------------------------------------------------------------------

const MAX_CLAIM_LEN = 220;
const MAX_CLAIMS = 5;

const NAMED_ENTITIES = {
  nbsp: ' ', thinsp: ' ', ensp: ' ', emsp: ' ',
  laquo: '«', raquo: '»', bdquo: '„', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’',
  quot: '"', apos: "'", amp: '&', lt: '<', gt: '>',
  mdash: '—', ndash: '–', hellip: '…', middot: '·',
  copy: '©', reg: '®', deg: '°', euro: '€', times: '×',
};

function decodeEntities(input) {
  return String(input).replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]+);/gi, (whole, body) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X';
      const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) {
        try {
          return String.fromCodePoint(code);
        } catch {
          return whole;
        }
      }
      return whole;
    }
    const replacement = NAMED_ENTITIES[body.toLowerCase()];
    return replacement === undefined ? whole : replacement;
  });
}

/** Приводит RSS/HTML-фрагмент к простому тексту: CDATA, теги, сущности, пробелы. */
export function cleanText(input) {
  return decodeEntities(
    String(input ?? '')
      .replace(/<!\[CDATA\[|\]\]>/g, ' ')
      .replace(/<[^>]*>/g, ' '),
  )
    .replace(/<[^>]*>/g, ' ')
    .replace(/[\u200b-\u200f\u202a-\u202e\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const ABBREVIATIONS = /(?<![а-яёa-z])((?:т|г|гг|ул|д|п|им|млн|млрд|тыс|чел|руб|ст|рис|табл|напр|см|др|проч))\./gi;
const ABBREV_PLACEHOLDER = '\u0001';

/**
 * Режет текст на предложения, не разрывая частые сокращения (г., тыс., млн. и т.п.).
 * Слишком короткие обрывки приклеиваются к предыдущему предложению.
 */
export function splitSentences(text) {
  const cleaned = cleanText(text);
  if (!cleaned) return [];
  const guarded = cleaned.replace(ABBREVIATIONS, (m) => m.replace('.', ABBREV_PLACEHOLDER));
  const parts = guarded
    .split(/(?<=[.!?…])\s+(?=[«"„'A-ZА-ЯЁ0-9])/)
    .map((part) => part.replace(new RegExp(ABBREV_PLACEHOLDER, 'g'), '.').trim())
    .filter(Boolean);
  const sentences = [];
  for (const part of parts) {
    if (part.length < 12 && sentences.length) {
      sentences[sentences.length - 1] = `${sentences[sentences.length - 1]} ${part}`;
    } else {
      sentences.push(part);
    }
  }
  const meaningful = sentences.filter((s) => s.length >= 10);
  if (meaningful.length) return meaningful;
  return sentences.length ? sentences : [cleaned];
}

const RU_STOP = new Set([
  'это', 'как', 'что', 'при', 'для', 'или', 'его', 'она', 'они', 'был', 'была', 'были', 'быть',
  'будет', 'уже', 'еще', 'ещё', 'после', 'перед', 'через', 'также', 'который', 'которая', 'которые',
  'которого', 'этого', 'этом', 'этой', 'свой', 'своих', 'всех', 'все', 'весь', 'где', 'когда', 'чем',
  'тем', 'без', 'над', 'под', 'про', 'него', 'нее', 'неё', 'них', 'себя', 'себе', 'собой', 'между',
  'около', 'более', 'менее', 'почти', 'всего', 'лишь', 'порядка', 'выше', 'ниже',
  'составил', 'составила', 'составило', 'составили', 'вырос', 'выросла', 'выросло', 'выросли',
  'снизился', 'снизилась', 'снизилось', 'снизились', 'достиг', 'достигла', 'достигло',
  'увеличился', 'увеличилась', 'уменьшился', 'уменьшилась', 'может', 'могут', 'стало', 'стал',
  'также', 'однако', 'кроме', 'среди', 'вместе', 'против', 'ради', 'пока', 'если', 'чтобы',
  'было', 'есть', 'нет', 'да', 'не', 'ни', 'же', 'ли', 'бы', 'во', 'со', 'из', 'от', 'до', 'по',
  'за', 'на', 'о', 'об', 'в', 'и', 'а', 'но', 'с', 'к', 'у', 'не', 'то', 'та', 'те', 'ту', 'их',
]);

/** Нормализованный ключ сравнения текстов (регистр, ё, пунктуация). */
function normalizeKey(text) {
  return cleanText(text)
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^a-zа-я0-9]+/g, ' ')
    .trim();
}

/** Значимые слова текста (>= 3 символов, без стоп-слов). */
function tokens(text) {
  return normalizeKey(text)
    .split(' ')
    .filter((word) => word.length >= 3 && !RU_STOP.has(word));
}

function tokenSet(text) {
  return new Set(tokens(text));
}

function countShared(left, right) {
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  return shared;
}

function similarSets(left, right) {
  if (!left.size || !right.size) return false;
  const min = Math.min(left.size, right.size);
  return countShared(left, right) / min >= 0.75;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

// ---------------------------------------------------------------------------
// Числа
// ---------------------------------------------------------------------------

// Порядок важен: составные («2 тыс. человек») идут раньше простых единиц.
const NUMBER_PATTERNS = [
  { unit: 'чел', scale: 1e3, re: /(\d+(?:[.,]\d+)?)\s*(?:тыс\.?|тысяч\w*)\s*(?:человек\w*|чел\.?|людей)/gi },
  { unit: 'чел', scale: 1e6, re: /(\d+(?:[.,]\d+)?)\s*(?:млн|миллион\w*)\s*(?:человек\w*|чел\.?|людей)/gi },
  { unit: 'чел', scale: 1, re: /(\d[\d\s]*)\s*(?:человек\w*|чел\.?|людей|людьми)/gi },
  { unit: '%', scale: 1, re: /(\d+(?:[.,]\d+)?)\s*%/g },
  { unit: 'млрд', scale: 1, re: /(\d+(?:[.,]\d+)?)\s*млрд(?![а-яёa-z])/gi },
  { unit: 'млн', scale: 1, re: /(\d+(?:[.,]\d+)?)\s*млн(?![а-яёa-z])/gi },
  { unit: 'тыс', scale: 1, re: /(\d+(?:[.,]\d+)?)\s*тыс(?![а-яёa-z])\.?/gi },
  { unit: 'км', scale: 1, re: /(\d+(?:[.,]\d+)?)\s*(?:км(?![а-яёa-z])|километр\w*)/gi },
  { unit: 'ч', scale: 1, re: /(\d+(?:[.,]\d+)?)\s*(?:час\w*)/gi },
];

function parseNumber(raw) {
  const normalized = String(raw).replace(/\s+/g, '').replace(',', '.');
  const value = Number(normalized);
  return Number.isFinite(value) ? value : null;
}

function overlaps(left, right) {
  return left.index < right.end && right.index < left.end;
}

/**
 * Все числовые упоминания с единицами и позициями. Внутренняя функция (нужна
 * для detectConflicts); наружу отдаём упрощённый extractNumbers().
 */
function extractNumberMentions(text) {
  const source = String(text ?? '');
  const found = [];
  for (const { unit, scale, re } of NUMBER_PATTERNS) {
    re.lastIndex = 0;
    let match;
    while ((match = re.exec(source)) !== null) {
      const parsed = parseNumber(match[1]);
      if (parsed === null) {
        if (match[0].length === 0) re.lastIndex += 1;
        continue;
      }
      const value = scale === 1 ? parsed : parsed * scale;
      found.push({ value, unit, index: match.index, end: match.index + match[0].length, raw: match[0] });
      if (match[0].length === 0) re.lastIndex += 1;
    }
  }
  // «2 тыс. человек» совпадает и с составным шаблоном, и с «тыс» — оставляем более длинное совпадение.
  const byLength = [...found].sort((a, b) => (b.end - b.index) - (a.end - a.index));
  const kept = [];
  for (const mention of byLength) {
    if (!kept.some((other) => overlaps(mention, other))) kept.push(mention);
  }
  return kept.sort((a, b) => a.index - b.index);
}

/** Числа с единицами в тексте: [{ value: 1, unit: "чел" }] (без повторов). */
export function extractNumbers(text) {
  const out = [];
  const seen = new Set();
  for (const { value, unit } of extractNumberMentions(text)) {
    const key = `${value}|${unit}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ value, unit });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 1) Тезисы
// ---------------------------------------------------------------------------

const CLAIM_ATTRIBUTION_MARKERS = [
  'сообщил', 'сообщила', 'сообщили', 'сообщает', 'заявил', 'заявила', 'заявили',
  'по данным', 'пресс-служба', 'пресс-службы', 'говорится', 'заявляет',
];

function articleExcerpt(article) {
  return article?.excerpt ?? article?.description ?? article?.summary ?? '';
}

function articleLink(article) {
  const link = article?.link ?? article?.url;
  return typeof link === 'string' && link.trim() ? link.trim() : null;
}

function cutClaim(text) {
  const cleaned = cleanText(text);
  if (cleaned.length <= MAX_CLAIM_LEN) return cleaned;
  const sliced = cleaned.slice(0, MAX_CLAIM_LEN - 3);
  const lastSpace = sliced.lastIndexOf(' ');
  const base = (lastSpace > MAX_CLAIM_LEN / 2 ? sliced.slice(0, lastSpace) : sliced).trimEnd();
  return `${base}…`;
}

function claimKind(text, numbers) {
  if (numbers.length) return 'number';
  const lower = cleanText(text).toLowerCase();
  if (CLAIM_ATTRIBUTION_MARKERS.some((marker) => lower.includes(marker))) return 'attribution';
  return 'statement';
}

/**
 * Факты/тезисы события: 1–5 штук, первый — из заголовка кластера,
 * с числами, типом и ссылками публикаций, где тезис встречается.
 */
export function extractClaims(event) {
  const safeEvent = event && typeof event === 'object' ? event : {};
  const articles = Array.isArray(safeEvent.articles) ? safeEvent.articles.filter(Boolean) : [];

  const articleInfo = articles.map((article, index) => {
    const hay = cleanText(`${article?.title ?? ''} ${articleExcerpt(article)}`);
    return { index, link: articleLink(article), hay, tokens: tokenSet(hay) };
  });

  const candidates = [];
  const pushSentences = (text, origin) => {
    for (const sentence of splitSentences(text)) candidates.push({ text: sentence, origin });
  };
  pushSentences(safeEvent.title, -1);
  pushSentences(safeEvent.summary, -1);
  articles.forEach((article, index) => {
    pushSentences(articleExcerpt(article), index);
    pushSentences(article?.title, index);
  });

  const claims = [];
  const claimTokens = [];
  const seenKeys = new Set();

  for (const candidate of candidates) {
    const text = cutClaim(candidate.text);
    if (!text || text.length < 8) continue;
    const key = normalizeKey(text);
    if (!key || seenKeys.has(key)) continue;
    const candidateTokens = tokenSet(text);
    if (claimTokens.some((existing) => similarSets(candidateTokens, existing))) continue;
    seenKeys.add(key);
    claimTokens.push(candidateTokens);

    const numbers = extractNumbers(text);
    const support = [];
    const addSupport = (link) => {
      if (link && !support.includes(link)) support.push(link);
    };
    if (candidate.origin >= 0) addSupport(articleInfo[candidate.origin]?.link);
    for (const info of articleInfo) {
      if (!info.link || candidate.origin === info.index) continue;
      const shared = countShared(candidateTokens, info.tokens);
      const covered = key.length >= 20 && normalizeKey(info.hay).includes(key.slice(0, 40));
      if (shared >= 2 || (candidateTokens.size <= 2 && shared >= 1) || covered) addSupport(info.link);
    }

    claims.push({
      id: `c${claims.length + 1}`,
      text,
      kind: claimKind(text, numbers),
      numbers,
      support,
    });
    if (claims.length >= MAX_CLAIMS) break;
  }

  if (!claims.length) {
    const fallbackText = cutClaim(safeEvent.title || safeEvent.summary || '');
    if (!fallbackText) return [];
    return [
      {
        id: 'c1',
        text: fallbackText,
        kind: 'statement',
        numbers: extractNumbers(fallbackText),
        support: [...new Set(articleInfo.map((info) => info.link).filter(Boolean))],
      },
    ];
  }
  return claims;
}

// ---------------------------------------------------------------------------
// 2) Расхождения между источниками
// ---------------------------------------------------------------------------

const FATAL_WORDS = /(погиб\w*|жертв\w*|смерт\w*|убит\w*|труп\w*|мертв\w*)/i;
const INJURY_WORDS = /(ранен\w*|пострада\w*|травм\w*|госпитализ\w*)/i;
const CLAUSE_DELIMITERS = /[,;:—–]|\.\s|\!\s|\?\s/;

const LABEL_ORDER = [
  'Число погибших',
  'Число раненых',
  'Число людей',
  'Доля, %',
  'Сумма, млрд',
  'Сумма, млн',
  'Сумма, тыс',
  'Расстояние, км',
  'Длительность, часов',
];

const CATEGORY_BY_UNIT = {
  '%': 'percent',
  'млрд': 'money',
  'млн': 'money',
  'тыс': 'money',
  'км': 'distance',
  'ч': 'duration',
};

function clauseBounds(text, index, end) {
  let start = 0;
  let finish = text.length;
  const before = text.slice(0, index);
  const delimiters = [...before.matchAll(new RegExp(CLAUSE_DELIMITERS, 'g'))];
  if (delimiters.length) {
    const last = delimiters[delimiters.length - 1];
    start = last.index + last[0].length;
  }
  const after = text.slice(end);
  const next = after.search(CLAUSE_DELIMITERS);
  if (next >= 0) finish = end + next;
  return { start, end: finish };
}

/** Классифицирует числовое упоминание: к какому смыслу оно относится. */
function classifyMention(text, mention) {
  const { start, end } = clauseBounds(text, mention.index, mention.end);
  const clause = text.slice(start, end);
  const lower = clause.toLowerCase();
  const clauseTokens = tokenSet(clause);
  const isTitle = Boolean(mention.titleMention);

  if (mention.unit === 'чел') {
    const fatal = FATAL_WORDS.test(lower);
    const injury = INJURY_WORDS.test(lower);
    if (fatal && injury) {
      // В одном придаточном и «погибли», и «ранены» — выбираем слово ближе к числу.
      const fatalDistance = lower.search(FATAL_WORDS);
      const injuryDistance = lower.search(INJURY_WORDS);
      return fatalDistance <= injuryDistance
        ? { label: 'Число погибших', category: 'casualty', clauseTokens }
        : { label: 'Число раненых', category: 'casualty', clauseTokens };
    }
    if (fatal) return { label: 'Число погибших', category: 'casualty', clauseTokens };
    if (injury) return { label: 'Число раненых', category: 'casualty', clauseTokens };
    return { label: 'Число людей', category: 'people', clauseTokens, isTitle };
  }

  const category = CATEGORY_BY_UNIT[mention.unit] || 'other';
  const label = {
    percent: 'Доля, %',
    money: `Сумма, ${mention.unit}`,
    distance: 'Расстояние, км',
    duration: 'Длительность, часов',
  }[category] || `Число (${mention.unit})`;
  return { label, category, clauseTokens, isTitle };
}

function formatNumber(value) {
  return String(value).replace('.', ',');
}

function formatValue(entry) {
  const number = formatNumber(entry.value);
  if (entry.unit === '%') return `${number}%`;
  if (entry.unit === 'чел') return `${number} чел`;
  return `${number} ${entry.unit}`;
}

function buildConflict(label, category, mentions) {
  const values = new Map();
  const sources = new Set();
  for (const mention of mentions) {
    const key = String(mention.value);
    if (!values.has(key)) {
      values.set(key, { value: formatNumber(mention.value), numeric: mention.value, unit: mention.unit, links: [], mentions: [] });
    }
    const entry = values.get(key);
    if (mention.link && !entry.links.includes(mention.link)) entry.links.push(mention.link);
    entry.mentions.push(mention);
    if (mention.sourceIndex !== undefined) sources.add(mention.sourceIndex);
  }
  if (values.size < 2 || sources.size < 2) return null;

  const entries = [...values.values()];
  const pairComparable = entries.some((left, i) => entries.slice(i + 1).some((right) => {
    for (const a of left.mentions) {
      for (const b of right.mentions) {
        if (a.sourceIndex === b.sourceIndex) continue;
        if (category === 'casualty') return true;
        if (category === 'people') return Boolean(a.titleMention && b.titleMention);
        if (a.titleMention && b.titleMention) return true;
        const shared = countShared(a.clauseTokens || new Set(), b.clauseTokens || new Set());
        if (shared >= 1) return true;
      }
    }
    return false;
  }));
  if (!pairComparable) return null;

  const unit = entries[0].unit;
  const noteValues = entries.map((entry) => formatValue({ value: entry.numeric, unit: entry.unit }));
  return {
    kind: 'numbers',
    label,
    values: entries.map((entry) => ({
      value: entry.value,
      unit: entry.unit,
      links: [...entry.links],
    })),
    note: `Источники расходятся: ${noteValues.join(' и ')}`,
  };
}

/**
 * Расхождения между источниками в цифрах. Ищем только осмысленные случаи:
 * числа с единицами рядом с «погиб/жертв/ранен/пострадал», а прочие единицы —
 * только когда у источников есть общий контекст (или оба числа в заголовках).
 */
export function detectConflicts(event) {
  const safeEvent = event && typeof event === 'object' ? event : {};
  const articles = Array.isArray(safeEvent.articles) ? safeEvent.articles.filter(Boolean) : [];

  const grouped = new Map();
  articles.forEach((article, sourceIndex) => {
    const link = articleLink(article);
    const fields = [
      { text: cleanText(article?.title ?? ''), titleMention: true },
      { text: cleanText(articleExcerpt(article)), titleMention: false },
    ];
    for (const field of fields) {
      if (!field.text) continue;
      for (const mention of extractNumberMentions(field.text)) {
        const enriched = { ...mention, ...field, link, sourceIndex };
        const classification = classifyMention(field.text, enriched);
        if (!classification) continue;
        const key = classification.label;
        if (!grouped.has(key)) grouped.set(key, { category: classification.category, mentions: [] });
        grouped.get(key).mentions.push({ ...enriched, clauseTokens: classification.clauseTokens });
      }
    }
  });

  const conflicts = [];
  for (const label of LABEL_ORDER) {
    const group = grouped.get(label);
    if (!group) continue;
    const conflict = buildConflict(label, group.category, group.mentions);
    if (conflict) conflicts.push(conflict);
  }
  return conflicts;
}

// ---------------------------------------------------------------------------
// 3) Признаки первоисточника и спекулятивности
// ---------------------------------------------------------------------------

/** Официальные маркеры (объединение контракта и config.json → officialMarkers). */
export const DEFAULT_OFFICIAL_MARKERS = Object.freeze([
  'сообщил', 'сообщила', 'сообщили', 'сообщает', 'заявил', 'заявила', 'заявили',
  'пресс-служба', 'пресс-службы', 'минобороны', 'министерств', 'губернатор',
  'администрац', 'следственн', 'прокуратур', 'мчс', 'цб', 'банк россии', 'кремл',
  'правительств', 'официальн', 'по данным', 'говорится в сообщении', 'опубликован',
  'ведомство', 'оперативный штаб', 'глава региона',
]);

/** Спекулятивные маркеры (config.json → speculativeMarkers). */
export const DEFAULT_SPECULATIVE_MARKERS = Object.freeze([
  'якобы', 'по слухам', 'возможно', 'вероятно', 'не исключено',
  'источник сообщил', 'как ожидается', 'может быть',
]);

function eventHaystack(event) {
  const articles = Array.isArray(event?.articles) ? event.articles.filter(Boolean) : [];
  const articleText = articles
    .map((article) => `${article?.title ?? ''} ${articleExcerpt(article)}`)
    .join(' ');
  return cleanText(`${event?.title ?? ''} ${event?.summary ?? ''} ${articleText}`).toLowerCase();
}

/** Убирает маркеры-подстроки: «сообщил» не дублирует «сообщили». */
function longestMarkers(found) {
  const unique = [...new Set(found)];
  return unique.filter((marker) => !unique.some((other) => other !== marker && other.includes(marker)));
}

function markerList(value, fallback) {
  if (!Array.isArray(value)) return fallback;
  const list = value.filter((marker) => typeof marker === 'string' && marker.trim()).map((marker) => marker.trim().toLowerCase());
  return list.length ? [...new Set(list)] : fallback;
}

/**
 * Признаки первоисточника и спекулятивности. Списки маркеров можно передать
 * параметром (opts.officialMarkers / opts.speculativeMarkers), по умолчанию —
 * дефолты контракта/конфига.
 */
export function attributionSignals(event, opts = {}) {
  const safeEvent = event && typeof event === 'object' ? event : {};
  const hay = eventHaystack(safeEvent);
  const officialList = markerList(opts.officialMarkers, DEFAULT_OFFICIAL_MARKERS);
  const speculativeList = markerList(opts.speculativeMarkers, DEFAULT_SPECULATIVE_MARKERS);

  const markers = longestMarkers(officialList.filter((marker) => hay.includes(marker)));
  const speculative = longestMarkers(speculativeList.filter((marker) => hay.includes(marker)));
  const official = markers.length > 0;

  const rawScore = (official ? 0.5 : 0) + Math.min(3, markers.length) * 0.15 - (speculative.length ? 0.2 : 0);
  const score = Number(clamp(rawScore, 0, 1).toFixed(3));
  return { official, markers, speculative, score };
}

// ---------------------------------------------------------------------------
// 4) Википедия: ru.wikipedia.org, кэш .cache/wiki (TTL 24 ч), сеть не бросает
// ---------------------------------------------------------------------------

const WIKI_API = 'https://ru.wikipedia.org/w/api.php';
const WIKI_USER_AGENT = 'oboz/0.1 (terminal news watcher; evidence module)';
const WIKI_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const WIKI_CACHE_VERSION = 'v2';
const WIKI_MAX_REQUESTS = 3;
const WIKI_DEFAULT_TOTAL_MS = 8000;
const WIKI_DEFAULT_CACHE_DIR = '.cache/wiki';
const WIKI_EXTRACT_MAX = 400;
const WIKI_REQUEST_TIMEOUT_MS = 4000;

function clampInt(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return clamp(Math.trunc(number), min, max);
}

// Общие нарицательные слова, которые извлекатель сущностей иногда принимает за имена
// (например, «Мужчина» с заголовка). Для Википедии они дают шумные статьи — отбрасываем.
const GENERIC_ENTITY_STOP = new Set([
  'мужчина', 'женщина', 'человек', 'люди', 'ребенок', 'дети', 'подросток', 'россияне', 'россиянин',
  'москвичи', 'жители', 'власти', 'силовики', 'военные', 'военнослужащие', 'специалисты',
  'эксперты', 'ученые', 'врачи', 'чиновники', 'депутаты', 'губернатор', 'президент', 'министр',
]);

function normalizeEntities(event, limit) {
  const raw = Array.isArray(event?.entities) ? event.entities : [];
  const entities = [];
  const seen = new Set();
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const entity = cleanText(item).replace(/[«»„“”'’]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!entity || entity.length > 120 || !/[а-яёa-z]/i.test(entity)) continue;
    const key = entity.toLowerCase();
    if (GENERIC_ENTITY_STOP.has(key)) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    entities.push(entity);
    if (entities.length >= limit) break;
  }
  return entities;
}

function wikiCacheFile(cacheDir, entity) {
  const hash = crypto
    .createHash('sha1')
    .update(`${WIKI_CACHE_VERSION}|ru|${entity.toLowerCase()}`)
    .digest('hex')
    .slice(0, 20);
  return path.join(cacheDir, `${hash}.json`);
}

function isWikiRef(ref) {
  return Boolean(ref && typeof ref === 'object'
    && typeof ref.title === 'string' && ref.title
    && typeof ref.url === 'string' && ref.url
    && typeof ref.extract === 'string'
    && ref.lang === 'ru');
}

async function readWikiCache(cacheDir, entity) {
  const file = wikiCacheFile(cacheDir, entity);
  try {
    const stat = await fs.stat(file);
    if (Date.now() - stat.mtimeMs > WIKI_CACHE_TTL_MS) return null;
    const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
    if (!parsed || !Array.isArray(parsed.refs)) return null;
    return parsed.refs.filter(isWikiRef);
  } catch {
    return null;
  }
}

async function writeWikiCache(cacheDir, entity, refs) {
  try {
    await fs.mkdir(cacheDir, { recursive: true });
    const file = wikiCacheFile(cacheDir, entity);
    await fs.writeFile(file, JSON.stringify({ refs, fetchedAt: new Date().toISOString() }), 'utf8');
  } catch {
    /* кэш не критичен для работы модуля */
  }
}

function wikiApiUrl(entity) {
  const url = new URL(WIKI_API);
  url.searchParams.set('action', 'query');
  // generator=search + prop=extracts укладываются в ОДИН HTTP-запрос на сущность,
  // поэтому на событие уходит не больше трёх запросов (см. контракт).
  url.searchParams.set('generator', 'search');
  url.searchParams.set('gsrsearch', entity);
  url.searchParams.set('gsrlimit', '1');
  url.searchParams.set('prop', 'extracts');
  url.searchParams.set('exintro', '1');
  url.searchParams.set('explaintext', '1');
  url.searchParams.set('redirects', '1');
  url.searchParams.set('format', 'json');
  url.searchParams.set('formatversion', '2');
  url.searchParams.set('utf8', '1');
  return url.toString();
}

function parseWikiResponse(data, entity) {
  const pages = data?.query?.pages;
  const page = Array.isArray(pages)
    ? pages.find((item) => item && !item.missing && (item.title || item.extract))
    : Object.values(pages || {}).find((item) => item && !item.missing && (item.title || item.extract));
  if (!page) return null;

  const title = cleanText(page.title || entity);
  if (!title) return null;
  let extract = cleanText(page.extract || '');
  if (extract.length > WIKI_EXTRACT_MAX) {
    extract = `${extract.slice(0, WIKI_EXTRACT_MAX - 1).trimEnd()}…`;
  }
  const urlTitle = title.replace(/ /g, '_');
  return {
    title,
    url: `https://ru.wikipedia.org/wiki/${encodeURIComponent(urlTitle)}`,
    extract,
    lang: 'ru',
  };
}

function errorMessage(error) {
  const message = error && error.message ? String(error.message) : String(error);
  return message.length > 120 ? `${message.slice(0, 117)}…` : message;
}

function isAbortLike(error) {
  return Boolean(error && (error.name === 'AbortError' || error.name === 'TimeoutError'));
}

async function wikiRequest(url, fetchImpl, timeoutMs) {
  const doFetch = typeof fetchImpl === 'function' ? fetchImpl : globalThis.fetch;
  if (typeof doFetch !== 'function') throw new Error('fetch недоступен в этой среде');
  const signal = AbortSignal.timeout(Math.max(1, Math.trunc(timeoutMs)));
  const response = await doFetch(url, {
    signal,
    headers: { 'User-Agent': WIKI_USER_AGENT, Accept: 'application/json' },
  });
  if (!response || response.ok === false) {
    throw new Error(`Wikipedia HTTP ${response?.status ?? '?'}`);
  }
  return response.json();
}

async function wikipediaForDetailed(event, opts = {}) {
  const refs = [];
  const warnings = [];
  const safeEvent = event && typeof event === 'object' ? event : {};
  const limit = clampInt(opts.limit, 3, 1, 3);
  const totalMs = clampInt(opts.timeoutMs, WIKI_DEFAULT_TOTAL_MS, 100, WIKI_DEFAULT_TOTAL_MS);
  const cacheDir = typeof opts.cacheDir === 'string' && opts.cacheDir ? opts.cacheDir : WIKI_DEFAULT_CACHE_DIR;
  const deadline = Date.now() + totalMs;
  const entities = normalizeEntities(safeEvent, limit);
  if (!entities.length) return { refs, warnings };

  const seenUrls = new Set();
  const pushRef = (ref) => {
    if (!isWikiRef(ref) || seenUrls.has(ref.url)) return;
    seenUrls.add(ref.url);
    refs.push(ref);
  };

  let requests = 0;
  let warningSent = false;

  for (const entity of entities) {
    if (refs.length >= limit) break;
    const cached = await readWikiCache(cacheDir, entity);
    if (cached) {
      cached.forEach(pushRef);
      continue;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 50) {
      if (!warningSent) {
        warnings.push('Википедия: общий таймаут 8 с исчерпан, часть справок не загружена');
        warningSent = true;
      }
      break;
    }
    if (requests >= WIKI_MAX_REQUESTS) break;

    requests += 1;
    try {
      const perRequest = Math.min(remaining, clampInt(opts.requestTimeoutMs, WIKI_REQUEST_TIMEOUT_MS, 100, remaining));
      const data = await wikiRequest(wikiApiUrl(entity), opts.fetch, perRequest);
      const ref = parseWikiResponse(data, entity);
      const result = ref ? [ref] : [];
      await writeWikiCache(cacheDir, entity, result);
      result.forEach(pushRef);
    } catch (error) {
      if (!warningSent) {
        warnings.push(`Википедия недоступна: ${errorMessage(error)}`);
        warningSent = true;
      }
      if (isAbortLike(error) || Date.now() >= deadline - 100) break;
    }
  }

  return { refs: refs.slice(0, limit), warnings };
}

/**
 * Фоновая справка Википедии по сущностям события.
 * Сеть: только ru.wikipedia.org, ≤ 3 запросов, общий таймаут ≤ 8 с, кэш на 24 ч.
 * Сетевые ошибки не пробрасываются — возвращается то, что успели получить (обычно []).
 */
export async function wikipediaFor(event, opts = {}) {
  try {
    const { refs } = await wikipediaForDetailed(event, opts);
    return refs;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// 5) Сборка блока доказательств
// ---------------------------------------------------------------------------

function pluralRu(number, one, few, many) {
  const abs = Math.abs(number) % 100;
  const last = abs % 10;
  if (abs > 10 && abs < 20) return many;
  if (last === 1) return one;
  if (last >= 2 && last <= 4) return few;
  return many;
}

function safeCall(fn, fallback) {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

/**
 * Полный блок доказательств события. Не бросает исключений (в т.ч. при
 * недоступной сети) — всегда возвращает объект контрактной формы.
 *
 * opts: { wiki = true, limit = 3, timeoutMs = 8000, cacheDir = ".cache/wiki",
 *         officialMarkers?, speculativeMarkers?, fetch? (только для тестов) }
 */
export async function buildEvidence(event, opts = {}) {
  const safeEvent = event && typeof event === 'object' ? event : {};
  const options = opts && typeof opts === 'object' ? opts : {};

  const claims = safeCall(() => extractClaims(safeEvent), []);
  const conflicts = safeCall(() => detectConflicts(safeEvent), []);
  const attribution = safeCall(
    () => attributionSignals(safeEvent, {
      officialMarkers: options.officialMarkers,
      speculativeMarkers: options.speculativeMarkers,
    }),
    { official: false, markers: [], speculative: [], score: 0 },
  );

  let wiki = [];
  const wikiWarnings = [];
  if (options.wiki !== false) {
    try {
      const result = await wikipediaForDetailed(safeEvent, {
        limit: options.limit,
        timeoutMs: options.timeoutMs,
        cacheDir: options.cacheDir,
        requestTimeoutMs: options.requestTimeoutMs,
        fetch: options.fetch,
      });
      wiki = result.refs;
      wikiWarnings.push(...result.warnings);
    } catch (error) {
      wikiWarnings.push(`Википедия недоступна: ${errorMessage(error)}`);
    }
  }

  const notes = [];
  if (conflicts.length) {
    const sources = new Set();
    for (const conflict of conflicts) {
      for (const value of conflict.values || []) {
        for (const link of value.links || []) sources.add(link);
      }
    }
    const count = sources.size || Math.max(...conflicts.map((conflict) => (conflict.values || []).length));
    notes.push(`${count} ${pluralRu(count, 'источник', 'источника', 'источников')} расходятся в цифрах`);
  }
  if (attribution.official) notes.push('есть ссылка на официальный первоисточник');
  if (attribution.speculative.length) {
    notes.push(`в тексте есть спекулятивные формулировки: ${attribution.speculative.slice(0, 3).join(', ')}`);
  }
  if (options.wiki !== false) {
    if (!wiki.length) notes.push('фоновая справка Википедии не найдена');
    for (const warning of [...new Set(wikiWarnings)].slice(0, 2)) notes.push(warning);
  }

  return { claims, conflicts, attribution, wiki, notes };
}
