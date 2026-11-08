// Общие утилиты: текст, время, домены, токены. Без зависимостей.

export function clamp(value, min = 0, max = 1) {
  return Math.max(min, Math.min(max, value));
}

export function round(value, digits = 3) {
  const k = 10 ** digits;
  return Math.round(value * k) / k;
}

export function htmlToText(input) {
  return String(input || '')
    .replace(/<!\[CDATA\[|\]\]>/g, '')
    // Сначала раскрываем HTML-сущности (&lt;p&gt;), потом снимаем теги: часть лент
    // отдаёт разметку дважды экранированной.
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;|&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/p>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&laquo;|&raquo;/gi, '"')
    .replace(/&mdash;/gi, '—')
    .replace(/&ndash;/gi, '–')
    .replace(/\s+/g, ' ')
    .trim();
}

export function domainOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

// Канонический домен: m.lenta.ru и lenta.ru — один источник, bbc.com и bbc.co.uk — одна редакция.
const DOMAIN_ALIASES = {
  'm.lenta.ru': 'lenta.ru',
  'russian.rt.com': 'rt.com',
  'feeds.bbci.co.uk': 'bbc.co.uk',
  'bbc.com': 'bbc.co.uk',
  'm.gazeta.ru': 'gazeta.ru',
  'm.interfax.ru': 'interfax.ru',
  'm.rbc.ru': 'rbc.ru',
  'rssexport.rbc.ru': 'rbc.ru',
  'iz.ru': 'iz.ru',
  'lenta.ru': 'lenta.ru',
};

export function canonicalDomain(input) {
  const host = String(input || '').replace(/^https?:\/\//, '').split('/')[0].replace(/^www\./, '').toLowerCase();
  if (DOMAIN_ALIASES[host]) return DOMAIN_ALIASES[host];
  const parts = host.split('.');
  const multi = new Set(['co.uk', 'com.au', 'co.jp', 'com.tr', 'com.cn', 'co.in', 'org.uk', 'ac.uk']);
  const suffix = parts.slice(-2).join('.');
  if (multi.has(suffix) && parts.length >= 3) return parts.slice(-3).join('.');
  return parts.slice(-2).join('.');
}

export function hashId(input, length = 8) {
  // Простой FNV-1a: стабильный id без node:crypto.
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  const str = String(input);
  for (let i = 0; i < str.length; i += 1) {
    const c = str.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 ^= c + i;
    h2 = Math.imul(h2, 0x85ebca6b) >>> 0;
  }
  return (h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')).slice(0, length);
}

export function formatTimeRu(ms) {
  if (!ms) return '—';
  const d = new Date(ms);
  const now = new Date();
  const sameDay =
    d.getDate() === now.getDate() &&
    d.getMonth() === now.getMonth() &&
    d.getFullYear() === now.getFullYear();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  if (sameDay) return `${hh}:${mm}`;
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')} ${hh}:${mm}`;
}

export function formatDateTimeRu(ms) {
  if (!ms) return '—';
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function timeAgoRu(ms, now = Date.now()) {
  if (!ms) return '—';
  const minutes = Math.max(0, Math.round((now - ms) / 60000));
  if (minutes < 1) return 'только что';
  if (minutes < 60) return `${minutes} мин назад`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} ч назад`;
  const days = Math.round(hours / 24);
  return `${days} дн назад`;
}

export function parseDuration(input) {
  const text = String(input || '').trim().toLowerCase();
  const m = text.match(/^(\d+(?:[.,]\d+)?)\s*(s|sec|сек|m|min|мин|h|hour|час|ч|d|day|дн|день)?$/);
  if (!m) return null;
  const value = Number(m[1].replace(',', '.'));
  const unit = m[2] || 'm';
  const factor = /^(s|sec|сек)$/.test(unit) ? 1000
    : /^(m|min|мин)$/.test(unit) ? 60_000
    : /^(h|hour|час|ч)$/.test(unit) ? 3_600_000
    : 86_400_000;
  return Math.max(1000, Math.round(value * factor));
}

// --- Кластеризация: токены заголовков -------------------------------------

const STOPWORDS = new Set([
  'это', 'как', 'что', 'при', 'для', 'или', 'его', 'она', 'они', 'был', 'была', 'были', 'быть',
  'уже', 'еще', 'ещё', 'после', 'перед', 'через', 'также', 'который', 'которая', 'которые',
  'этого', 'этой', 'этом', 'свой', 'своих', 'всех', 'все', 'весь', 'где', 'когда', 'чем', 'тем',
  'без', 'над', 'под', 'про', 'если', 'то', 'же', 'ли', 'бы', 'не', 'ни', 'на', 'по', 'из', 'от',
  'до', 'за', 'во', 'со', 'об', 'о', 'в', 'и', 'а', 'но', 'да', 'нет', 'мы', 'вы', 'он', 'она',
  'оно', 'они', 'я', 'ты', 'есть', 'было', 'стало', 'стал', 'стала', 'можно', 'нужно', 'будет',
  'сообщил', 'сообщила', 'сообщили', 'заявил', 'заявила', 'заявили', 'сказал', 'рассказал',
  'россия', 'россии', 'россию', 'россией', 'российский', 'российские', 'рф',
]);

export function normalizeWord(word) {
  return String(word || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^a-zа-я0-9]/g, '');
}

// Грубый стеммер для русских словоформ: обрезаем словоформные окончания.
export function stemRu(word) {
  let w = normalizeWord(word);
  if (!w) return '';
  if (w.length <= 4) return w;
  w = w.replace(/(ами|ями|ого|ему|ому|ыми|ими|ая|яя|ое|ее|ые|ие|ый|ий|ой|ей|ую|юю|ах|ях|ам|ям|ом|ем|ов|ев|ия|ию|ие|ии|а|я|о|е|ы|и|у|ю|й|ь)$/u, '');
  if (w.length < 3) w = normalizeWord(word).slice(0, 4);
  return w.length > 5 ? w.slice(0, 5) : w;
}

export function titleTokens(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .split(/[^a-zа-я0-9]+/u)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w))
    .map((w) => (/^\d+$/.test(w) ? w : stemRu(w)))
    .filter(Boolean);
}

export function dice(setA, setB) {
  const a = setA instanceof Set ? setA : new Set(setA);
  const b = setB instanceof Set ? setB : new Set(setB);
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const token of a) if (b.has(token)) inter += 1;
  return (2 * inter) / (a.size + b.size);
}

export function intersectionSize(a, b) {
  let n = 0;
  for (const token of a) if (b.has(token)) n += 1;
  return n;
}

// Сущности: последовательности слов с заглавной буквы (имена, топонимы, организации).
const ENTITY_STOP = new Set([
  'В', 'Во', 'На', 'По', 'С', 'Со', 'Из', 'От', 'До', 'За', 'При', 'О', 'Об', 'А', 'И', 'Но',
  'Это', 'Как', 'Что', 'Когда', 'После', 'Перед', 'Также', 'Уже', 'Ещё', 'Еще', 'Он', 'Она',
  'Они', 'Мы', 'Вы', 'Россия', 'России', 'Москва', 'Москве', 'Москву', 'США', 'Украина',
  'Украине', 'Ранее', 'Теперь', 'Однако', 'Кроме', 'Сейчас', 'Сегодня', 'Вчера', 'Завтра',
]);

export function extractEntities(text, limit = 6) {
  const cleaned = String(text || '').replace(/[«»"()]/g, ' ');
  const matches = cleaned.match(/[А-ЯЁA-Z][а-яёa-z\-]+(?:\s+[А-ЯЁA-Z][а-яёa-z\-]+){0,3}/g) || [];
  const out = [];
  for (const raw of matches) {
    const value = raw.trim();
    if (value.length < 3) continue;
    const words = value.split(/\s+/);
    if (words.length === 1 && ENTITY_STOP.has(value)) continue;
    if (ENTITY_STOP.has(words[0]) && words.length === 1) continue;
    if (out.some((e) => e.toLowerCase() === value.toLowerCase())) continue;
    out.push(value);
    if (out.length >= limit) break;
  }
  return out;
}

// --- География для фильтра «Россия / мир» --------------------------------

const RU_HINTS = [
  'росси', 'рф', 'москв', 'петербург', 'ленинград', 'псков', 'новгород', 'курск', 'брянск',
  'белгород', 'орел', 'ростов', 'воронеж', 'краснодар', 'крым', 'севастопол', 'саратов', 'самар',
  'казан', 'татарстан', 'башкорт', 'урал', 'сибир', 'якут', 'омск', 'новосибирск', 'екатеринбург',
  'челябинск', 'тюмен', 'мурманск', 'архангел', 'вологд', 'твер', 'рязан', 'тул', 'калуг',
  'смоленск', 'ярослав', 'костром', 'иванов', 'владимир', 'нижн', 'пенз', 'ульяновск', 'волгоград',
  'астрахан', 'дагестан', 'чечн', 'ингушет', 'осети', 'кабард', 'ставропол', 'кубан', 'адыг',
  'карел', 'коми', 'ханты', 'ямал', 'чукот', 'камчат', 'сахалин', 'примор', 'хабаровск', 'амур',
  'забайкал', 'иркутск', 'кемеров', 'томск', 'алтай', 'красноярск', 'путин', 'кремл', 'госдум',
  'совфед', 'совет федерац', 'минобороны', 'рубл', 'банк россии', 'росгвард', 'фсб', 'мвд',
  'мчс', 'белгород', 'кузбасс', 'ямало', 'чуваш', 'мордов', 'марий', 'удмурт', 'хакас', 'тыва',
];

const WORLD_HINTS = [
  'сша', 'америк', 'трамп', 'байден', 'вашингтон', 'белый дом', 'европ', 'евросоюз', 'нато',
  'британ', 'лондон', 'франци', 'париж', 'герман', 'берлин', 'польш', 'варшав', 'краков', 'украин',
  'киев', 'одесс', 'харьков', 'львов', 'израил', 'тель-авив', 'иерусалим', 'сектор газ', 'иран',
  'тегеран', 'китай', 'пекин', 'япони', 'токио', 'инди', 'пакистан', 'корея', 'сеул', 'флорид',
  'калифорн', 'нью-йорк', 'канад', 'мексик', 'бразил', 'аргентин', 'турци', 'анкар', 'стамбул',
  'сирия', 'дамаск', 'ливан', 'египет', 'саудов', 'эр-рияд', 'оаэ', 'эмират', 'австрал',
  'новозеланд', 'австри', 'швейцар', 'швеци', 'норвеги', 'финлянд', 'дания', 'нидерланд',
  'бельги', 'испани', 'итали', 'греци', 'португал', 'чехи', 'словаки', 'венгри', 'румын',
  'болгар', 'серби', 'хорват', 'молдав', 'грузи', 'армени', 'азербайджан', 'казахстан',
  'узбекистан', 'таджикистан', 'киргиз', 'туркмен', 'беларус', 'белорус', 'литв', 'латви',
  'эстони', 'молдов', 'аргентин', 'чили', 'колумб', 'перу', 'венесуэл', 'куба', 'гаити',
];

export function countGeoHints(text) {
  const hay = String(text || '').toLowerCase().replace(/ё/g, 'е');
  let russia = 0;
  let world = 0;
  for (const hint of RU_HINTS) if (hay.includes(hint)) russia += 1;
  for (const hint of WORLD_HINTS) if (hay.includes(hint)) world += 1;
  return { russia, world };
}

export function stripAnsi(text) {  return String(text).replace(/\x1b\[[0-9;]*m/g, '');
}

export function visibleLength(text) {
  return [...stripAnsi(text)].length;
}

// Обрезка строки до ширины терминала (с учётом ANSI не поддерживается — режем до покраски).
export function truncate(text, width) {
  const chars = [...String(text)];
  if (chars.length <= width) return String(text);
  if (width <= 1) return chars.slice(0, width).join('');
  return chars.slice(0, width - 1).join('') + '…';
}

export function wrapText(text, width) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if ([...candidate].length <= width) {
      line = candidate;
    } else {
      if (line) lines.push(line);
      if ([...word].length > width) {
        let rest = word;
        while ([...rest].length > width) {
          lines.push([...rest].slice(0, width).join(''));
          rest = [...rest].slice(width).join('');
        }
        line = rest;
      } else {
        line = word;
      }
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
}

export function pad(text, width) {
  const len = visibleLength(text);
  return len < width ? `${text}${' '.repeat(width - len)}` : text;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
