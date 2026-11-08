// Категории и города: каталог тем/ключевых слов и разметка публикаций.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ROOT } from './paths.js';

export const TOPICS_PATH = path.join(ROOT, 'topics.json');

const BROAD_TOPICS = new Set(['politics', 'economy', 'society', 'world']);
let catalogPromise = null;

function normalizeText(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^a-zа-я0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Ключевые слова — стемы-префиксы: «музык» совпадает с «музыка/музыкант», но не
// «транспорт» → «спорт». Короткие (<=3) требуют границы слова целиком.
function keywordRegExp(keyword) {
  // «=слово» — точное слово (например, =опера, чтобы не ловить «оператор»).
  const exact = keyword.startsWith('=');
  const raw = exact ? keyword.slice(1) : keyword;
  const source = `(?:^| )${escapeRegExp(raw)}`;
  const tail = exact || raw.length <= 3 ? '(?=$| )' : '';
  return new RegExp(`${source}${tail}`);
}

function prepare(catalog) {
  const categories = (catalog.categories || []).map((category) => ({
    ...category,
    keywords: (category.keywords || [])
      .map((keyword) => {
        const raw = String(keyword || '');
        const exact = raw.startsWith('=');
        const text = normalizeText(exact ? raw.slice(1) : raw);
        return text ? `${exact ? '=' : ''}${text}` : '';
      })
      .filter(Boolean)
      .map((keyword) => ({ text: keyword.replace(/^=/, ''), regex: keywordRegExp(keyword) })),
  }));
  const cities = (catalog.cities || []).map((city) => ({
    ...city,
    keywords: (city.keywords || [])
      .map(normalizeText)
      .filter(Boolean)
      .map((keyword) => ({ text: keyword.replace(/^=/, ''), regex: keywordRegExp(keyword) })),
  }));
  return {
    categories,
    cities,
    categoryIds: new Set(categories.map((category) => category.id)),
    cityIds: new Set(cities.map((city) => city.id)),
    categoryLabels: new Map(categories.map((category) => [category.id, category.label])),
    cityLabels: new Map(cities.map((city) => [city.id, city.label])),
  };
}

export async function loadTopics() {
  if (!catalogPromise) {
    catalogPromise = fs
      .readFile(TOPICS_PATH, 'utf8')
      .then((raw) => prepare(JSON.parse(raw)))
      .catch((error) => {
        // Без каталога приложение продолжает работать без тематических фильтров.
        process.stderr.write(`topics: не удалось прочитать ${TOPICS_PATH}: ${error.message}\n`);
        return prepare({ categories: [], cities: [] });
      });
  }
  return catalogPromise;
}

export function detectCategories(text, catalog) {
  const hay = normalizeText(text);
  if (!hay) return [];
  const found = [];
  for (const category of catalog.categories) {
    if (category.keywords.some((keyword) => keyword.regex.test(hay))) found.push(category.id);
  }
  return found;
}

export function detectCities(text, catalog) {
  const hay = normalizeText(text);
  if (!hay) return [];
  const found = [];
  for (const city of catalog.cities) {
    if (city.keywords.some((keyword) => keyword.regex.test(hay))) found.push(city.id);
  }
  return found;
}

function categoryScore(article, category) {
  const title = normalizeText(article.title);
  const summary = normalizeText(article.summary);
  let score = 0;
  for (const keyword of category.keywords) {
    if (keyword.regex.test(title)) score += 2;
    else if (keyword.regex.test(summary)) score += 1;
  }
  return score;
}

// Разметка одной публикации: специализированные подсказки ленты + ключевые слова.
// Учитываются только темы, подтверждённые заголовком (или словами в лиде); не более трёх.
export function classifyArticle(article, catalog) {
  const topics = new Set();
  const scoreByCategory = new Map();
  for (const category of catalog.categories) {
    scoreByCategory.set(category.id, categoryScore(article, category));
  }

  // Специализированные подсказки ленты добавляем только при поддержке текста:
  // тематические ленты бывают смешанными (кино/наука в tech-ленте).
  for (const topic of article.sourceTopics || []) {
    if (!catalog.categoryIds.has(topic) || BROAD_TOPICS.has(topic)) continue;
    if ((scoreByCategory.get(topic) || 0) >= 2) topics.add(topic);
  }

  const scored = [];
  for (const category of catalog.categories) {
    const score = scoreByCategory.get(category.id) || 0;
    if (score >= 2) scored.push({ id: category.id, score });
  }
  scored.sort((a, b) => b.score - a.score);
  for (const item of scored.slice(0, 3)) topics.add(item.id);

  const titleCities = detectCities(article.title || '', catalog);
  const textCities = detectCities(`${article.title || ''} ${article.summary || ''}`, catalog);

  if (article.sourceCity && catalog.cityIds.has(article.sourceCity)) {
    // Городские ленты с репутацией B/A доверяем; смешанные госканалы (C) —
    // только если город явно упомянут в заголовке.
    const trusted = article.tier === 'A' || article.tier === 'B';
    const cities = trusted || titleCities.includes(article.sourceCity)
      ? [article.sourceCity]
      : titleCities;
    return { topics: [...topics], cities };
  }

  // Город из общих лент — только по заголовку: «давление на Москву» в лиде
  // это метонимия про власть, а не городская новость.
  return { topics: [...topics], cities: titleCities };
}

export function filterByCategoryCity(events, { category = 'all', city = 'all' } = {}) {
  return events.filter((event) => {
    if (category !== 'all' && !(event.topics || []).includes(category)) return false;
    if (city !== 'all' && !(event.cities || []).includes(city)) return false;
    return true;
  });
}

export function categoryList(catalog) {
  return [
    { id: 'all', label: 'Все темы' },
    ...catalog.categories.map(({ id, label }) => ({ id, label })),
  ];
}

export function cityList(catalog) {
  return [
    { id: 'all', label: 'Все города' },
    ...catalog.cities.map(({ id, label }) => ({ id, label })),
  ];
}
