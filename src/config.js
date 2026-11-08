// Загрузка конфигурации и каталога источников.
import { promises as fs } from 'node:fs';
import { CONFIG_PATH, SOURCES_PATH } from './paths.js';

export const DEFAULT_CONFIG = {
  region: 'ru',
  threshold: 0.55,
  minDomains: 2,
  minConfidence: 0.5,
  maxAgeHours: 36,
  maxArticlesPerSource: 150,
  specializedSeverityFloor: 0.35,
  limit: 12,
  cacheTtlSec: 1800,
  wiki: true,
  weights: { severity: 0.4, corroboration: 0.25, recency: 0.15, confidence: 0.2 },
  tierWeights: { A: 1.0, B: 0.85, C: 0.6 },
  severity: {
    base: 0.15,
    groups: [
      { weight: 1.0, words: ['войн', 'обстрел', 'авиаудар', 'ракет', 'дрон', 'бпла', 'беспилот', 'наступлен', 'фронт', 'боев', 'штурм', 'мобилиз', 'ядерн', 'атак', 'удар', 'порази', 'поражен', 'уничтож', 'сбил', 'пво', 'инфраструктур', 'энергет'] },
      { weight: 0.95, words: ['теракт', 'взрыв', 'подрыв', 'заложник', 'захват'] },
      { weight: 0.95, words: ['погиб', 'убит', 'смерт', 'жертв', 'ранен', 'пострадал', 'труп'] },
      { weight: 0.9, words: ['катастроф', 'крушени', 'землетряс', 'наводнен', 'цунами', 'ураган', 'пожар', 'авари', 'эвакуац', 'чрезвычайн'] },
      { weight: 0.85, words: ['санкц', 'эмбарго', 'замороз', 'конфискац', 'депорт'] },
      { weight: 0.8, words: ['кризис', 'дефолт', 'инфляц', 'ставк', 'курс', 'обвал', 'банкрот', 'дефицит', 'девальвац', 'рецесси'] },
      { weight: 0.7, words: ['путин', 'кремл', 'правительств', 'госдум', 'совет федерац', 'закон', 'указ', 'отставк', 'выборы', 'переговор', 'договор', 'саммит', 'президент', 'премьер', 'министр'] },
      { weight: 0.65, words: ['запрет', 'ограничен', 'обяза', 'штраф', 'налог', 'тариф', 'льгот', 'пособ'] },
      { weight: 0.6, words: ['суд', 'приговор', 'арест', 'обыск', 'уголовн', 'коррупц', 'следствен', 'прокуратур'] },
      { weight: 0.55, words: ['протест', 'митинг', 'забастовк', 'петиц'] },
      { weight: 0.5, words: ['вирус', 'эпидем', 'пандеми', 'вакцин', 'заболева'] },
      { weight: 0.45, words: ['рекорд', 'вперв', 'историческ', 'климат', 'потеплен'] },
      { weight: 0.25, words: ['спорт', 'матч', 'чемпионат', 'олимпиад', 'футбол', 'хокке'] },
    ],
  },
  officialMarkers: [
    'сообщил', 'заявил', 'сообщает', 'сообщили', 'пресс-служба', 'пресс-службы', 'минобороны',
    'министерств', 'губернатор', 'администрац', 'следственн', 'прокуратур', 'мчс', 'цб', 'банк россии',
    'кремл', 'правительств', 'официальн', 'по данным', 'говорится в сообщении', 'опубликован',
  ],
  speculativeMarkers: [
    'якобы', 'по слухам', 'возможно', 'вероятно', 'не исключено', 'источник сообщил', 'как ожидается', 'может быть',
  ],
  refreshEveryMinutes: 60,
  notify: true,
};

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function mergeConfig(base, extra) {
  const out = { ...base };
  for (const [key, value] of Object.entries(extra || {})) {
    out[key] = isPlainObject(value) && isPlainObject(base[key]) ? mergeConfig(base[key], value) : value;
  }
  return out;
}

export async function loadConfig(overrides = {}) {
  let fileConfig = {};
  try {
    fileConfig = JSON.parse(await fs.readFile(CONFIG_PATH, 'utf8'));
  } catch {
    /* нет файла — работаем на дефолтах */
  }
  return mergeConfig(DEFAULT_CONFIG, mergeConfig(fileConfig, overrides));
}

export async function loadSources() {
  const data = JSON.parse(await fs.readFile(SOURCES_PATH, 'utf8'));
  const sources = Array.isArray(data.sources) ? data.sources : [];
  return { meta: { version: data.version, updatedAt: data.updatedAt }, sources };
}
