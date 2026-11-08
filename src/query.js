// Поиск по ключевым словам для закладок: «q» в API/CLI.
// Ключевые слова разделяются запятыми; совпадение — любое из них (OR).

const MAX_KEYWORDS = 6;
const MAX_KEYWORD_LENGTH = 60;

export function normalizeText(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^a-zа-я0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseQuery(raw) {
  if (raw === null || raw === undefined) return [];
  if (Array.isArray(raw)) raw = raw.join(',');
  const parts = String(raw)
    .split(/[,;]+/)
    .map((part) => normalizeText(part))
    .filter(Boolean)
    .map((part) => part.slice(0, MAX_KEYWORD_LENGTH))
    .filter((part, index, list) => list.indexOf(part) === index);
  return parts.slice(0, MAX_KEYWORDS);
}

function keywordMatch(hay, keyword) {
  if (!keyword) return false;
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Слова ищем от начала слова: «спорт» не должен находиться внутри «транспорта».
  const start = `(?:^| )${escaped}`;
  const boundary = keyword.length <= 3 ? '(?=$| )' : '';
  return new RegExp(`${start}${boundary}`).test(hay);
}

export function eventMatchesQuery(event, keywords) {
  if (!keywords || !keywords.length) return true;
  const hay = normalizeText(`${event.title || ''} ${event.summary || ''}`);
  return keywords.some((keyword) => keywordMatch(hay, keyword));
}

export function filterByQuery(events, keywords) {
  if (!keywords || !keywords.length) return events;
  return events.filter((event) => eventMatchesQuery(event, keywords));
}

export function queryLabel(keywords) {
  return keywords && keywords.length ? keywords.join(', ') : '';
}
