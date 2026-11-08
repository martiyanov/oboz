// Интерактивный TUI: список событий → досье → тезис → источник/Википедия.
// Навигация: ↑/↓, Enter, Esc, o — открыть ссылку в браузере.
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { enrichEvent } from './digest.js';
import { isPassing } from './score.js';
import { REGION_NAMES, plural, scoreLevel } from './format.js';
import {
  formatTimeRu, formatDateTimeRu, timeAgoRu, truncate, wrapText,
} from './util.js';

const ESC = '\x1b[';
const ALT_ON = `${ESC}?1049h`;
const ALT_OFF = `${ESC}?1049l`;
const HIDE_CURSOR = `${ESC}?25l`;
const SHOW_CURSOR = `${ESC}?25h`;
const CLEAR = `${ESC}2J${ESC}H`;

const S = {
  reset: `${ESC}0m`,
  bold: `${ESC}1m`,
  dim: `${ESC}2m`,
  inverse: `${ESC}7m`,
  red: `${ESC}31m`,
  green: `${ESC}32m`,
  yellow: `${ESC}33m`,
  cyan: `${ESC}36m`,
  magenta: `${ESC}35m`,
};

function scoreColor(score) {
  if (score >= 0.8) return S.green;
  if (score >= 0.65) return S.cyan;
  if (score >= 0.55) return S.yellow;
  return S.dim;
}

const TIER_LABEL = { A: 'высокое доверие', B: 'среднее доверие', C: 'низкое доверие' };
const KIND_LABEL = { statement: 'тезис', number: 'цифры', attribution: 'со ссылкой' };

function segment(text, style = '') {
  return { text: String(text), style };
}

function regionName(region) {
  return REGION_NAMES[region] || region;
}

function truncateAnsi(text, width) {
  if (width <= 0) return '';
  if (!text.includes(ESC)) return truncate(text, width);
  let out = '';
  let visible = 0;
  for (let i = 0; i < text.length && visible < width; i += 1) {
    if (text[i] === ESC) {
      const match = text.slice(i).match(/^\x1b\[[0-9;]*m/);
      if (match) {
        out += match[0];
        i += match[0].length - 1;
        continue;
      }
    }
    out += text[i];
    visible += 1;
  }
  if (text.length > out.length && !out.endsWith(S.reset)) out += S.reset;
  return out;
}

function paint(segments) {
  const width = Math.max(40, Math.min(process.stdout.columns || 100, 140));
  const height = Math.max(12, process.stdout.rows || 30);
  const lines = [];
  for (const seg of segments.slice(0, height)) {
    const text = truncateAnsi(seg.text, width);
    const padded = text + ' '.repeat(Math.max(0, width - text.replace(/\x1b\[[0-9;]*m/g, '').length));
    lines.push(seg.style ? `${seg.style}${padded}${S.reset}` : padded);
  }
  process.stdout.write(`${CLEAR}${lines.join('\n')}`);
}

function windowSlice(items, selectedLine, available) {
  if (items.length <= available) return items;
  let start = Math.max(0, Math.min(selectedLine - Math.floor(available / 2), items.length - available));
  if (selectedLine < start) start = selectedLine;
  return items.slice(start, start + available);
}

function selectedEvent(state) {
  const events = visibleEvents(state);
  if (!events.length) return null;
  return events[Math.min(state.listIndex, events.length - 1)];
}

function visibleEvents(state) {
  if (state.screen === 'rejected') return state.digest.rejected;
  return state.digest.events.filter((event) => isPassing(event, state.threshold));
}

function openUrl(url, state) {
  if (!/^https?:\/\//i.test(url || '')) {
    state.message = 'Ссылка недоступна';
    return;
  }
  const command = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'start'
    : 'xdg-open';
  try {
    const child = spawn(command, [url], { detached: true, stdio: 'ignore' });
    child.on('error', () => { state.message = `Не удалось открыть браузер: ${url}`; });
    child.unref();
    state.message = `Открываю в браузере: ${truncate(url, 70)}`;
  } catch {
    state.message = 'Не удалось открыть браузер';
  }
}

// --- Рендер экранов -------------------------------------------------------

function renderHeader(state, extra = '') {
  const digest = state.digest;
  const demo = digest.stats.demo ? ` · ДЕМО-ДАННЫЕ` : '';
  const threshold = state.threshold.toFixed(2);
  const passed = digest.events.filter((event) => isPassing(event, state.threshold)).length;
  return [
    segment(
      `ОБОЗРЕВАТЕЛЬ · ${regionName(state.region).toUpperCase()} · ${formatDateTimeRu(Date.now())} · порог ${threshold}${demo}`,
      `${S.bold}${demo ? S.magenta : S.cyan}`,
    ),
    segment(
      (digest.stats.demo ? 'Источники демо-набор' : `Источники ${digest.stats.sourcesOk}/${digest.stats.sourcesTotal}`) +
      ` · публикаций ${digest.stats.articlesUsed} · событий ${digest.stats.events} · прошло фильтр ${passed}` +
      (extra ? ` · ${extra}` : ''),
      S.dim,
    ),
    segment(''),
  ];
}

function renderList(state, height) {
  const events = visibleEvents(state);
  const segments = [...renderHeader(state, state.loading ? 'обновляю…' : '')];

  const footer = [
    segment(''),
    segment('↑↓ выбор · Enter разбор · t/T порог · g регион · e скрытые · r обновить · ? помощь · q выход', S.dim),
    segment(state.message, S.yellow),
  ];
  const available = Math.max(4, height - segments.length - footer.length - 1);

  if (!events.length) {
    segments.push(segment('— Ничего существенного не произошло.', `${S.bold}${S.yellow}`));
    segments.push(segment(
      `Ни одно из ${state.digest.stats.events} событий не превысило порог ${state.threshold.toFixed(2)} ` +
      `и не подтверждено нужным числом источников.`,
      S.dim,
    ));
    segments.push(segment(''));
    segments.push(segment('T — понизить порог, чтобы увидеть больше · g — сменить регион · r — обновить', S.dim));
    segments.push(segment(state.digest.stats.demo ? 'Источники: демо-набор (без сети)' : `Проверено источников: ${state.digest.stats.sourcesOk}/${state.digest.stats.sourcesTotal}`, S.dim));
    return [...segments, ...footer];
  }

  const lines = [];
  events.forEach((event, index) => {
    const selected = index === Math.min(state.listIndex, events.length - 1);
    const prefix = selected ? '▸ ' : '  ';
    const score = `[${event.score.toFixed(2)}]`;
    const title = truncate(event.title, Math.max(20, process.stdout.columns - 16));
    lines.push({
      line: segment(`${prefix}${score} ${title}`, `${selected ? S.inverse : ''}${scoreColor(event.score)}`),
      selectable: index,
    });
    const names = [...new Set(event.articles.map((a) => a.sourceName))].join(', ');
    lines.push({
      line: segment(`     ${truncate(names, 56)} · ${event.domains.length} ${plural(event.domains.length, 'источник', 'источника', 'источников')} · ${timeAgoRu(event.latestAt)}`, S.dim),
      selectable: index,
    });
  });

  const selectedLine = Math.min(state.listIndex, events.length - 1) * 2;
  const startIndex = Math.max(0, lines.findIndex((item) => item.selectable === Math.min(state.listIndex, events.length - 1)));
  const start = Math.max(0, Math.min(startIndex - Math.floor(available / 2), lines.length - available));
  const slice = lines.slice(Math.max(0, start), Math.max(0, start) + available);
  for (const item of slice) segments.push(item.line);
  if (events.length > 1) segments.push(segment(''));
  return [...segments, ...footer];
}

function buildDossierBody(state, available) {
  const event = state.dossier;
  const width = Math.max(40, Math.min(process.stdout.columns || 100, 140));
  const items = [];
  const selectables = [];

  const push = (text, style = '') => items.push({ line: segment(text, style), selectable: -1 });
  const section = (title) => {
    push('');
    push(title, `${S.bold}${S.cyan}`);
  };

  for (const line of wrapText(event.summary || event.title, width - 2).slice(0, 4)) push(line, S.dim);

  section('ТЕЗИСЫ (Enter — разбор тезиса и его подтверждений)');
  if (!event.claims.length) push('— тезисы не выделены', S.dim);
  event.claims.forEach((claim, index) => {
    const selected = selectables.length === state.dossierIndex;
    const kind = KIND_LABEL[claim.kind] || claim.kind;
    selectables.push({ kind: 'claim', ref: claim });
    items.push({
      line: segment(
        `${selected ? '▸ ' : '  '}${index + 1}. (${kind}) ${truncate(claim.text, width - 12)}`,
        selected ? `${S.inverse}` : '',
      ),
      selectable: selectables.length - 1,
    });
  });

  section(`ПОДТВЕРЖДЕНИЯ (${event.articles.length}) — Enter: карточка источника`);
  event.articles.forEach((article, index) => {
    const selected = selectables.length === state.dossierIndex;
    selectables.push({ kind: 'source', ref: article });
    items.push({
      line: segment(
        `${selected ? '▸ ' : '  '}${index + 1}. ${article.sourceName} · ${TIER_LABEL[article.tier] || article.tier} · ` +
        `${formatTimeRu(article.publishedAt)} · ${truncate(article.title, Math.max(20, width - 60))}`,
        selected ? `${S.inverse}` : '',
      ),
      selectable: selectables.length - 1,
    });
  });

  section('ПРОВЕРКА');
  const attribution = event.attribution || {};
  push(
    `  · Официальный первоисточник: ${attribution.official ? `да — ${(attribution.markers || []).slice(0, 4).join(', ')}` : 'нет прямой ссылки'}`,
    attribution.official ? S.green : S.dim,
  );
  if (event.conflicts?.length) {
    for (const conflict of event.conflicts) push(`  · Расхождение: ${conflict.label} — ${conflict.note}`, S.red);
  } else {
    push('  · Расхождений в цифрах между источниками не найдено', S.dim);
  }
  if (attribution.speculative?.length) {
    push(`  · Осторожные формулировки: ${attribution.speculative.join(', ')}`, S.yellow);
  }
  const cfg = state.config || {};
  const w = cfg.weights || { severity: 0.4, corroboration: 0.25, recency: 0.15, confidence: 0.2 };
  push(
    `  · Слагаемые оценки: значимость ${event.severity.toFixed(2)}×${w.severity} + подтверждения ` +
    `${event.corroboration.toFixed(2)}×${w.corroboration} + свежесть ${event.recency.toFixed(2)}×${w.recency} + ` +
    `достоверность ${event.confidence.toFixed(2)}×${w.confidence} = ${event.score.toFixed(2)}`,
    S.dim,
  );

  section('ФОН: ВИКИПЕДИЯ (Enter — справка)');
  if (state.wikiLoading) {
    push('  загружаю справку…', S.dim);
  } else if (!event.wiki?.length) {
    push('  — справка не найдена', S.dim);
  } else {
    for (const ref of event.wiki) {
      const selected = selectables.length === state.dossierIndex;
      selectables.push({ kind: 'wiki', ref });
      items.push({
        line: segment(
          `${selected ? '▸ ' : '  '}${truncate(ref.title, width - 6)}`,
          selected ? `${S.inverse}` : '',
        ),
        selectable: selectables.length - 1,
      });
    }
  }

  const selLine = items.findIndex((item) => item.selectable === state.dossierIndex);
  const start = Math.max(0, Math.min(
    (selLine >= 0 ? selLine : 0) - Math.floor(available / 2),
    Math.max(0, items.length - available),
  ));
  return { items: items.slice(start, start + available), selectables };
}

function renderDossier(state, height) {
  const event = state.dossier;
  const width = Math.max(40, Math.min(process.stdout.columns || 100, 140));
  const segments = [...renderHeader(state, state.loading ? 'обновляю…' : 'ДОСЬЕ')];
  for (const line of wrapText(event.title, width - 2).slice(0, 2)) segments.push(segment(line, `${S.bold}${S.cyan}`));
  segments.push(segment(
    `Оценка ${event.score.toFixed(2)} · ${scoreLevel(event.score)} · ${event.domains.length} ` +
    `${plural(event.domains.length, 'независимый источник', 'независимых источника', 'независимых источников')} · ` +
    `достоверность ${event.confidence.toFixed(2)}`,
    scoreColor(event.score),
  ));
  segments.push(segment(''));
  const footer = [
    segment(''),
    segment('↑↓ выбор · Enter открыть · o в браузере · r обновить · Esc назад · ? помощь · q выход', S.dim),
    segment(state.message, S.yellow),
  ];
  const available = Math.max(5, height - segments.length - footer.length - 1);
  const body = buildDossierBody(state, available);
  state.selectables = body.selectables;
  segments.push(...body.items.map((item) => item.line));
  return [...segments, ...footer];
}

function renderClaim(state, height) {
  const width = Math.max(40, Math.min(process.stdout.columns || 100, 140));
  const claim = state.claim;
  const event = state.dossier;
  const segments = [...renderHeader(state, 'ТЕЗИС')];
  segments.push(segment(truncate(event?.title || '', width - 2), S.dim));
  segments.push(segment(`«${truncate(claim.text, width - 4)}»`, S.bold));
  segments.push(segment(`Тип: ${KIND_LABEL[claim.kind] || claim.kind}` +
    (claim.numbers?.length ? ` · цифры: ${claim.numbers.map((n) => `${n.value} ${n.unit}`).join(', ')}` : ''), S.dim));
  segments.push(segment(''));

  const supportLinks = new Set(claim.support || []);
  let sources = event.articles.filter((article) => supportLinks.has(article.link));
  if (!sources.length) sources = event.articles;
  segments.push(segment(`ПОДТВЕРЖДАЮЩИЕ ПУБЛИКАЦИИ (${sources.length})`, `${S.bold}${S.cyan}`));

  const footer = [
    segment(''),
    segment('↑↓ выбор · Enter карточка источника · o в браузере · Esc назад', S.dim),
    segment(state.message, S.yellow),
  ];
  const available = Math.max(4, height - segments.length - footer.length - 1);
  const start = Math.max(0, Math.min(state.claimIndex - Math.floor(available / 2), sources.length - available));
  const window = sources.slice(Math.max(0, start), Math.max(0, start) + available);
  state.claimSources = window;
  window.forEach((article, offset) => {
    const index = Math.max(0, start) + offset;
    const selected = index === state.claimIndex;
    segments.push(segment(
      `${selected ? '▸ ' : '  '}${article.sourceName} · ${TIER_LABEL[article.tier] || article.tier} · ${formatTimeRu(article.publishedAt)}`,
      selected ? `${S.inverse}${S.bold}` : '',
    ));
    segments.push(segment(`     ${truncate(article.title, width - 6)}`, S.dim));
  });
  return [...segments, ...footer];
}

function renderSource(state, height) {
  const width = Math.max(40, Math.min(process.stdout.columns || 100, 140));
  const article = state.source;
  const segments = [...renderHeader(state, 'ИСТОЧНИК')];
  segments.push(segment(truncate(article.sourceName, width - 2), `${S.bold}${S.cyan}`));
  segments.push(segment(
    `${TIER_LABEL[article.tier] || article.tier} · ${article.type} · ${formatDateTimeRu(article.publishedAt)}`,
    S.dim,
  ));
  segments.push(segment(''));
  for (const line of wrapText(article.title || '', width - 2)) segments.push(segment(line, S.bold));
  segments.push(segment(''));
  for (const line of wrapText(article.summary || article.excerpt || 'Описание в ленте отсутствует.', width - 2)) {
    segments.push(segment(line));
  }
  segments.push(segment(''));
  segments.push(segment(`URL: ${truncate(article.link, width - 6)}`, S.cyan));
  segments.push(segment(''));
  segments.push(segment('Это одна из публикаций, подтверждающих событие. Открыть оригинал: o или Enter.', S.dim));
  const footer = [
    segment(''),
    segment('o / Enter — открыть в браузере · Esc назад', S.dim),
    segment(state.message, S.yellow),
  ];
  return [...segments.slice(0, Math.max(3, height - footer.length)), ...footer];
}

function renderWiki(state, height) {
  const width = Math.max(40, Math.min(process.stdout.columns || 100, 140));
  const ref = state.wiki;
  const segments = [...renderHeader(state, 'ВИКИПЕДИЯ')];
  segments.push(segment(ref.title, `${S.bold}${S.cyan}`));
  segments.push(segment(''));
  for (const line of wrapText(ref.extract || 'Нет вводного текста.', width - 2)) segments.push(segment(line));
  segments.push(segment(''));
  segments.push(segment(`Статья: ${truncate(ref.url, width - 10)}`, S.cyan));
  segments.push(segment(''));
  segments.push(segment('Фоновая справка помогает понять контекст, но не является подтверждением события.', S.dim));
  const footer = [
    segment(''),
    segment('o / Enter — открыть статью · Esc назад', S.dim),
    segment(state.message, S.yellow),
  ];
  return [...segments.slice(0, Math.max(3, height - footer.length)), ...footer];
}

function renderHelp(state, height) {
  const sections = [
    segment('ОБОЗРЕВАТЕЛЬ · помощь', `${S.bold}${S.cyan}`),
    segment(''),
    segment('КАК ЧИТАТЬ СВОДКУ', S.bold),
    segment('  Показываются только события выше порога, подтверждённые несколькими'),
    segment('  независимыми источниками. Оценка = значимость + подтверждения +'),
    segment('  свежесть + достоверность. Если ничего нет — так и написано.'),
    segment(''),
    segment('НАВИГАЦИЯ', S.bold),
    segment('  ↑ ↓ / j k   выбор строки'),
    segment('  Enter       открыть разбор: тезис → подтверждающие публикации → ссылка'),
    segment('  o           открыть ссылку в браузере'),
    segment('  Esc / ←     назад'),
    segment(''),
    segment('СПИСОК СОБЫТИЙ', S.bold),
    segment('  t / T       повысить / понизить порог на 0.05 (без повторной загрузки)'),
    segment('  g           сменить регион: Россия → Мир → Всё'),
    segment('  e           показать события, не прошедшие фильтр (для настройки)'),
    segment('  r           заново загрузить ленты и пересчитать'),
    segment('  q           выход'),
    segment(''),
    segment('ЧЕСТНО О ДОКАЗАТЕЛЬСТВАХ', S.bold),
    segment('  Подтверждение — это несколько независимых редакций, а не гарантия'),
    segment('  истины. Смотрите на тир источника, официальный первоисточник и'),
    segment('  расхождения в цифрах. Ссылка на Википедию — только фон.'),
  ];
  const footer = [segment(''), segment('Esc или ? — закрыть', S.dim)];
  const body = height > sections.length + footer.length ? sections : sections.slice(0, height - footer.length - 1);
  return [...body, ...footer];
}

function renderRejected(state, height) {
  const events = state.digest.rejected;
  const segments = [...renderHeader(state, 'ПОКАЗАНЫ НЕПРОШЕДШИЕ')];
  const footer = [
    segment(''),
    segment('↑↓ выбор · Enter разбор · Esc назад · q выход', S.dim),
    segment(state.message, S.yellow),
  ];
  const available = Math.max(4, height - segments.length - footer.length - 1);
  if (!events.length) {
    segments.push(segment('Скрытых событий нет — все прошли порог.', S.dim));
    return [...segments, ...footer];
  }
  const lines = [];
  events.forEach((event, index) => {
    const selected = index === Math.min(state.listIndex, events.length - 1);
    lines.push(segment(
      `${selected ? '▸ ' : '  '}[${event.score.toFixed(2)}] ${truncate(event.title, Math.max(20, process.stdout.columns - 16))}`,
      selected ? `${S.inverse}` : S.dim,
    ));
    lines.push(segment(`     ${event.reasons.join('; ')}`, S.yellow));
  });
  const start = Math.max(0, Math.min(Math.min(state.listIndex, events.length - 1) * 2 - Math.floor(available / 2), lines.length - available));
  segments.push(...lines.slice(Math.max(0, start), Math.max(0, start) + available));
  return [...segments, ...footer];
}

// --- Управление -----------------------------------------------------------

function createState(digest, config, options) {
  return {
    digest,
    config,
    options,
    threshold: digest.threshold,
    region: digest.region,
    screen: 'list',
    listIndex: 0,
    dossier: null,
    dossierIndex: 0,
    selectables: [],
    claim: null,
    claimIndex: 0,
    claimSources: [],
    source: null,
    wiki: null,
    wikiLoading: false,
    wikiToken: 0,
    loading: false,
    message: '',
  };
}

export async function runTui({ digest, config, options, rebuild }) {
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    // Не терминал — обычный текстовый вывод.
    const { formatDigest } = await import('./format.js');
    process.stdout.write(`${formatDigest(digest)}\n`);
    return 0;
  }

  const state = createState(digest, config, options);
  let finished = false;
  let resolveDone;
  const done = new Promise((resolve) => { resolveDone = resolve; });

  const render = () => {
    const height = Math.max(12, process.stdout.rows || 30);
    let segments;
    switch (state.screen) {
      case 'dossier': segments = renderDossier(state, height); break;
      case 'claim': segments = renderClaim(state, height); break;
      case 'source': segments = renderSource(state, height); break;
      case 'wiki': segments = renderWiki(state, height); break;
      case 'help': segments = renderHelp(state, height); break;
      case 'rejected': segments = renderRejected(state, height); break;
      default: segments = renderList(state, height);
    }
    paint(segments);
  };

  const cleanup = () => {
    if (finished) return;
    finished = true;
    process.stdin.removeListener('keypress', onKeypress);
    process.stdout.removeListener('resize', onResize);
    try { process.stdin.setRawMode(false); } catch { /* ignore */ }
    process.stdin.pause();
    process.stdout.write(`${S.reset}${SHOW_CURSOR}${ALT_OFF}`);
    resolveDone(0);
  };

  const quit = () => { cleanup(); };

  const syncList = () => {
    const events = visibleEvents(state);
    if (!events.length) state.listIndex = 0;
    else state.listIndex = Math.max(0, Math.min(state.listIndex, events.length - 1));
  };

  const refresh = async () => {
    if (state.loading) return;
    state.loading = true;
    state.message = 'Обновляю ленты…';
    render();
    try {
      const fresh = await rebuild({ region: state.region, threshold: state.threshold });
      fresh.threshold = state.threshold;
      state.digest = fresh;
      state.region = fresh.region;
      state.listIndex = 0;
      state.screen = 'list';
      state.message = `Обновлено в ${formatTimeRu(Date.now())}: прошло ${fresh.stats.passed} из ${fresh.stats.events}`;
    } catch (error) {
      state.message = `Ошибка обновления: ${error.message || error}`;
    }
    state.loading = false;
    render();
  };

  const loadWiki = async (event) => {
    const token = state.wikiToken + 1;
    state.wikiToken = token;
    state.wikiLoading = true;
    render();
    try {
      const enriched = await enrichEvent(event, { limit: 3 });
      if (token !== state.wikiToken) return;
      const index = state.digest.events.findIndex((candidate) => candidate.id === event.id);
      if (index >= 0) state.digest.events[index] = { ...enriched };
      if (state.dossier?.id === event.id) state.dossier = state.digest.events[index];
      state.message = enriched.wiki?.length
        ? `Справка Википедии: ${enriched.wiki.length} ${plural(enriched.wiki.length, 'статья', 'статьи', 'статей')}`
        : 'Справка Википедии не найдена';
    } catch {
      state.message = 'Не удалось загрузить справку Википедии';
    }
    state.wikiLoading = false;
    render();
  };

  const openDossier = (event) => {
    if (!event) return;
    state.dossier = event;
    state.dossierIndex = 0;
    state.screen = 'dossier';
    state.message = '';
    render();
    if (!event.wikiLoaded) void loadWiki(event);
  };

  const openClaim = (claim) => {
    state.claim = claim;
    state.claimIndex = 0;
    state.screen = 'claim';
    state.message = '';
    render();
  };

  const openSource = (article) => {
    state.source = article;
    state.screen = 'source';
    state.message = '';
    render();
  };

  const openWiki = (ref) => {
    state.wiki = ref;
    state.screen = 'wiki';
    state.message = '';
    render();
  };

  const activate = () => {
    if (state.screen === 'rejected' || state.screen === 'list') {
      const events = visibleEvents(state);
      openDossier(events[state.listIndex]);
      return;
    }
    if (state.screen === 'dossier') {
      const item = state.selectables[state.dossierIndex];
      if (!item) return;
      if (item.kind === 'claim') openClaim(item.ref);
      else if (item.kind === 'source') openSource(item.ref);
      else if (item.kind === 'wiki') openWiki(item.ref);
      return;
    }
    if (state.screen === 'claim') {
      const article = state.claimSources[state.claimIndex];
      if (article) openSource(article);
      return;
    }
    if (state.screen === 'source') {
      openUrl(state.source.link, state);
      render();
      return;
    }
    if (state.screen === 'wiki') {
      openUrl(state.wiki.url, state);
      render();
      return;
    }
  };

  const goBack = () => {
    switch (state.screen) {
      case 'dossier': state.screen = 'list'; state.message = ''; break;
      case 'claim': state.screen = 'dossier'; state.message = ''; break;
      case 'source':
      case 'wiki': state.screen = state.dossier ? 'dossier' : 'list'; state.message = ''; break;
      case 'rejected': state.screen = 'list'; state.message = ''; break;
      case 'help': state.screen = 'list'; state.message = ''; break;
      default: return;
    }
    render();
  };

  const adjustThreshold = (delta) => {
    const next = Math.max(0.05, Math.min(0.95, Math.round((state.threshold + delta) * 100) / 100));
    if (next === state.threshold) {
      state.message = delta > 0 ? 'Порог уже максимальный' : 'Порог уже минимальный';
      render();
      return;
    }
    state.threshold = next;
    syncList();
    const passed = state.digest.events.filter((event) => isPassing(event, state.threshold)).length;
    state.message = `Порог ${next.toFixed(2)} · проходит ${passed} из ${state.digest.stats.events} событий`;
    render();
  };

  const cycleRegion = async () => {
    const order = ['ru', 'world', 'all'];
    const next = order[(order.indexOf(state.region) + 1) % order.length];
    state.region = next;
    state.message = `Регион: ${regionName(next)} — пересчитываю…`;
    render();
    await refresh();
  };

  const onKeypress = (str, key) => {
    if (key?.ctrl && key.name === 'c') { quit(); return; }
    const name = key?.name || '';

    if (state.screen === 'help') {
      if (name === 'escape' || str === 'q' || str === '?') { state.screen = 'list'; state.message = ''; render(); }
      return;
    }

    if (state.screen === 'list' || state.screen === 'rejected') {
      const events = visibleEvents(state);
      if (name === 'up' || str === 'k') { state.listIndex = Math.max(0, state.listIndex - 1); render(); return; }
      if (name === 'down' || str === 'j') { state.listIndex = Math.min(events.length - 1, state.listIndex + 1); render(); return; }
      if (name === 'pageup') { state.listIndex = Math.max(0, state.listIndex - 5); render(); return; }
      if (name === 'pagedown') { state.listIndex = Math.min(events.length - 1, state.listIndex + 5); render(); return; }
      if (name === 'return' || name === 'enter') { activate(); return; }
      if (name === 'escape' && state.screen === 'rejected') { state.screen = 'list'; render(); return; }
      if (str === 'q') { quit(); return; }
      if (str === '?') { state.screen = 'help'; render(); return; }
      if (str === 'r') { void refresh(); return; }
      if (str === 'g') { void cycleRegion(); return; }
      if (str === 't') { adjustThreshold(0.05); return; }
      if (str === 'T') { adjustThreshold(-0.05); return; }
      if (str === 'e') { state.screen = state.screen === 'rejected' ? 'list' : 'rejected'; state.listIndex = 0; state.message = ''; render(); return; }
      return;
    }

    if (state.screen === 'dossier') {
      const total = state.selectables.length;
      if (name === 'up' || str === 'k') { state.dossierIndex = Math.max(0, state.dossierIndex - 1); render(); return; }
      if (name === 'down' || str === 'j') { state.dossierIndex = Math.min(total - 1, state.dossierIndex + 1); render(); return; }
      if (name === 'return' || name === 'enter') { activate(); return; }
      if (name === 'escape' || name === 'left' || str === 'q') { goBack(); return; }
      if (str === '?') { state.screen = 'help'; render(); return; }
      if (str === 'r') { void refresh(); return; }
      if (str === 'o') {
        const item = state.selectables[state.dossierIndex];
        if (item?.kind === 'source') openUrl(item.ref.link, state);
        else if (item?.kind === 'wiki') openUrl(item.ref.url, state);
        else if (item?.kind === 'claim' && item.ref.support?.length) openUrl(item.ref.support[0], state);
        render();
        return;
      }
      return;
    }

    if (state.screen === 'claim') {
      const total = state.claimSources.length;
      if (name === 'up' || str === 'k') { state.claimIndex = Math.max(0, state.claimIndex - 1); render(); return; }
      if (name === 'down' || str === 'j') { state.claimIndex = Math.min(total - 1, state.claimIndex + 1); render(); return; }
      if (name === 'return' || name === 'enter') { activate(); return; }
      if (name === 'escape' || name === 'left' || str === 'q') { goBack(); return; }
      if (str === 'o') {
        const article = state.claimSources[state.claimIndex];
        if (article) openUrl(article.link, state);
        render();
        return;
      }
      if (str === '?') { state.screen = 'help'; render(); return; }
      return;
    }

    if (state.screen === 'source' || state.screen === 'wiki') {
      if (name === 'escape' || name === 'left' || str === 'q') { goBack(); return; }
      if (name === 'return' || name === 'enter' || str === 'o') { activate(); return; }
      if (str === '?') { state.screen = 'help'; render(); return; }
      return;
    }
  };

  const onResize = () => render();

  process.stdout.write(`${ALT_ON}${HIDE_CURSOR}${S.reset}`);
  readline.emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('keypress', onKeypress);
  process.stdout.on('resize', onResize);
  render();

  await done;
  return 0;
}
