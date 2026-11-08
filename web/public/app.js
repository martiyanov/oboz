// ОБОЗРЕВАТЕЛЬ — веб-версия: список событий и досье поверх JSON API.
// Ванильный ES2020, без библиотек. Все данные с сервера вставляются только через
// textContent/createElement; внутренние ссылки — относительные (api/...).
(() => {
  'use strict';

  // ---------------------------------------------------------------------------
  // Константы контракта
  // ---------------------------------------------------------------------------

  const REGIONS = ['ru', 'world', 'all'];
  const REGION_LABELS = { ru: 'Россия', world: 'Мир', all: 'Всё' };
  const DEFAULT_REGION = 'ru';
  const DEFAULT_THRESHOLD = 0.55;
  const MIN_THRESHOLD = 0.3;
  const MAX_THRESHOLD = 0.95;
  const THRESHOLD_STEP = 0.05;
  const EVENTS_LIMIT = 12;
  const AUTO_REFRESH_MS = 60000;
  const AUTO_REFRESH_MIN_GAP_MS = 45000;
  const WEIGHTS_FALLBACK = { severity: 0.4, corroboration: 0.25, recency: 0.15, confidence: 0.2 };

  const TIER_TRUST = { A: 'высокое доверие', B: 'среднее доверие', C: 'низкое доверие' };
  const TYPE_LABELS = {
    'state-agency': 'госагентство',
    'state-affiliated': 'госканал',
    independent: 'независимое издание',
    business: 'деловое издание',
    foreign: 'иностранное издание',
    aggregator: 'агрегатор',
  };
  const CLAIM_KINDS = {
    statement: 'тезис',
    number: 'цифра',
    attribution: 'со ссылкой на источник',
  };

  const ALL_FILTER = 'all';
  const FALLBACK_CATEGORIES = [
    { id: 'all', label: 'Все темы' },
    { id: 'politics', label: 'Политика' },
    { id: 'economy', label: 'Экономика' },
    { id: 'society', label: 'Общество' },
    { id: 'tech', label: 'Технологии' },
    { id: 'music', label: 'Музыка' },
    { id: 'culture', label: 'Культура' },
    { id: 'science', label: 'Наука' },
    { id: 'sport', label: 'Спорт' },
    { id: 'incidents', label: 'Происшествия' },
  ];
  const FALLBACK_CITIES = [
    { id: 'all', label: 'Все города' },
    { id: 'moscow', label: 'Москва' },
    { id: 'nizhny', label: 'Нижний Новгород' },
  ];

  const BOOKMARKS_KEY = 'oboz-bookmarks-v1';
  const ACTIVE_BOOKMARK_KEY = 'oboz-active-bookmark';
  const MAX_BOOKMARK_KEYWORDS = 6;
  const MAX_BOOKMARK_NAME = 80;
  const MAX_SEEN_IDS = 300;
  const BOOKMARK_NOTIFICATION_TITLE = 'Новые новости по закладке';
  const BOOKMARK_NOTIFICATION_MIN_INTERVAL_MS = 60000;
  const BOOKMARK_STOP_WORDS = new Set([
    'в', 'во', 'и', 'на', 'после', 'по', 'с', 'со', 'из', 'от', 'до', 'за', 'под', 'над', 'при',
    'для', 'что', 'как', 'это', 'его', 'ее', 'её', 'их', 'был', 'была', 'было', 'были', 'будет',
    'а', 'но', 'или', 'не', 'без', 'более', 'уже', 'еще', 'ещё', 'также', 'который', 'которая',
    'которые', 'о', 'об', 'про', 'через', 'между', 'ко', 'же', 'ли', 'бы', 'то', 'так', 'только',
    'даже', 'чем', 'тогда', 'когда', 'где', 'там', 'тут', 'сейчас', 'сегодня', 'вчера', 'заявил',
    'заявила', 'заявили', 'сообщил', 'сообщила', 'сообщили', 'рассказал', 'рассказала', 'рассказали',
    'может', 'можно', 'нужно', 'стал', 'стала', 'стали', 'один', 'два', 'три', 'под', 'the', 'and',
    'for', 'with', 'from', 'that', 'this', 'news', 'после', 'около', 'почти', 'снова', 'уже',
  ]);

  // ---------------------------------------------------------------------------
  // Состояние
  // ---------------------------------------------------------------------------

  const state = {
    region: DEFAULT_REGION,
    threshold: DEFAULT_THRESHOLD,
    category: ALL_FILTER,
    city: ALL_FILTER,
    query: [],
    categoryOptions: FALLBACK_CATEGORIES.map((item) => ({ id: item.id, label: item.label })),
    cityOptions: FALLBACK_CITIES.map((item) => ({ id: item.id, label: item.label })),
    filterSignature: '',
    bookmarks: [],
    activeBookmarkId: null,
    bookmarkBadgeCount: 0,
    bookmarkEditingId: null,
    bookmarkDraftEventId: null,
    bookmarksSource: 'header',
    lastNotificationAt: 0,
    bookmarksReturnFocus: null,
    view: 'list', // 'list' | 'detail'
    data: null,
    events: [],
    rejected: [],
    stats: null,
    meta: null,
    selectedIndex: 0,
    detailId: null,
    detail: null,
    loading: false,
    detailLoading: false,
    digestToken: 0,
    eventToken: 0,
    digestController: null,
    eventController: null,
    lastLoadAt: 0,
    lastDigestOpts: { refresh: false, silent: false, reason: 'init' },
    detailEntryPushed: false,
    thresholdTimer: null,
    autoTimer: null,
    helpReturnFocus: null,
    timeFormat: null,
    secondsFormat: null,
    relativeFormat: null,
  };

  const dom = {};

  // ---------------------------------------------------------------------------
  // Утилиты DOM и форматирования
  // ---------------------------------------------------------------------------

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function clearNode(node) {
    if (!node) return;
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function plural(count, one, few, many) {
    const n = Math.abs(Math.trunc(Number(count) || 0));
    const mod10 = n % 10;
    const mod100 = n % 100;
    if (mod10 === 1 && mod100 !== 11) return one;
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
    return many;
  }

  function clampNumber(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function normalizeThreshold(value) {
    const raw = Number(String(value === undefined || value === null ? '' : value).replace(',', '.'));
    if (!Number.isFinite(raw)) return DEFAULT_THRESHOLD;
    const clamped = clampNumber(raw, MIN_THRESHOLD, MAX_THRESHOLD);
    const stepped = Math.round(clamped / THRESHOLD_STEP) * THRESHOLD_STEP;
    return Number(clampNumber(stepped, MIN_THRESHOLD, MAX_THRESHOLD).toFixed(2));
  }

  function formatScore(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n.toFixed(2) : '—';
  }

  /* Оценка события для людей: двузначное число из 100. */
  function formatScore100(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '—';
    return String(Math.round(clampNumber(n, 0, 1) * 100));
  }

  function scoreAriaLabel(value) {
    const text = formatScore100(value);
    return text === '—' ? 'Оценка не определена' : `Оценка ${text} из 100`;
  }

  function scoreBand(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 'score-low';
    if (n >= 0.85) return 'score-high';
    if (n >= 0.65) return 'score-mid';
    return 'score-low';
  }

  /* --- Фильтры по теме и городу --- */

  function hasFilterOption(options, id) {
    return Array.isArray(options) && options.some((option) => option.id === id);
  }

  function optionLabel(options, id) {
    const found = Array.isArray(options) ? options.find((option) => option.id === id) : null;
    return found ? found.label : id;
  }

  /* Списки приходят из meta.categories/meta.cities; fallback — дефолты контракта. */
  function normalizeFilterOptions(rawOptions, fallback) {
    const options = [];
    const seen = new Set();
    if (Array.isArray(rawOptions)) {
      for (const item of rawOptions) {
        if (!item || typeof item !== 'object') continue;
        const id = typeof item.id === 'string' ? item.id.trim() : '';
        const label = typeof item.label === 'string' ? item.label.trim() : '';
        if (!/^[a-z0-9-]{1,32}$/.test(id) || !label || seen.has(id)) continue;
        seen.add(id);
        options.push({ id, label });
      }
    }
    if (!options.length) {
      return fallback.map((item) => ({ id: item.id, label: item.label }));
    }
    if (!seen.has(ALL_FILTER)) {
      const all = fallback.find((item) => item.id === ALL_FILTER);
      options.unshift({ id: ALL_FILTER, label: all ? all.label : 'Все' });
    }
    return options;
  }

  function filterSignature(categories, cities) {
    const part = (options) => options.map((option) => `${option.id}:${option.label}`).join('|');
    return `${part(categories)}//${part(cities)}`;
  }

  function populateFilterSelect(select, options, value) {
    if (!select) return;
    clearNode(select);
    options.forEach((option) => {
      const node = document.createElement('option');
      node.value = option.id;
      node.textContent = option.label;
      select.append(node);
    });
    if (!hasFilterOption(options, value)) {
      const node = document.createElement('option');
      node.value = value;
      node.textContent = value;
      select.append(node);
    }
    select.value = value;
  }

  function rebuildFilterSelects() {
    populateFilterSelect(dom.categorySelect, state.categoryOptions, state.category);
    populateFilterSelect(dom.citySelect, state.cityOptions, state.city);
  }

  function activeFilterSuffix() {
    const parts = [];
    if (state.query.length) {
      const bookmark = getActiveBookmark();
      parts.push(bookmark ? `закладка «${bookmark.name}»` : `поиск «${state.query.join(', ')}»`);
    }
    if (state.category !== ALL_FILTER) parts.push(`тема «${optionLabel(state.categoryOptions, state.category)}»`);
    if (state.city !== ALL_FILTER) parts.push(`город «${optionLabel(state.cityOptions, state.city)}»`);
    return parts.length ? ` · ${parts.join(' · ')}` : '';
  }

  // ---------------------------------------------------------------------------
  // Закладки: UI, фильтрация и уведомления
  // ---------------------------------------------------------------------------

  function updateBookmarkBadge() {
    if (!dom.bookmarksBadge) return;
    const count = Math.max(0, Number(state.bookmarkBadgeCount) || 0);
    dom.bookmarksBadge.textContent = String(count);
    dom.bookmarksBadge.hidden = count === 0;
    if (dom.bookmarksButton) {
      dom.bookmarksButton.setAttribute('aria-label', count ? `Закладки, новых: ${count}` : 'Закладки');
    }
  }

  function resetBookmarksBadge() {
    state.bookmarkBadgeCount = 0;
    updateBookmarkBadge();
  }

  function updateActiveBookmarkChip() {
    if (!dom.activeBookmarkRow || !dom.activeBookmark || !dom.activeBookmarkText) return;
    const active = state.query.length > 0;
    dom.activeBookmarkRow.hidden = !active;
    if (!active) {
      dom.activeBookmarkText.textContent = '';
      dom.activeBookmark.removeAttribute('title');
      return;
    }
    const bookmark = getActiveBookmark();
    const label = bookmark ? bookmark.name : state.query.join(', ');
    dom.activeBookmarkText.textContent = bookmark ? `★ ${label}` : `поиск: ${label}`;
    dom.activeBookmark.title = bookmark ? `слова: ${bookmark.keywords.join(', ')}` : label;
    if (dom.activeBookmarkReset) {
      dom.activeBookmarkReset.setAttribute('aria-label', 'Сбросить закладку');
    }
  }

  /* 3–5 значимых слов из заголовка — для предзаполнения закладки. */
  function keywordsFromTitle(title) {
    const cleaned = String(title || '')
      .toLowerCase()
      .replace(/[«»„“”"'’`()[\]{}.,;:!?—–\-/\\|]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const seen = new Set();
    const words = [];
    const push = (word) => {
      if (!word || word.length < 3 || seen.has(word) || /^\d+$/.test(word)) return;
      seen.add(word);
      words.push(word);
    };
    cleaned.split(' ').forEach((word) => {
      if (words.length >= 5) return;
      if (BOOKMARK_STOP_WORDS.has(word)) return;
      push(word);
    });
    if (words.length < 3) {
      cleaned.split(' ').forEach((word) => {
        if (words.length >= 3) return;
        push(word);
      });
    }
    return words.slice(0, 5);
  }

  function requestNotificationPermission() {
    try {
      if (typeof window.Notification !== 'function') return;
      if (window.Notification.permission === 'default') {
        const result = window.Notification.requestPermission();
        if (result && typeof result.catch === 'function') result.catch(() => {});
      }
    } catch {
      /* уведомления недоступны — не мешаем работе */
    }
  }

  function maybeShowBookmarkNotification(bookmark, freshCount, data) {
    try {
      if (typeof window.Notification !== 'function') return;
      if (window.Notification.permission !== 'granted') return;
      if (!document.hidden) return;
      const now = Date.now();
      if (now - state.lastNotificationAt < BOOKMARK_NOTIFICATION_MIN_INTERVAL_MS) return;
      const first = data && Array.isArray(data.passed) && data.passed[0] ? data.passed[0] : null;
      const body = first && first.title
        ? first.title
        : `${freshCount} новых совпадений по закладке «${bookmark.name}»`;
      const notification = new window.Notification(BOOKMARK_NOTIFICATION_TITLE, {
        body,
        tag: 'oboz-bookmark',
      });
      state.lastNotificationAt = now;
      try {
        window.__obozLastNotification = { title: BOOKMARK_NOTIFICATION_TITLE, body, at: now };
      } catch {
        /* отладочный след не критичен */
      }
      notification.onclick = function () {
        try {
          window.focus();
        } catch {
          /* ignore */
        }
      };
    } catch {
      /* Notification может быть запрещён политикой браузера */
    }
  }

  function handleActiveBookmarkDigest(data) {
    const bookmark = getActiveBookmark();
    if (!bookmark || !state.query.length) return;
    const ids = state.events.map((event) => String(event.id || '')).filter(Boolean);
    if (!ids.length) return;
    const seen = new Set(bookmark.seenIds.map(String));
    const fresh = ids.filter((id) => !seen.has(id));
    if (!fresh.length) return;
    const updated = Object.assign({}, bookmark, {
      seenIds: bookmark.seenIds.concat(fresh).slice(-MAX_SEEN_IDS),
    });
    replaceBookmark(updated);
    state.bookmarkBadgeCount += fresh.length;
    updateBookmarkBadge();
    maybeShowBookmarkNotification(updated, fresh.length, data);
  }

  function showBookmarkError(message) {
    if (!dom.bookmarkError) return;
    dom.bookmarkError.textContent = message;
    dom.bookmarkError.hidden = false;
  }

  function clearBookmarkError() {
    if (!dom.bookmarkError) return;
    dom.bookmarkError.textContent = '';
    dom.bookmarkError.hidden = true;
  }

  function resetBookmarkForm() {
    state.bookmarkEditingId = null;
    state.bookmarkDraftEventId = null;
    if (dom.bookmarkName) dom.bookmarkName.value = '';
    if (dom.bookmarkKeywords) dom.bookmarkKeywords.value = '';
    populateFilterSelect(dom.bookmarkCategory, state.categoryOptions, ALL_FILTER);
    populateFilterSelect(dom.bookmarkCity, state.cityOptions, ALL_FILTER);
    if (dom.bookmarkFormTitle) dom.bookmarkFormTitle.textContent = 'Новая закладка';
    if (dom.bookmarkSubmit) dom.bookmarkSubmit.textContent = 'Сохранить';
    if (dom.bookmarkHint) dom.bookmarkHint.textContent = '1–6 слов через запятую; покажем события, где встречается любое из них.';
    clearBookmarkError();
  }

  function fillBookmarkForm(data) {
    const values = data || {};
    const keywords = normalizeQueryWords(values.keywords || []);
    const category = hasFilterOption(state.categoryOptions, values.category) ? values.category : ALL_FILTER;
    const city = hasFilterOption(state.cityOptions, values.city) ? values.city : ALL_FILTER;
    state.bookmarkEditingId = values.editingId || null;
    state.bookmarkDraftEventId = values.eventId || null;
    if (dom.bookmarkName) dom.bookmarkName.value = truncate(String(values.name || ''), MAX_BOOKMARK_NAME);
    if (dom.bookmarkKeywords) dom.bookmarkKeywords.value = keywords.join(', ');
    populateFilterSelect(dom.bookmarkCategory, state.categoryOptions, category);
    populateFilterSelect(dom.bookmarkCity, state.cityOptions, city);
    if (dom.bookmarkFormTitle) {
      dom.bookmarkFormTitle.textContent = state.bookmarkEditingId ? 'Редактировать закладку' : 'Новая закладка';
    }
    if (dom.bookmarkSubmit) dom.bookmarkSubmit.textContent = state.bookmarkEditingId ? 'Сохранить изменения' : 'Сохранить';
    clearBookmarkError();
  }

  function renderBookmarksList() {
    if (!dom.bookmarksList) return;
    clearNode(dom.bookmarksList);
    const bookmarks = state.bookmarks.slice().sort((left, right) => right.createdAt - left.createdAt);
    if (dom.bookmarksEmpty) dom.bookmarksEmpty.hidden = bookmarks.length > 0;
    bookmarks.forEach((bookmark) => {
      const item = el('div', `bookmark-item${bookmark.id === state.activeBookmarkId ? ' is-active' : ''}`);
      item.dataset.bookmarkId = bookmark.id;
      item.dataset.testid = 'bookmark-item';

      const main = el('div', 'bookmark-item-main');
      main.append(el('div', 'bookmark-item-title', bookmark.name));
      const meta = el(
        'div',
        'bookmark-item-meta',
        `${bookmark.keywords.join(', ')} · ${optionLabel(state.categoryOptions, bookmark.category)} · ${optionLabel(state.cityOptions, bookmark.city)}`,
      );
      main.append(meta);
      item.append(main);

      const actions = el('div', 'bookmark-item-actions');
      const open = el('button', 'bookmark-action', 'Открыть');
      open.type = 'button';
      open.dataset.action = 'open';
      open.dataset.bookmarkId = bookmark.id;
      open.dataset.testid = 'bookmark-open';
      open.setAttribute('aria-label', `Открыть закладку «${bookmark.name}»`);
      const remove = el('button', 'bookmark-action bookmark-action-danger', 'Удалить');
      remove.type = 'button';
      remove.dataset.action = 'delete';
      remove.dataset.bookmarkId = bookmark.id;
      remove.dataset.testid = 'bookmark-delete';
      remove.setAttribute('aria-label', `Удалить закладку «${bookmark.name}»`);
      actions.append(open, remove);
      item.append(actions);
      dom.bookmarksList.append(item);
    });
  }

  function openBookmarksDialog(options) {
    const opts = Object.assign({ prefill: null, source: 'header' }, options || {});
    if (!dom.bookmarksDialog) return;
    state.bookmarksSource = opts.source;
    resetBookmarksBadge();
    renderBookmarksList();
    if (opts.prefill) fillBookmarkForm(opts.prefill);
    else resetBookmarkForm();
    if (!dom.bookmarksDialog.open) {
      state.bookmarksReturnFocus = document.activeElement;
      try {
        dom.bookmarksDialog.showModal();
      } catch {
        dom.bookmarksDialog.setAttribute('open', '');
      }
    }
    if (dom.bookmarksClose) dom.bookmarksClose.focus();
  }

  function closeBookmarksDialog() {
    if (!dom.bookmarksDialog) return;
    if (dom.bookmarksDialog.open) dom.bookmarksDialog.close();
    else dom.bookmarksDialog.removeAttribute('open');
  }

  function applyBookmark(id) {
    const bookmark = state.bookmarks.find((item) => item.id === id);
    if (!bookmark) return;
    state.query = bookmark.keywords.slice();
    state.category = hasFilterOption(state.categoryOptions, bookmark.category) ? bookmark.category : ALL_FILTER;
    state.city = hasFilterOption(state.cityOptions, bookmark.city) ? bookmark.city : ALL_FILTER;
    if (state.city !== ALL_FILTER) state.region = 'ru';
    state.activeBookmarkId = bookmark.id;
    persistActiveBookmarkId(bookmark.id);
    state.selectedIndex = 0;
    requestNotificationPermission();
    closeBookmarksDialog();
    if (state.view === 'detail') leaveDetailToList();
    syncControls();
    syncUrl();
    updateActiveBookmarkChip();
    hideListError();
    setStatus(`закладка «${bookmark.name}» — загружаю сводку…`);
    loadDigest({ reason: 'bookmark' });
  }

  function resetBookmarkFilter() {
    const wasActive = Boolean(state.activeBookmarkId) || state.query.length > 0;
    state.query = [];
    state.activeBookmarkId = null;
    persistActiveBookmarkId(null);
    state.category = ALL_FILTER;
    state.city = ALL_FILTER;
    state.selectedIndex = 0;
    if (state.view === 'detail') leaveDetailToList();
    syncControls();
    syncUrl();
    updateActiveBookmarkChip();
    if (wasActive) {
      hideListError();
      setStatus('закладка сброшена');
      loadDigest({ reason: 'bookmark-reset' });
    }
  }

  function deleteBookmark(id) {
    const bookmark = state.bookmarks.find((item) => item.id === id);
    if (!bookmark) return;
    const wasActive = state.activeBookmarkId === id;
    state.bookmarks = state.bookmarks.filter((item) => item.id !== id);
    saveBookmarks();
    if (state.bookmarkEditingId === id) resetBookmarkForm();
    if (wasActive) {
      state.activeBookmarkId = null;
      persistActiveBookmarkId(null);
    }
    renderBookmarksList();
    updateActiveBookmarkChip();
    if (state.detail) updateSaveBookmarkButton();
    if (wasActive) {
      state.query = [];
      state.category = ALL_FILTER;
      state.city = ALL_FILTER;
      if (state.view === 'detail') leaveDetailToList();
      syncControls();
      syncUrl();
      loadDigest({ reason: 'bookmark-deleted' });
    }
    setStatus(`закладка «${bookmark.name}» удалена`);
  }

  function saveBookmarkForm() {
    if (!dom.bookmarkKeywords) return false;
    const rawKeywords = String(dom.bookmarkKeywords.value || '')
      .split(',')
      .map((word) => word.trim())
      .filter(Boolean);
    if (!rawKeywords.length) {
      showBookmarkError('Добавьте хотя бы одно ключевое слово.');
      dom.bookmarkKeywords.focus();
      return false;
    }
    if (rawKeywords.length > MAX_BOOKMARK_KEYWORDS) {
      showBookmarkError('Можно сохранить не больше 6 слов.');
      dom.bookmarkKeywords.focus();
      return false;
    }
    const keywords = normalizeQueryWords(rawKeywords);
    if (!keywords.length) {
      showBookmarkError('Ключевые слова не распознаны.');
      return false;
    }
    const name = dom.bookmarkName && dom.bookmarkName.value.trim()
      ? truncate(dom.bookmarkName.value.trim(), MAX_BOOKMARK_NAME)
      : keywords.join(', ');
    const category = hasFilterOption(state.categoryOptions, dom.bookmarkCategory && dom.bookmarkCategory.value)
      ? dom.bookmarkCategory.value
      : ALL_FILTER;
    const city = hasFilterOption(state.cityOptions, dom.bookmarkCity && dom.bookmarkCity.value)
      ? dom.bookmarkCity.value
      : ALL_FILTER;
    const eventId = state.bookmarkDraftEventId || null;

    if (state.bookmarkEditingId) {
      const existing = state.bookmarks.find((item) => item.id === state.bookmarkEditingId);
      if (existing) {
        replaceBookmark(Object.assign({}, existing, {
          name,
          keywords,
          category,
          city,
          eventId: existing.eventId || eventId,
        }));
      }
    } else {
      state.bookmarks.push({
        id: generateBookmarkId(),
        name,
        keywords,
        category,
        city,
        createdAt: Date.now(),
        seenIds: [],
        eventId,
      });
      saveBookmarks();
    }

    requestNotificationPermission();
    state.bookmarkEditingId = null;
    state.bookmarkDraftEventId = null;
    renderBookmarksList();
    updateActiveBookmarkChip();
    if (state.detail) updateSaveBookmarkButton();
    setStatus(`закладка «${name}» сохранена`);
    resetBookmarkForm();
    return true;
  }

  function saveCurrentEventBookmark() {
    const event = state.detail;
    if (!event || !event.id) return;
    requestNotificationPermission();
    const existing = findBookmarkForEvent(event);
    const title = event.title || 'Без заголовка';
    const keywords = existing ? existing.keywords.slice() : keywordsFromTitle(title);
    const category = existing
      ? existing.category
      : (Array.isArray(event.topics) && event.topics.length ? event.topics[0] : ALL_FILTER);
    const city = existing
      ? existing.city
      : (Array.isArray(event.cities) && event.cities.length ? event.cities[0] : ALL_FILTER);
    openBookmarksDialog({
      source: 'event',
      prefill: {
        name: existing ? existing.name : truncate(title, MAX_BOOKMARK_NAME),
        keywords,
        category,
        city,
        editingId: existing ? existing.id : null,
        eventId: String(event.id),
      },
    });
  }

  function updateSaveBookmarkButton() {
    if (!dom.saveBookmark) return;
    const event = state.detail;
    if (!event || state.view !== 'detail') {
      dom.saveBookmark.hidden = true;
      return;
    }
    const saved = findBookmarkForEvent(event);
    dom.saveBookmark.hidden = false;
    dom.saveBookmark.textContent = saved ? '★ в закладках' : '☆ в закладки';
    dom.saveBookmark.setAttribute('aria-pressed', saved ? 'true' : 'false');
    dom.saveBookmark.setAttribute('aria-label', saved ? 'Новость уже в закладках' : 'Сохранить новость в закладки');
  }

  function formatNumberValue(value, unit) {
    const text = String(value === undefined || value === null ? '' : value).replace('.', ',');
    const suffix = unit ? ` ${unit}` : '';
    return `${text}${suffix}`;
  }

  function pluralizeNumber(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '—';
    try {
      return new Intl.NumberFormat('ru-RU').format(n);
    } catch {
      return String(n);
    }
  }

  function pad2(value) {
    return String(value).padStart(2, '0');
  }

  function formatClock(timestamp) {
    const ts = Number(timestamp);
    if (!Number.isFinite(ts) || ts <= 0) return '—';
    if (state.timeFormat) {
      try {
        return state.timeFormat.format(new Date(ts));
      } catch {
        /* ниже — ручной фолбэк */
      }
    }
    const date = new Date(ts);
    if (Number.isNaN(date.getTime())) return '—';
    return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
  }

  function formatClockSeconds(timestamp) {
    const ts = Number(timestamp);
    if (!Number.isFinite(ts) || ts <= 0) return '—';
    if (state.secondsFormat) {
      try {
        return state.secondsFormat.format(new Date(ts));
      } catch {
        /* ниже — ручной фолбэк */
      }
    }
    const date = new Date(ts);
    if (Number.isNaN(date.getTime())) return '—';
    return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
  }

  function formatDate(timestamp) {
    const date = new Date(Number(timestamp));
    if (Number.isNaN(date.getTime())) return '—';
    return `${pad2(date.getDate())}.${pad2(date.getMonth() + 1)}.${date.getFullYear()}`;
  }

  function relativeTime(timestamp) {
    const ts = Number(timestamp);
    if (!Number.isFinite(ts) || ts <= 0) return 'время неизвестно';
    let diffSec = Math.round((ts - Date.now()) / 1000);
    if (diffSec > 0) diffSec = 0;
    const abs = Math.abs(diffSec);
    if (abs < 45) return 'только что';
    if (abs < 3600) {
      const minutes = Math.max(1, Math.round(abs / 60));
      if (state.relativeFormat) {
        try {
          return state.relativeFormat.format(-minutes, 'minute');
        } catch {
          /* фолбэк ниже */
        }
      }
      return `${minutes} ${plural(minutes, 'минуту', 'минуты', 'минут')} назад`;
    }
    if (abs < 86400) {
      const hours = Math.max(1, Math.round(abs / 3600));
      if (state.relativeFormat) {
        try {
          return state.relativeFormat.format(-hours, 'hour');
        } catch {
          /* фолбэк ниже */
        }
      }
      return `${hours} ${plural(hours, 'час', 'часа', 'часов')} назад`;
    }
    if (abs < 86400 * 8) {
      const days = Math.max(1, Math.round(abs / 86400));
      if (state.relativeFormat) {
        try {
          return state.relativeFormat.format(-days, 'day');
        } catch {
          /* фолбэк ниже */
        }
      }
      return `${days} ${plural(days, 'день', 'дня', 'дней')} назад`;
    }
    return formatDate(ts);
  }

  function truncate(text, max) {
    const value = String(text || '');
    if (value.length <= max) return value;
    return `${value.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
  }

  function safeExternalUrl(raw) {
    if (typeof raw !== 'string') return null;
    const value = raw.trim();
    if (!value) return null;
    try {
      const url = new URL(value, document.baseURI);
      if (url.protocol === 'http:' || url.protocol === 'https:') return url.href;
    } catch {
      /* некорректный URL — не отдаём ссылку */
    }
    return null;
  }

  function isAbortError(error) {
    return Boolean(error && (error.name === 'AbortError' || error.name === 'TimeoutError'));
  }

  function describeError(error) {
    if (!error) return 'неизвестная ошибка';
    if (Number.isFinite(error.status)) return error.message || `HTTP ${error.status}`;
    if (error.name === 'TypeError') return 'нет связи с сервером';
    return error.message || 'неизвестная ошибка';
  }

  function readEventIdFromHash(hash) {
    const match = /^#\/event\/([A-Za-z0-9_-]{1,64})$/.exec(String(hash || ''));
    if (!match) return null;
    try {
      return decodeURIComponent(match[1]);
    } catch {
      return match[1];
    }
  }

  // ---------------------------------------------------------------------------
  // URL и история
  // ---------------------------------------------------------------------------

  function readFilterId(value, fallback) {
    if (typeof value !== 'string') return fallback;
    const id = value.trim();
    return /^[a-z0-9-]{1,32}$/.test(id) ? id : fallback;
  }

  // ---------------------------------------------------------------------------
  // Закладки: localStorage oboz-bookmarks-v1
  // ---------------------------------------------------------------------------

  function normalizeQueryWords(value) {
    const rawList = Array.isArray(value) ? value : String(value || '').split(',');
    const words = [];
    const seen = new Set();
    for (const raw of rawList) {
      const word = String(raw || '').trim();
      if (!word) continue;
      const key = word.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      words.push(word);
      if (words.length >= MAX_BOOKMARK_KEYWORDS) break;
    }
    return words;
  }

  function queryKey(words) {
    return normalizeQueryWords(words)
      .map((word) => word.toLowerCase())
      .sort()
      .join('|');
  }

  function sameQuery(left, right) {
    return queryKey(left) === queryKey(right);
  }

  function readStoredActiveBookmarkId() {
    try {
      const value = window.localStorage.getItem(ACTIVE_BOOKMARK_KEY);
      return typeof value === 'string' && value ? value : null;
    } catch {
      return null;
    }
  }

  function persistActiveBookmarkId(id) {
    try {
      if (id) window.localStorage.setItem(ACTIVE_BOOKMARK_KEY, id);
      else window.localStorage.removeItem(ACTIVE_BOOKMARK_KEY);
    } catch {
      /* приватный режим — закладки живут до перезагрузки */
    }
  }

  function generateBookmarkId() {
    return `bm_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  }

  function normalizeBookmark(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const keywords = normalizeQueryWords(raw.keywords);
    if (!keywords.length) return null;
    const name = typeof raw.name === 'string' && raw.name.trim()
      ? truncate(raw.name.trim(), MAX_BOOKMARK_NAME)
      : keywords.join(', ');
    const category = typeof raw.category === 'string' && raw.category
      ? readFilterId(raw.category, ALL_FILTER)
      : ALL_FILTER;
    const city = typeof raw.city === 'string' && raw.city ? readFilterId(raw.city, ALL_FILTER) : ALL_FILTER;
    const createdAt = Number.isFinite(Number(raw.createdAt)) ? Number(raw.createdAt) : Date.now();
    const seenIds = Array.isArray(raw.seenIds)
      ? raw.seenIds.filter((id) => typeof id === 'string' && id).slice(-MAX_SEEN_IDS)
      : [];
    return {
      id: typeof raw.id === 'string' && raw.id ? raw.id : generateBookmarkId(),
      name,
      keywords,
      category,
      city,
      createdAt,
      seenIds,
      eventId: typeof raw.eventId === 'string' && raw.eventId ? raw.eventId : null,
    };
  }

  function readBookmarks() {
    try {
      const raw = JSON.parse(window.localStorage.getItem(BOOKMARKS_KEY) || '[]');
      if (!Array.isArray(raw)) return [];
      return raw.map(normalizeBookmark).filter(Boolean);
    } catch {
      return [];
    }
  }

  function saveBookmarks() {
    try {
      window.localStorage.setItem(BOOKMARKS_KEY, JSON.stringify(state.bookmarks));
    } catch {
      /* без localStorage закладки работают до перезагрузки */
    }
  }

  function replaceBookmark(bookmark) {
    state.bookmarks = state.bookmarks.map((item) => (item.id === bookmark.id ? bookmark : item));
    saveBookmarks();
  }

  function getActiveBookmark() {
    return state.bookmarks.find((bookmark) => bookmark.id === state.activeBookmarkId) || null;
  }

  function findBookmarkForQuery(words) {
    const key = queryKey(words);
    return state.bookmarks.find((bookmark) => queryKey(bookmark.keywords) === key) || null;
  }

  function findBookmarkForEvent(event) {
    if (!event || !event.id) return null;
    return state.bookmarks.find((bookmark) => bookmark.eventId === String(event.id)) || null;
  }

  function readUrlState() {
    let region = DEFAULT_REGION;
    let threshold = DEFAULT_THRESHOLD;
    let category = ALL_FILTER;
    let city = ALL_FILTER;
    let query = [];
    let eventId = null;
    try {
      const params = new URLSearchParams(window.location.search);
      const regionParam = params.get('region');
      if (REGIONS.includes(regionParam)) region = regionParam;
      if (params.has('threshold')) threshold = normalizeThreshold(params.get('threshold'));
      category = readFilterId(params.get('category'), ALL_FILTER);
      city = readFilterId(params.get('city'), ALL_FILTER);
      query = normalizeQueryWords(params.get('q'));
      if (city !== ALL_FILTER) region = 'ru';
      eventId = readEventIdFromHash(window.location.hash);
    } catch {
      /* некорректный URL — дефолты */
    }
    return { region, threshold, category, city, query, eventId };
  }

  function buildUrl(hash) {
    const params = new URLSearchParams();
    params.set('region', state.region);
    params.set('threshold', state.threshold.toFixed(2));
    params.set('category', state.category);
    params.set('city', state.city);
    if (state.query.length) params.set('q', state.query.join(','));
    return `${window.location.pathname}?${params.toString()}${hash || ''}`;
  }

  function syncUrl() {
    const hash = state.view === 'detail' && state.detailId ? `#/event/${encodeURIComponent(state.detailId)}` : '';
    try {
      window.history.replaceState(
        { view: state.view, id: state.detailId || null },
        '',
        buildUrl(hash),
      );
    } catch {
      /* history может быть недоступен — интерфейс продолжает работать */
    }
  }

  // ---------------------------------------------------------------------------
  // Сеть (только относительные api/* — работает и под префиксом /oboz/)
  // ---------------------------------------------------------------------------

  async function fetchJson(url, signal) {
    let response;
    try {
      response = await fetch(url, {
        signal,
        cache: 'no-store',
        headers: { Accept: 'application/json' },
      });
    } catch (error) {
      if (isAbortError(error)) throw error;
      const networkError = new Error('нет связи с сервером');
      networkError.cause = error;
      throw networkError;
    }
    if (!response.ok) {
      let message = `HTTP ${response.status}`;
      try {
        const body = await response.json();
        if (body && typeof body.error === 'string' && body.error) message = body.error;
      } catch {
        /* тело не JSON */
      }
      const httpError = new Error(message);
      httpError.status = response.status;
      throw httpError;
    }
    try {
      return await response.json();
    } catch {
      throw new Error('сервер вернул некорректный JSON');
    }
  }

  // ---------------------------------------------------------------------------
  // Загрузка сводки
  // ---------------------------------------------------------------------------

  function loadDigest(options) {
    const opts = Object.assign({ refresh: false, silent: false, reason: 'manual' }, options || {});
    state.lastDigestOpts = opts;

    const token = ++state.digestToken;
    if (state.digestController) state.digestController.abort();
    const controller = new AbortController();
    state.digestController = controller;

    const requestedRegion = state.region;
    const requestedThreshold = state.threshold;
    const requestedCategory = state.category;
    const requestedCity = state.city;
    const requestedQuery = state.query.slice();

    state.loading = true;
    dom.refreshButton.disabled = true;
    dom.refreshButton.classList.add('is-loading');
    dom.eventList.setAttribute('aria-busy', 'true');

    if (!state.data) {
      dom.listSkeleton.hidden = false;
      dom.eventList.hidden = true;
      dom.emptyState.hidden = true;
    }

    if (!opts.silent) {
      setStatus(opts.refresh ? 'обновляю сводку — сервер пересчитывает ленты…' : 'загружаю сводку…');
    }

    const params = new URLSearchParams();
    params.set('region', requestedRegion);
    params.set('threshold', requestedThreshold.toFixed(2));
    params.set('limit', String(EVENTS_LIMIT));
    params.set('category', requestedCategory);
    params.set('city', requestedCity);
    if (requestedQuery.length) params.set('q', requestedQuery.join(','));
    if (opts.refresh) params.set('refresh', '1');

    return fetchJson(`api/digest?${params.toString()}`, controller.signal)
      .then((data) => {
        if (token !== state.digestToken) return;
        applyDigest(data, { requestedRegion, requestedThreshold, requestedCategory, requestedCity, requestedQuery });
        hideListError();
      })
      .catch((error) => {
        if (token !== state.digestToken || isAbortError(error)) return;
        handleDigestError(error, opts);
      })
      .finally(() => {
        if (token !== state.digestToken) return;
        state.loading = false;
        dom.refreshButton.disabled = false;
        dom.refreshButton.classList.remove('is-loading');
        dom.eventList.setAttribute('aria-busy', 'false');
        if (!state.data && dom.eventList.hidden) dom.listSkeleton.hidden = true;
      });
  }

  function applyDigest(data, requested) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error('сервер вернул неожиданный ответ');
    }

    state.data = data;
    state.events = Array.isArray(data.passed) ? data.passed.filter((event) => event && typeof event === 'object') : [];
    state.rejected = Array.isArray(data.rejected) ? data.rejected.filter(Boolean) : [];
    state.stats = data.stats && typeof data.stats === 'object' ? data.stats : null;
    state.meta = data.meta && typeof data.meta === 'object' ? data.meta : null;
    state.lastLoadAt = Date.now();

    if (REGIONS.includes(data.region) && data.region === requested.requestedRegion) {
      state.region = data.region;
    }
    const serverThreshold = Number(data.threshold);
    if (Number.isFinite(serverThreshold) && Math.abs(serverThreshold - requested.requestedThreshold) < 0.001) {
      state.threshold = normalizeThreshold(serverThreshold);
    }

    const meta = state.meta && typeof state.meta === 'object' ? state.meta : null;
    const categories = normalizeFilterOptions(meta && meta.categories, FALLBACK_CATEGORIES);
    const cities = normalizeFilterOptions(meta && meta.cities, FALLBACK_CITIES);
    const signature = filterSignature(categories, cities);
    if (signature !== state.filterSignature) {
      state.categoryOptions = categories;
      state.cityOptions = cities;
      state.filterSignature = signature;
      rebuildFilterSelects();
    }

    const serverCategory = typeof data.category === 'string' ? data.category : null;
    const serverCity = typeof data.city === 'string' ? data.city : null;
    if (serverCategory && serverCategory === requested.requestedCategory && hasFilterOption(categories, serverCategory)) {
      state.category = serverCategory;
    } else if (!hasFilterOption(categories, state.category)) {
      state.category = ALL_FILTER;
    }
    if (serverCity && serverCity === requested.requestedCity && hasFilterOption(cities, serverCity)) {
      state.city = serverCity;
    } else if (!hasFilterOption(cities, state.city)) {
      state.city = ALL_FILTER;
    }
    if (state.city !== ALL_FILTER) state.region = 'ru';

    const serverQuery = normalizeQueryWords(data.query);
    if (requested.requestedQuery.length && sameQuery(serverQuery, requested.requestedQuery)) {
      state.query = serverQuery;
    } else if (!requested.requestedQuery.length) {
      state.query = [];
    }

    if (state.selectedIndex >= state.events.length) {
      state.selectedIndex = Math.max(0, state.events.length - 1);
    }
    if (state.selectedIndex < 0) state.selectedIndex = 0;

    dom.listSkeleton.hidden = true;
    dom.refreshButton.disabled = false;
    dom.refreshButton.classList.remove('is-loading');
    syncControls();
    syncUrl();
    updateHeader();
    updateActiveBookmarkChip();
    handleActiveBookmarkDigest(data);
    if (state.view === 'detail' && state.detail) updateSaveBookmarkButton();

    if (state.view === 'list') {
      renderList();
      setStatus(
        `регион ${REGION_LABELS[state.region]} · порог ${state.threshold.toFixed(2)}${activeFilterSuffix()}`,
      );
    }
  }

  function handleDigestError(error, opts) {
    const message = describeError(error);
    setStatus(`ошибка загрузки: ${message}`, true);
    if (!state.data) {
      dom.listSkeleton.hidden = true;
      dom.eventList.hidden = true;
      dom.emptyState.hidden = true;
    }
    if (state.data && opts.silent) return;
    showListError(
      `Не удалось загрузить сводку: ${message}. Проверьте, что сервер «Обозревателя» запущен, и повторите.`,
    );
  }

  // ---------------------------------------------------------------------------
  // Шапка
  // ---------------------------------------------------------------------------

  function setStatus(text, isError) {
    dom.statusLine.textContent = text || '';
    dom.statusLine.classList.toggle('is-error', Boolean(isError));
  }

  function appendStat(container, label, value, extraClass) {
    if (container.childNodes.length) container.append(el('span', 'stat-sep', ' · '));
    const wrap = el('span', null);
    wrap.append(document.createTextNode(`${label} `));
    wrap.append(el('span', `stat-value${extraClass ? ` ${extraClass}` : ''}`, value));
    container.append(wrap);
  }

  function updateHeader() {
    const stats = state.stats || {};
    const demo = Boolean(stats.demo);
    clearNode(dom.digestStats);

    const sourcesTotal = Number.isFinite(Number(stats.sourcesTotal)) ? Number(stats.sourcesTotal) : null;
    const sourcesOk = Number.isFinite(Number(stats.sourcesOk)) ? Number(stats.sourcesOk) : null;
    const sourcesText = sourcesOk !== null || sourcesTotal !== null
      ? `${sourcesOk !== null ? sourcesOk : '—'}/${sourcesTotal !== null ? sourcesTotal : '—'}`
      : '—';

    if (demo) {
      appendStat(dom.digestStats, 'источники', 'демо-набор');
    } else {
      appendStat(dom.digestStats, 'источников', sourcesText);
    }
    const filtersActive = state.category !== ALL_FILTER || state.city !== ALL_FILTER || state.query.length > 0;
    const matchedEvents = Number(stats.events);
    const allEventsCount = Number(stats.allEvents);
    const eventsValue = filtersActive && Number.isFinite(matchedEvents) && Number.isFinite(allEventsCount)
      ? `${pluralizeNumber(matchedEvents)} из ${pluralizeNumber(allEventsCount)}`
      : pluralizeNumber(stats.events);

    appendStat(dom.digestStats, 'публикаций', pluralizeNumber(stats.articlesUsed));
    appendStat(dom.digestStats, 'событий', eventsValue);
    appendStat(dom.digestStats, 'прошло', pluralizeNumber(stats.passed));

    const failed = Number(stats.sourcesFailed);
    if (!demo && Number.isFinite(failed) && failed > 0) {
      appendStat(dom.digestStats, 'лент недоступно', pluralizeNumber(failed), 'stat-warn');
    }

    dom.demoBadge.hidden = !demo;
    dom.liveBadge.hidden = demo;

    const generatedAt = Number(state.data && state.data.generatedAt);
    dom.lastUpdated.textContent = Number.isFinite(generatedAt)
      ? `обновлено ${formatClockSeconds(generatedAt)}`
      : 'обновлено —';
  }

  function syncControls() {
    dom.thresholdRange.value = state.threshold.toFixed(2);
    dom.thresholdValue.textContent = state.threshold.toFixed(2);
    dom.thresholdRange.setAttribute('aria-valuetext', state.threshold.toFixed(2));
    if (dom.categorySelect) dom.categorySelect.value = state.category;
    if (dom.citySelect) dom.citySelect.value = state.city;
    dom.regionButtons.forEach((button) => {
      const active = button.dataset.region === state.region;
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
  }

  // ---------------------------------------------------------------------------
  // Список событий
  // ---------------------------------------------------------------------------

  function uniqueSourceNames(event, limit) {
    const names = [];
    const seen = new Set();
    const articles = Array.isArray(event.articles) ? event.articles : [];
    for (const article of articles) {
      const name = article && (article.sourceName || article.sourceId);
      if (!name || seen.has(name)) continue;
      seen.add(name);
      names.push(String(name));
      if (limit && names.length >= limit) break;
    }
    if (!names.length && Array.isArray(event.domains)) {
      for (const domain of event.domains) {
        if (!domain || seen.has(domain)) continue;
        seen.add(domain);
        names.push(String(domain));
        if (limit && names.length >= limit) break;
      }
    }
    return { names, total: Math.max(names.length, Array.isArray(event.domains) ? event.domains.length : 0) };
  }

  function countSources(event) {
    if (Array.isArray(event.domains) && event.domains.length) return event.domains.length;
    const names = new Set();
    if (Array.isArray(event.articles)) {
      for (const article of event.articles) {
        const name = article && (article.sourceName || article.sourceId);
        if (name) names.add(name);
      }
    }
    return names.size;
  }

  function buildEventItem(event, index) {
    const li = el('li', 'event-item');
    li.setAttribute('role', 'presentation');

    const card = el('button', 'event-card');
    card.type = 'button';
    card.dataset.eventId = String(event.id || '');
    card.dataset.index = String(index);
    card.dataset.testid = 'event-card';
    card.setAttribute('role', 'option');
    card.setAttribute('aria-selected', 'false');
    card.tabIndex = -1;
    card.setAttribute('aria-label', `${scoreAriaLabel(event.score)}. ${event.title || 'Без заголовка'}`);

    const scoreWrap = el('span', 'event-score-wrap');
    const score = el('span', `event-score ${scoreBand(event.score)}`, formatScore100(event.score));
    score.dataset.testid = 'event-score';
    score.setAttribute('aria-label', scoreAriaLabel(event.score));
    score.title = scoreAriaLabel(event.score);
    const scoreSep = el('span', 'event-score-sep', '|');
    scoreSep.setAttribute('aria-hidden', 'true');
    scoreWrap.append(score, scoreSep);

    const main = el('span', 'event-main');

    const head = el('span', 'event-head');
    if (event.attribution && event.attribution.official) {
      const official = el('span', 'official-badge', 'официальный первоисточник');
      official.dataset.testid = 'official-badge';
      head.append(official);
    }
    if (Array.isArray(event.conflicts) && event.conflicts.length) {
      const conflict = el('span', 'conflict-badge', 'расхождения в цифрах');
      conflict.dataset.testid = 'conflict-badge';
      head.append(conflict);
    }

    const title = el('span', 'event-title', event.title || 'Без заголовка');
    title.dataset.testid = 'event-title';

    const summary = el('span', 'event-summary', event.summary || '');
    summary.dataset.testid = 'event-summary';

    const meta = el('span', 'event-meta');
    meta.dataset.testid = 'event-meta';

    const sources = uniqueSourceNames(event, 4);
    if (sources.names.length) {
      const chips = el('span', 'event-source-chips');
      sources.names.forEach((name) => {
        const chip = el('span', 'source-chip', name);
        chip.dataset.testid = 'source-chip';
        chips.append(chip);
      });
      if (sources.total > sources.names.length) {
        chips.append(el('span', 'source-chip source-chip-more', `+${sources.total - sources.names.length}`));
      }
      meta.append(chips);
      meta.append(el('span', 'event-dot', '·'));
    }

    const sourceCount = countSources(event);
    if (sourceCount) {
      const count = el(
        'span',
        'event-source-count',
        `${sourceCount} ${plural(sourceCount, 'источник', 'источника', 'источников')}`,
      );
      count.dataset.testid = 'event-domain-count';
      meta.append(count);
      meta.append(el('span', 'event-dot', '·'));
    }

    const ageValue = Number.isFinite(Number(event.latestAt)) ? event.latestAt : event.publishedAt;
    const age = el('span', 'event-age', relativeTime(ageValue));
    age.dataset.testid = 'event-age';
    meta.append(age);

    const claimsCount = Array.isArray(event.claims) ? event.claims.length : 0;
    if (claimsCount) {
      meta.append(el('span', 'event-dot', '·'));
      meta.append(
        el(
          'span',
          'event-claims',
          `${claimsCount} ${plural(claimsCount, 'тезис', 'тезиса', 'тезисов')}`,
        ),
      );
    }

    main.append(head, title);
    if (event.summary) main.append(summary);
    main.append(meta);
    card.append(scoreWrap, main, el('span', 'event-arrow', '▸'));
    li.append(card);
    return li;
  }

  function renderList() {
    dom.listSkeleton.hidden = true;

    if (!state.data) {
      dom.emptyState.hidden = true;
      dom.eventList.hidden = true;
      if (!state.loading) loadDigest({ reason: 'list' });
      else dom.listSkeleton.hidden = false;
      return;
    }

    if (!state.events.length) {
      showEmptyState();
      return;
    }

    const hadFocus = dom.eventList.contains(document.activeElement);
    const focusedCard = document.activeElement && document.activeElement.closest
      ? document.activeElement.closest('.event-card')
      : null;
    const focusedId = focusedCard ? focusedCard.dataset.eventId : null;

    dom.emptyState.hidden = true;
    dom.eventList.hidden = false;
    if (dom.resetFilters) dom.resetFilters.hidden = true;
    clearNode(dom.eventList);

    state.events.forEach((event, index) => {
      dom.eventList.append(buildEventItem(event, index));
    });

    applySelection({ focus: false });

    if (hadFocus) {
      const byId = focusedId ? findCardById(focusedId) : null;
      if (byId) byId.focus();
      else focusSelectedCard();
    }
  }

  function findCardById(id) {
    if (!id) return null;
    const cards = dom.eventList.querySelectorAll('.event-card');
    for (const card of cards) {
      if (card.dataset.eventId === id) return card;
    }
    return null;
  }

  function applySelection(options) {
    const opts = Object.assign({ focus: false }, options || {});
    const cards = dom.eventList.querySelectorAll('.event-card');
    cards.forEach((card, index) => {
      const selected = index === state.selectedIndex;
      card.classList.toggle('is-selected', selected);
      card.setAttribute('aria-selected', selected ? 'true' : 'false');
      card.tabIndex = selected ? 0 : -1;
    });
    if (opts.focus) focusSelectedCard();
  }

  function focusSelectedCard() {
    const cards = dom.eventList.querySelectorAll('.event-card');
    const card = cards[state.selectedIndex];
    if (!card) return;
    card.focus({ preventScroll: false });
    if (typeof card.scrollIntoView === 'function') {
      card.scrollIntoView({ block: 'nearest' });
    }
  }

  function moveSelection(delta) {
    if (!state.events.length) return;
    const next = clampNumber(state.selectedIndex + delta, 0, state.events.length - 1);
    if (next === state.selectedIndex) {
      focusSelectedCard();
      return;
    }
    state.selectedIndex = next;
    applySelection({ focus: true });
  }

  function focusEventCard(id) {
    const index = state.events.findIndex((event) => String(event.id) === String(id));
    if (index >= 0) {
      state.selectedIndex = index;
      applySelection({ focus: false });
      focusSelectedCard();
      return;
    }
    focusSelectedCard();
  }

  function showEmptyState() {
    clearNode(dom.eventList);
    dom.eventList.hidden = true;
    dom.emptyState.hidden = false;

    const stats = state.stats || {};
    const sourcesTotal = Number.isFinite(Number(stats.sourcesTotal)) ? Number(stats.sourcesTotal) : null;
    const sourcesOk = Number.isFinite(Number(stats.sourcesOk)) ? Number(stats.sourcesOk) : null;
    const articles = Number.isFinite(Number(stats.articlesUsed)) ? Number(stats.articlesUsed) : null;
    const events = Number.isFinite(Number(stats.events)) ? Number(stats.events) : null;

    const filtersActive = state.category !== ALL_FILTER || state.city !== ALL_FILTER || state.query.length > 0;
    const bookmarkActive = state.query.length > 0;
    const allEvents = Number.isFinite(Number(stats.allEvents)) ? Number(stats.allEvents) : null;
    const matchedEvents = events !== null ? events : 0;

    const parts = [];
    if (stats.demo) {
      parts.push('демо-набор');
    } else {
      const sourceCount = sourcesTotal !== null ? sourcesTotal : sourcesOk;
      if (sourceCount !== null) {
        parts.push(
          `${pluralizeNumber(sourceCount)} ${plural(sourceCount, 'источник', 'источника', 'источников')}`,
        );
      }
    }
    if (articles !== null) parts.push(`${pluralizeNumber(articles)} ${plural(articles, 'публикация', 'публикации', 'публикаций')}`);
    if (filtersActive && allEvents !== null) {
      parts.push(`${pluralizeNumber(allEvents)} ${plural(allEvents, 'событие', 'события', 'событий')}`);
    } else if (events !== null) {
      parts.push(`${pluralizeNumber(events)} ${plural(events, 'событие', 'события', 'событий')}`);
    }

    let checked = parts.length ? `Проверено ${parts.join(', ')}. ` : '';
    if (filtersActive && allEvents !== null) {
      checked = parts.length
        ? `Проверено ${parts.join(', ')}; по фильтрам совпало ${pluralizeNumber(matchedEvents)}. `
        : `По фильтрам совпало ${pluralizeNumber(matchedEvents)}. `;
    }
    if (bookmarkActive) {
      const bookmark = getActiveBookmark();
      const label = bookmark ? bookmark.name : state.query.join(', ');
      const bookmarkPhrase = bookmark ? `По закладке «${label}»` : `По поиску «${label}»`;
      dom.emptyDetail.textContent =
        `${checked}${bookmarkPhrase} ничего не произошло выше порога ${state.threshold.toFixed(2)}. ` +
        'Сбросьте закладку или снизьте порог — но тогда в список попадёт менее подтверждённое.';
    } else if (filtersActive) {
      const filterParts = [];
      if (state.category !== ALL_FILTER) {
        filterParts.push(`теме «${optionLabel(state.categoryOptions, state.category)}»`);
      }
      if (state.city !== ALL_FILTER) {
        filterParts.push(`городе «${optionLabel(state.cityOptions, state.city)}»`);
      }
      const scope = filterParts.length ? `В ${filterParts.join(' и ')}` : '';
      dom.emptyDetail.textContent =
        `${checked}${scope} ничего не произошло выше порога ${state.threshold.toFixed(2)}. ` +
        'Сбросьте фильтры или снизьте порог — но тогда в список попадёт менее подтверждённое.';
    } else {
      dom.emptyDetail.textContent =
        `${checked}Ни одно событие не превысило порог ${state.threshold.toFixed(2)}. ` +
        'Порог можно снизить — но тогда в список попадёт менее подтверждённое.';
    }
    dom.resetFilters.hidden = !filtersActive;

    const atMinimum = state.threshold <= MIN_THRESHOLD + 0.0001;
    dom.lowerThreshold.disabled = atMinimum;
    dom.lowerThreshold.textContent = atMinimum
      ? 'порог уже минимальный (0.30)'
      : `снизить порог до ${normalizeThreshold(state.threshold - THRESHOLD_STEP).toFixed(2)}`;

    renderRejected();
  }

  function renderRejected() {
    clearNode(dom.rejectedList);
    const rejected = state.rejected.slice(0, 6);
    if (!rejected.length) {
      dom.rejectedBlock.hidden = true;
      return;
    }
    dom.rejectedBlock.hidden = false;
    rejected.forEach((item) => {
      const li = el('li', 'rejected-item');
      const score = el('span', 'rejected-score', formatScore100(item.score));
      const text = el('span', 'rejected-text', item.title || '(без заголовка)');
      if (typeof item.score === 'number') score.title = 'оценка ниже порога';
      const reasons = Array.isArray(item.reasons) ? item.reasons.filter(Boolean) : [];
      if (reasons.length) {
        text.append(el('span', 'rejected-reason', ` — ${reasons.join('; ')}`));
      }
      li.append(score, text);
      dom.rejectedList.append(li);
    });
  }

  function showListError(message) {
    dom.errorText.textContent = message;
    dom.errorBanner.hidden = false;
  }

  function hideListError() {
    dom.errorBanner.hidden = true;
    dom.errorText.textContent = '';
  }

  // ---------------------------------------------------------------------------
  // Досье
  // ---------------------------------------------------------------------------

  function openEvent(id, options) {
    const opts = Object.assign({ push: true }, options || {});
    if (!id || state.view === 'detail' && state.detailId === id) return;

    state.view = 'detail';
    state.detailId = id;
    state.detail = null;
    state.detailEntryPushed = Boolean(opts.push);

    dom.listView.hidden = true;
    dom.detailView.hidden = false;
    dom.detailSkeleton.hidden = false;
    dom.detailContent.hidden = true;
    dom.detailError.hidden = true;
    clearNode(dom.detailContent);
    dom.detailToolbarMeta.textContent = 'загрузка досье…';

    if (opts.push) {
      try {
        window.history.pushState(
          { view: 'detail', id },
          '',
          buildUrl(`#/event/${encodeURIComponent(id)}`),
        );
      } catch {
        /* без истории: hash просто останется прежним */
      }
    } else {
      syncUrl();
    }

    loadEvent(id);
    if (typeof window.scrollTo === 'function') window.scrollTo({ top: 0, behavior: 'auto' });
  }

  function showListFromRoute() {
    const previousId = state.detailId;
    state.view = 'list';
    state.detailId = null;
    state.detail = null;
    state.detailEntryPushed = false;
    dom.detailView.hidden = true;
    dom.listView.hidden = false;
    renderList();
    syncUrl();
    if (previousId) focusEventCard(previousId);
    maybeRefreshStale();
  }

  function leaveDetailToList() {
    if (state.view !== 'detail') return;
    state.view = 'list';
    state.detailId = null;
    state.detail = null;
    state.detailEntryPushed = false;
    dom.detailView.hidden = true;
    dom.listView.hidden = false;
    renderList();
  }

  function closeDetail() {
    if (state.view !== 'detail') return;
    if (state.detailEntryPushed && window.history.length > 1) {
      state.detailEntryPushed = false;
      window.history.back();
      return;
    }
    showListFromRoute();
  }

  function loadEvent(id) {
    const token = ++state.eventToken;
    if (state.eventController) state.eventController.abort();
    const controller = new AbortController();
    state.eventController = controller;
    state.detailLoading = true;

    const params = new URLSearchParams();
    params.set('region', state.region);

    dom.detailSkeleton.hidden = false;
    dom.detailContent.hidden = true;
    dom.detailError.hidden = true;
    dom.detailToolbarMeta.textContent = 'загрузка досье…';

    return fetchJson(`api/event/${encodeURIComponent(id)}?${params.toString()}`, controller.signal)
      .then((payload) => {
        if (token !== state.eventToken) return;
        const event = payload && payload.event;
        if (!event || typeof event !== 'object' || Array.isArray(event)) {
          throw new Error('сервер не вернул событие');
        }
        renderDetail(event);
      })
      .catch((error) => {
        if (token !== state.eventToken || isAbortError(error)) return;
        showDetailError(error);
      })
      .finally(() => {
        if (token !== state.eventToken) return;
        state.detailLoading = false;
      });
  }

  function showDetailError(error) {
    dom.detailSkeleton.hidden = true;
    dom.detailContent.hidden = true;
    dom.detailError.hidden = false;

    let message;
    if (error && error.status === 404) {
      message = 'Событие не найдено — возможно, оно устарело и больше не входит в сводку.';
    } else if (error && error.status === 400) {
      message = 'Некорректный идентификатор события в адресе.';
    } else {
      message = `Не удалось загрузить досье: ${describeError(error)}.`;
    }
    dom.detailErrorText.textContent = message;
    dom.detailErrorRetry.hidden = Boolean(error && (error.status === 404 || error.status === 400));
    dom.detailToolbarMeta.textContent = 'досье недоступно';
    setStatus(`ошибка досье: ${describeError(error)}`, true);
  }

  function sourceNameByLink(event, link) {
    const articles = Array.isArray(event.articles) ? event.articles : [];
    for (const article of articles) {
      if (!article) continue;
      const href = safeExternalUrl(article.link);
      if (href && href === link) return article.sourceName || article.sourceId || 'источник';
    }
    return null;
  }

  function supportLinks(event, support) {
    const entries = [];
    const seen = new Set();
    for (const link of support) {
      const href = safeExternalUrl(link);
      if (!href || seen.has(href)) continue;
      seen.add(href);
      entries.push({ name: sourceNameByLink(event, href) || 'источник', url: href });
    }
    return entries;
  }

  /* Публикация, в заголовке/лиде которой встречается официальный маркер. */
  function articleForOfficialMarkers(event, markers) {
    const articles = Array.isArray(event.articles)
      ? event.articles.filter((article) => article && safeExternalUrl(article.link))
      : [];
    if (!articles.length) return null;
    const needles = markers.map((marker) => String(marker || '').toLowerCase()).filter(Boolean);
    if (needles.length) {
      for (const article of articles) {
        const hay = `${article.title || ''} ${article.excerpt || ''} ${article.summary || ''}`.toLowerCase();
        if (needles.some((needle) => hay.includes(needle))) return article;
      }
    }
    return articles[0];
  }

  function buildSection(title, countText) {
    const section = el('section', 'detail-section');
    const heading = el('h3', 'section-title');
    heading.append(document.createTextNode(title));
    if (countText) heading.append(el('span', 'section-count', ` ${countText}`));
    section.append(heading);
    return section;
  }

  function buildDetailHero(event) {
    const hero = el('div', 'detail-hero');

    const scoreWrap = el('div', 'detail-score-wrap');
    const scoreValue = el(
      'span',
      `detail-score ${scoreBand(event.score)}`,
      formatScore100(event.score),
    );
    scoreValue.dataset.testid = 'detail-score';
    scoreValue.setAttribute('aria-label', scoreAriaLabel(event.score));
    scoreValue.title = scoreAriaLabel(event.score);
    scoreWrap.append(scoreValue, el('span', 'detail-score-label', 'оценка'));
    hero.append(scoreWrap);

    const head = el('div', 'detail-head');
    const title = el('h2', 'detail-title', event.title || 'Без заголовка');
    title.id = 'detail-title';
    title.tabIndex = -1;
    head.append(title);

    const sourceCount = countSources(event);
    const subline = el('p', 'detail-subline');
    subline.dataset.testid = 'detail-meta';
    const metaPipe = el('span', 'detail-score-sep', '|');
    metaPipe.setAttribute('aria-hidden', 'true');
    subline.append(metaPipe, document.createTextNode(' '));
    subline.append(
      document.createTextNode(
        `${sourceCount} ${plural(sourceCount, 'независимый источник', 'независимых источника', 'независимых источников')}`,
      ),
    );
    subline.append(el('span', 'stat-sep', ' · '));
    subline.append(document.createTextNode(`достоверность ${formatScore(event.confidence)}`));
    subline.append(el('span', 'stat-sep', ' · '));
    const ageValue = Number.isFinite(Number(event.latestAt)) ? event.latestAt : event.publishedAt;
    subline.append(document.createTextNode(relativeTime(ageValue)));
    head.append(subline);

    const badges = el('div', 'detail-badges');
    const attribution = event.attribution && typeof event.attribution === 'object' ? event.attribution : {};
    if (attribution.official) {
      const markers = Array.isArray(attribution.markers) ? attribution.markers.filter(Boolean) : [];
      const badgeText = markers.length
        ? `официальный первоисточник: ${markers.slice(0, 4).join(', ')}`
        : 'официальный первоисточник';
      const markerArticle = articleForOfficialMarkers(event, markers);
      const markerHref = markerArticle ? safeExternalUrl(markerArticle.link) : null;
      let badge;
      if (markerHref) {
        badge = el('a', 'official-badge official-badge-link', badgeText);
        badge.href = markerHref;
        badge.target = '_blank';
        badge.rel = 'noopener noreferrer';
        badge.title = `Открыть публикацию: ${markerArticle.sourceName || markerArticle.sourceId || 'первоисточник'}`;
      } else {
        badge = el('span', 'official-badge', badgeText);
      }
      badge.dataset.testid = 'official-badge';
      badges.append(badge);
    }
    const conflicts = Array.isArray(event.conflicts) ? event.conflicts : [];
    if (conflicts.length) {
      const badge = el(
        'span',
        'conflict-badge',
        `расхождения в цифрах (${conflicts.length})`,
      );
      badge.dataset.testid = 'conflict-badge';
      badges.append(badge);
    }
    const speculative = Array.isArray(attribution.speculative) ? attribution.speculative.filter(Boolean) : [];
    if (speculative.length) {
      badges.append(el('span', 'conflict-badge', `осторожные формулировки: ${speculative.slice(0, 4).join(', ')}`));
    }
    if (badges.childNodes.length) head.append(badges);

    hero.append(head);

    if (event.summary) {
      hero.append(el('p', 'detail-summary', event.summary));
    }
    return hero;
  }

  function buildClaimsSection(event) {
    const claims = Array.isArray(event.claims) ? event.claims.filter(Boolean) : [];
    const section = buildSection('ТЕЗИСЫ', claims.length ? `(${claims.length})` : '');
    section.dataset.testid = 'claims-section';

    if (!claims.length) {
      section.append(el('p', 'empty-note', 'тезисы не выделены'));
      return section;
    }

    const list = el('ol', 'claim-list');
    claims.forEach((claim, index) => {
      const item = el('li', 'claim-item');
      item.append(el('span', 'claim-index', `${index + 1}.`));

      const body = el('div', 'claim-body');
      const support = Array.isArray(claim.support) ? claim.support.filter(Boolean) : [];
      const supportEntries = supportLinks(event, support);
      const firstSupport = supportEntries.length ? supportEntries[0].url : null;

      if (firstSupport) {
        const claimLink = el('a', 'claim-text claim-text-link', claim.text || '');
        claimLink.href = firstSupport;
        claimLink.target = '_blank';
        claimLink.rel = 'noopener noreferrer';
        claimLink.title = 'Открыть источник тезиса';
        claimLink.dataset.testid = 'claim-source-link';
        body.append(claimLink);
      } else {
        body.append(el('p', 'claim-text', claim.text || ''));
      }

      const meta = el('div', 'claim-meta');
      const kind = CLAIM_KINDS[claim.kind] ? claim.kind : 'statement';
      meta.append(el('span', `claim-kind kind-${kind}`, CLAIM_KINDS[kind]));

      const numbers = Array.isArray(claim.numbers) ? claim.numbers : [];
      numbers.forEach((number) => {
        if (!number) return;
        meta.append(el('span', 'number-chip', formatNumberValue(number.value, number.unit)));
      });

      if (supportEntries.length) {
        const supportLine = el('span', 'claim-support');
        supportLine.append(document.createTextNode('подтверждают: '));
        const limit = 6;
        supportEntries.slice(0, limit).forEach((entry, entryIndex) => {
          if (entryIndex) supportLine.append(document.createTextNode(', '));
          const supportLink = el('a', 'claim-support-link', entry.name);
          supportLink.href = entry.url;
          supportLink.target = '_blank';
          supportLink.rel = 'noopener noreferrer';
          supportLink.dataset.testid = 'claim-support-link';
          supportLine.append(supportLink);
        });
        if (supportEntries.length > limit) {
          supportLine.append(document.createTextNode(` +${supportEntries.length - limit}`));
        }
        meta.append(supportLine);
      } else if (support.length) {
        meta.append(el('span', 'claim-support', `подтверждений: ${support.length}`));
      } else {
        meta.append(el('span', 'claim-support', 'подтверждений в публикациях не найдено'));
      }

      body.append(meta);
      item.append(body);
      list.append(item);
    });

    section.append(list);
    return section;
  }

  function buildArticleCard(article) {
    const tier = typeof article.tier === 'string' ? article.tier.toUpperCase() : '';
    const card = el('article', `article-card${tier ? ` tier-${tier.toLowerCase()}` : ''}`);
    card.dataset.testid = 'article-card';
    card.dataset.sourceId = String(article.sourceId || '');
    if (tier) card.dataset.tier = tier;

    const head = el('div', 'article-head');
    head.append(el('span', 'article-source', article.sourceName || article.sourceId || 'источник'));

    if (tier) {
      const tierBadge = el(
        'span',
        `tier-badge tier-${tier.toLowerCase()}`,
        `${tier} · ${TIER_TRUST[tier] || 'доверие не указано'}`,
      );
      tierBadge.dataset.testid = 'tier-badge';
      head.append(tierBadge);
    }
    if (article.type) {
      head.append(el('span', 'article-type', TYPE_LABELS[article.type] || String(article.type)));
    }

    const timeParts = [];
    if (article.publishedAt) {
      timeParts.push(formatClock(article.publishedAt));
      timeParts.push(relativeTime(article.publishedAt));
    }
    if (timeParts.length) head.append(el('span', 'article-time', timeParts.join(' · ')));
    card.append(head);

    const href = safeExternalUrl(article.link);
    if (href) {
      const title = el('a', 'article-title', article.title || '(без заголовка)');
      title.href = href;
      title.target = '_blank';
      title.rel = 'noopener noreferrer';
      title.dataset.testid = 'article-title-link';
      card.append(title);
    } else {
      card.append(el('span', 'article-title', article.title || '(без заголовка)'));
    }

    if (article.excerpt) {
      card.append(el('p', 'article-excerpt', truncate(article.excerpt, 360)));
    }

    const actions = el('div', 'article-actions');
    if (href) {
      const open = el('a', 'article-link', 'Открыть оригинал');
      open.href = href;
      open.target = '_blank';
      open.rel = 'noopener noreferrer';
      open.dataset.testid = 'open-original';
      actions.append(open);
    } else {
      actions.append(el('span', 'article-link-missing', 'ссылка недоступна'));
    }
    card.append(actions);

    return card;
  }

  function buildArticlesSection(event) {
    const articles = Array.isArray(event.articles) ? event.articles.filter(Boolean) : [];
    const section = buildSection('ПОДТВЕРЖДЕНИЯ', `(${articles.length})`);
    section.dataset.testid = 'articles-section';

    const domains = Array.isArray(event.domains) ? event.domains.filter(Boolean) : [];
    if (domains.length) {
      section.append(
        el(
          'p',
          'section-note',
          `независимых доменов: ${domains.length} — ${domains.join(' · ')}`,
        ),
      );
    }

    if (!articles.length) {
      section.append(el('p', 'empty-note', 'публикаций в кластере нет'));
      return section;
    }

    const list = el('div', 'article-list');
    articles.forEach((article) => list.append(buildArticleCard(article)));
    section.append(list);
    return section;
  }

  function buildConflictItem(conflict, event) {
    const item = el('div', 'check-item');
    item.append(el('div', 'check-label', 'расхождения в цифрах'));

    const label = conflict && conflict.label ? String(conflict.label) : 'расхождение';
    item.append(el('div', 'check-value is-warning', label));
    if (conflict && conflict.note) {
      item.append(el('p', 'conflict-note', conflict.note));
    }

    const values = conflict && Array.isArray(conflict.values) ? conflict.values : [];
    if (values.length) {
      const wrap = el('div', 'conflict-values');
      values.forEach((value) => {
        if (!value) return;
        const span = el('span', 'conflict-value', formatNumberValue(value.value, value.unit));
        const links = Array.isArray(value.links) ? value.links.filter(Boolean) : [];
        if (links.length) {
          const linksWrap = el('span', 'conflict-links');
          let appended = 0;
          links.forEach((link) => {
            const href = safeExternalUrl(link);
            if (!href) return;
            appended += 1;
            const anchor = el('a', null, sourceNameByLink(event, href) || `источник ${appended}`);
            anchor.href = href;
            anchor.target = '_blank';
            anchor.rel = 'noopener noreferrer';
            linksWrap.append(anchor);
          });
          if (linksWrap.childNodes.length) span.append(linksWrap);
        }
        wrap.append(span);
      });
      item.append(wrap);
    }
    return item;
  }

  function buildBreakdownItem(event) {
    const item = el('div', 'check-item');
    item.append(el('div', 'check-label', 'слагаемые оценки'));

    const weights = state.meta && state.meta.weights && typeof state.meta.weights === 'object'
      ? state.meta.weights
      : WEIGHTS_FALLBACK;
    const parts = [
      ['значимость', event.severity, 'severity'],
      ['подтверждения', event.corroboration, 'corroboration'],
      ['свежесть', event.recency, 'recency'],
      ['достоверность', event.confidence, 'confidence'],
    ];

    const grid = el('div', 'score-breakdown');
    grid.dataset.testid = 'score-breakdown';
    let sum = 0;

    parts.forEach(([label, rawValue, key]) => {
      const valueNumber = Number(rawValue);
      const value = Number.isFinite(valueNumber) ? clampNumber(valueNumber, 0, 1) : 0;
      const rawWeight = Number(weights[key]);
      const weight = Number.isFinite(rawWeight) ? rawWeight : WEIGHTS_FALLBACK[key];
      const contribution = value * weight;
      sum += contribution;

      const row = el('div', 'breakdown-row');
      row.append(el('span', 'breakdown-label', label));
      row.append(el('span', 'breakdown-formula', `${formatScore(value)} × ${weight.toFixed(2)}`));
      row.append(el('span', 'breakdown-contribution', formatScore(contribution)));
      grid.append(row);
    });

    const totalRow = el('div', 'breakdown-total');
    totalRow.append(el('span', null, 'итог'));
    totalRow.append(el('span', null, formatScore(Number.isFinite(Number(event.score)) ? event.score : sum)));
    grid.append(totalRow);
    item.append(grid);
    return item;
  }

  function buildCheckSection(event) {
    const section = buildSection('ПРОВЕРКА');
    section.dataset.testid = 'check-section';

    const list = el('div', 'check-list');
    const attribution = event.attribution && typeof event.attribution === 'object' ? event.attribution : {};
    const markers = Array.isArray(attribution.markers) ? attribution.markers.filter(Boolean) : [];
    const speculative = Array.isArray(attribution.speculative) ? attribution.speculative.filter(Boolean) : [];

    const officialItem = el('div', 'check-item');
    officialItem.append(el('div', 'check-label', 'официальный первоисточник'));
    if (attribution.official) {
      const officialValue = el(
        'div',
        'check-value is-positive',
        markers.length ? `да — ${markers.join(', ')}` : 'да — найдены официальные маркеры',
      );
      const markerArticle = articleForOfficialMarkers(event, markers);
      const markerHref = markerArticle ? safeExternalUrl(markerArticle.link) : null;
      if (markerHref) {
        const checkLink = el('a', 'check-link', markerArticle.sourceName || 'открыть публикацию');
        checkLink.href = markerHref;
        checkLink.target = '_blank';
        checkLink.rel = 'noopener noreferrer';
        checkLink.title = 'Открыть публикацию с официальным маркером';
        checkLink.dataset.testid = 'check-official-link';
        officialValue.append(document.createTextNode(' · '), checkLink);
      }
      officialItem.append(officialValue);
    } else {
      officialItem.append(el('div', 'check-value is-negative', 'не найден'));
    }
    if (Number.isFinite(Number(attribution.score))) {
      officialItem.append(el('div', 'check-detail', `оценка атрибуции: ${formatScore(attribution.score)}`));
    }
    list.append(officialItem);

    const speculativeItem = el('div', 'check-item');
    speculativeItem.append(el('div', 'check-label', 'осторожные формулировки'));
    speculativeItem.append(
      el(
        'div',
        speculative.length ? 'check-value is-warning' : 'check-value is-positive',
        speculative.length ? `найдены: ${speculative.join(', ')}` : 'спекулятивных маркеров не найдено',
      ),
    );
    list.append(speculativeItem);

    const conflicts = Array.isArray(event.conflicts) ? event.conflicts.filter(Boolean) : [];
    if (!conflicts.length) {
      const item = el('div', 'check-item');
      item.append(el('div', 'check-label', 'расхождения в цифрах'));
      item.append(el('div', 'check-value is-positive', 'между источниками не найдено'));
      list.append(item);
    } else {
      conflicts.forEach((conflict) => list.append(buildConflictItem(conflict, event)));
    }

    const reasons = Array.isArray(event.reasons) ? event.reasons.filter(Boolean) : [];
    if (reasons.length) {
      const item = el('div', 'check-item');
      item.append(el('div', 'check-label', 'замечания к оценке'));
      item.append(el('div', 'check-value is-warning', reasons.join('; ')));
      list.append(item);
    }

    list.append(buildBreakdownItem(event));
    section.append(list);
    return section;
  }

  function buildWikiSection(event) {
    const wiki = Array.isArray(event.wiki) ? event.wiki.filter(Boolean) : [];
    const section = buildSection('ВИКИПЕДИЯ', wiki.length ? `(${wiki.length})` : '');
    section.dataset.testid = 'wiki-section';

    if (!wiki.length) {
      section.append(el('p', 'empty-note', 'справка не найдена'));
      return section;
    }

    const list = el('div', 'wiki-list');
    wiki.forEach((item) => {
      const card = el('article', 'wiki-card');
      const href = safeExternalUrl(item.url);
      if (href) {
        const link = el('a', 'wiki-title', item.title || 'статья');
        link.href = href;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.dataset.testid = 'wiki-link';
        card.append(link);
      } else {
        card.append(el('span', 'wiki-title', item.title || 'статья'));
      }
      if (item.extract) card.append(el('p', 'wiki-extract', truncate(item.extract, 700)));
      list.append(card);
    });
    section.append(list);
    return section;
  }

  function renderDetail(event) {
    state.detail = event;
    if (!state.detailId && event.id) state.detailId = String(event.id);

    dom.detailSkeleton.hidden = true;
    dom.detailError.hidden = true;
    dom.detailContent.hidden = false;
    clearNode(dom.detailContent);

    dom.detailContent.append(buildDetailHero(event));
    dom.detailContent.append(buildClaimsSection(event));
    dom.detailContent.append(buildArticlesSection(event));
    dom.detailContent.append(buildCheckSection(event));
    dom.detailContent.append(buildWikiSection(event));

    dom.detailToolbarMeta.textContent =
      `досье · ${state.detailId || event.id || ''} · ${REGION_LABELS[state.region] || state.region}`;

    setStatus(
      `досье открыто · ${countSources(event)} ${plural(countSources(event), 'источник', 'источника', 'источников')} · достоверность ${formatScore(event.confidence)}`,
    );

    updateSaveBookmarkButton();

    const title = dom.detailContent.querySelector('.detail-title');
    if (title && typeof title.focus === 'function') {
      title.focus({ preventScroll: true });
    }
  }

  // ---------------------------------------------------------------------------
  // Действия пользователя
  // ---------------------------------------------------------------------------

  function applyFilterChange() {
    state.selectedIndex = 0;
    if (state.view === 'detail') leaveDetailToList();
    syncControls();
    syncUrl();
    updateActiveBookmarkChip();
    hideListError();
    setStatus('применяю фильтры — загружаю сводку…');
    loadDigest({ reason: 'filters' });
  }

  function selectCategory(category) {
    if (!hasFilterOption(state.categoryOptions, category) || category === state.category) return;
    state.category = category;
    applyFilterChange();
  }

  function selectCity(city) {
    if (!hasFilterOption(state.cityOptions, city) || city === state.city) return;
    state.city = city;
    if (city !== ALL_FILTER) state.region = 'ru';
    applyFilterChange();
  }

  function resetFilters() {
    const hasFilters = state.category !== ALL_FILTER || state.city !== ALL_FILTER || state.query.length > 0;
    if (!hasFilters) return;
    state.category = ALL_FILTER;
    state.city = ALL_FILTER;
    state.query = [];
    state.activeBookmarkId = null;
    persistActiveBookmarkId(null);
    applyFilterChange();
  }

  function selectRegion(region) {
    if (!REGIONS.includes(region) || region === state.region) return;
    state.region = region;
    if (region !== 'ru' && state.city !== ALL_FILTER) state.city = ALL_FILTER;
    state.selectedIndex = 0;
    syncControls();
    leaveDetailToList();
    syncUrl();
    hideListError();
    setStatus(`регион: ${REGION_LABELS[region]} — загружаю сводку…`);
    loadDigest({ reason: 'region' });
  }

  function commitThreshold(value, options) {
    const opts = Object.assign({ debounce: false }, options || {});
    const next = normalizeThreshold(value);
    state.threshold = next;
    dom.thresholdValue.textContent = next.toFixed(2);
    dom.thresholdRange.setAttribute('aria-valuetext', next.toFixed(2));
    syncUrl();

    if (state.thresholdTimer) {
      window.clearTimeout(state.thresholdTimer);
      state.thresholdTimer = null;
    }

    const run = () => {
      state.thresholdTimer = null;
      if (state.view === 'detail') {
        loadDigest({ silent: true, reason: 'threshold' });
      } else {
        loadDigest({ reason: 'threshold' });
      }
    };

    if (opts.debounce) {
      state.thresholdTimer = window.setTimeout(run, 280);
    } else {
      run();
    }
  }

  function refreshCurrent() {
    if (state.view === 'detail' && state.detailId) {
      setStatus('обновляю досье…');
      loadEvent(state.detailId);
      return;
    }
    loadDigest({ refresh: true, reason: 'manual' });
  }

  function openSelected() {
    if (state.view !== 'list' || !state.events.length) return;
    const event = state.events[state.selectedIndex];
    if (!event || !event.id) return;
    openEvent(String(event.id), { push: true });
  }

  function openExternalUrl(raw) {
    const href = safeExternalUrl(raw);
    if (!href) return false;
    const anchor = document.createElement('a');
    anchor.href = href;
    anchor.target = '_blank';
    anchor.rel = 'noopener noreferrer';
    anchor.hidden = true;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    return true;
  }

  function openPrimarySource() {
    const event = state.view === 'detail' ? state.detail : state.events[state.selectedIndex];
    if (!event) {
      setStatus('нет выбранного события', true);
      return;
    }
    const articles = Array.isArray(event.articles) ? event.articles : [];
    const article = articles.find((item) => item && safeExternalUrl(item.link));
    if (!article) {
      setStatus('у этого события нет доступных первоисточников', true);
      return;
    }
    openExternalUrl(article.link);
    setStatus(`открываю: ${article.sourceName || article.sourceId || 'первоисточник'}`);
  }

  function openHelp() {
    if (!dom.helpDialog || typeof dom.helpDialog.showModal !== 'function') return;
    if (dom.helpDialog.open) return;
    state.helpReturnFocus = document.activeElement;
    dom.helpDialog.showModal();
    dom.helpClose.focus();
  }

  function closeHelp() {
    if (dom.helpDialog && dom.helpDialog.open) dom.helpDialog.close();
  }

  function maybeRefreshStale() {
    if (state.view !== 'list' || !state.data || state.loading) return;
    if (Date.now() - state.lastLoadAt > AUTO_REFRESH_MS) {
      loadDigest({ silent: true, reason: 'return' });
    }
  }

  function startAutoRefresh() {
    if (state.autoTimer) window.clearInterval(state.autoTimer);
    state.autoTimer = window.setInterval(() => {
      if (state.view !== 'list') return;
      if (document.hidden) return;
      if (state.loading) return;
      if (Date.now() - state.lastLoadAt < AUTO_REFRESH_MIN_GAP_MS) return;
      loadDigest({ silent: true, reason: 'auto' });
    }, AUTO_REFRESH_MS);
  }

  // ---------------------------------------------------------------------------
  // Маршрутизация
  // ---------------------------------------------------------------------------

  function applyRoute() {
    const rawHash = String(window.location.hash || '');
    const id = readEventIdFromHash(rawHash);
    if (!id && rawHash && rawHash !== '#') return; // чужой якорь (#main и т.п.) — не маршрут
    if (id) {
      if (state.view !== 'detail' || state.detailId !== id) {
        openEvent(id, { push: false });
      }
      return;
    }
    if (state.view === 'detail') {
      showListFromRoute();
      return;
    }
    if (!state.data && !state.loading) loadDigest({ reason: 'init' });
  }

  // ---------------------------------------------------------------------------
  // События ввода
  // ---------------------------------------------------------------------------

  function isEditableTarget(target) {
    if (!target || !target.tagName) return false;
    const tag = target.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || Boolean(target.isContentEditable);
  }

  function isNativeActivation(target, key) {
    if (key !== 'Enter' && key !== ' ') return false;
    if (!target || typeof target.closest !== 'function') return false;
    return Boolean(target.closest('button, a[href], [role="button"]'));
  }

  function onKeyDown(event) {
    if (event.defaultPrevented || event.ctrlKey || event.altKey || event.metaKey) return;

    if (dom.bookmarksDialog && dom.bookmarksDialog.open) {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeBookmarksDialog();
      }
      return;
    }

    if (dom.helpDialog && dom.helpDialog.open) {
      if (event.key === 'Escape' || event.key === '?') {
        event.preventDefault();
        closeHelp();
      }
      return;
    }

    if (isEditableTarget(event.target)) {
      if (event.key === 'Escape' && state.view === 'detail') {
        event.preventDefault();
        closeDetail();
      }
      return;
    }

    switch (event.key) {
      case 'ArrowDown':
      case 'j':
      case 'J':
        if (state.view === 'list') {
          event.preventDefault();
          moveSelection(1);
        }
        return;
      case 'ArrowUp':
      case 'k':
      case 'K':
        if (state.view === 'list') {
          event.preventDefault();
          moveSelection(-1);
        }
        return;
      case 'Enter':
        if (state.view !== 'list' || isNativeActivation(event.target, 'Enter')) return;
        event.preventDefault();
        openSelected();
        return;
      case 'Escape':
        if (state.view === 'detail') {
          event.preventDefault();
          closeDetail();
        }
        return;
      case 'r':
      case 'R':
        event.preventDefault();
        refreshCurrent();
        return;
      case 'o':
      case 'O':
        event.preventDefault();
        openPrimarySource();
        return;
      case '?':
        event.preventDefault();
        openHelp();
        return;
      default:
        return;
    }
  }

  function bindEvents() {
    dom.regionButtons.forEach((button) => {
      button.addEventListener('click', () => {
        selectRegion(button.dataset.region);
      });
    });

    if (dom.categorySelect) {
      dom.categorySelect.addEventListener('change', () => {
        selectCategory(dom.categorySelect.value);
      });
    }
    if (dom.citySelect) {
      dom.citySelect.addEventListener('change', () => {
        selectCity(dom.citySelect.value);
      });
    }
    if (dom.resetFilters) {
      dom.resetFilters.addEventListener('click', () => {
        resetFilters();
      });
    }

    dom.thresholdRange.addEventListener('input', () => {
      commitThreshold(dom.thresholdRange.value, { debounce: true });
    });
    dom.thresholdRange.addEventListener('change', () => {
      commitThreshold(dom.thresholdRange.value, { debounce: false });
    });

    dom.refreshButton.addEventListener('click', () => {
      refreshCurrent();
    });

    dom.helpButton.addEventListener('click', () => {
      openHelp();
    });
    if (dom.helpClose) {
      dom.helpClose.addEventListener('click', () => closeHelp());
    }
    if (dom.helpDialog) {
      dom.helpDialog.addEventListener('click', (event) => {
        if (event.target === dom.helpDialog) closeHelp();
      });
      dom.helpDialog.addEventListener('close', () => {
        const target = state.helpReturnFocus;
        state.helpReturnFocus = null;
        if (target && typeof target.focus === 'function') target.focus();
      });
    }

    if (dom.bookmarksButton) {
      dom.bookmarksButton.addEventListener('click', () => {
        openBookmarksDialog({ source: 'header' });
      });
    }
    if (dom.bookmarksClose) {
      dom.bookmarksClose.addEventListener('click', () => closeBookmarksDialog());
    }
    if (dom.bookmarksDialog) {
      dom.bookmarksDialog.addEventListener('click', (event) => {
        if (event.target === dom.bookmarksDialog) closeBookmarksDialog();
      });
      dom.bookmarksDialog.addEventListener('close', () => {
        const target = state.bookmarksReturnFocus;
        state.bookmarksReturnFocus = null;
        if (target && typeof target.focus === 'function') target.focus();
      });
    }
    if (dom.bookmarkCancel) {
      dom.bookmarkCancel.addEventListener('click', () => closeBookmarksDialog());
    }
    if (dom.bookmarkForm) {
      dom.bookmarkForm.addEventListener('submit', (event) => {
        event.preventDefault();
        const fromEvent = state.bookmarksSource === 'event';
        if (!saveBookmarkForm()) return;
        if (fromEvent) closeBookmarksDialog();
      });
    }
    if (dom.bookmarksList) {
      dom.bookmarksList.addEventListener('click', (event) => {
        const button = event.target && event.target.closest ? event.target.closest('[data-action]') : null;
        if (!button) return;
        const id = button.dataset.bookmarkId;
        if (!id) return;
        if (button.dataset.action === 'open') applyBookmark(id);
        else if (button.dataset.action === 'delete') deleteBookmark(id);
      });
    }
    if (dom.activeBookmarkReset) {
      dom.activeBookmarkReset.addEventListener('click', () => resetBookmarkFilter());
    }
    if (dom.saveBookmark) {
      dom.saveBookmark.addEventListener('click', () => saveCurrentEventBookmark());
    }

    dom.errorRetry.addEventListener('click', () => {
      hideListError();
      loadDigest(Object.assign({}, state.lastDigestOpts, { silent: false }));
    });

    dom.detailErrorRetry.addEventListener('click', () => {
      if (!state.detailId) return;
      dom.detailError.hidden = true;
      loadEvent(state.detailId);
    });

    dom.detailBack.addEventListener('click', () => {
      closeDetail();
    });

    dom.lowerThreshold.addEventListener('click', () => {
      const next = normalizeThreshold(state.threshold - THRESHOLD_STEP);
      if (next >= state.threshold - 0.0001) {
        setStatus('порог уже минимальный: 0.30', true);
        return;
      }
      state.threshold = next;
      syncControls();
      syncUrl();
      loadDigest({ reason: 'lower-threshold' });
    });

    dom.eventList.addEventListener('click', (event) => {
      const card = event.target && event.target.closest ? event.target.closest('.event-card') : null;
      if (!card || !dom.eventList.contains(card)) return;
      const index = Number(card.dataset.index);
      if (Number.isInteger(index) && index >= 0) {
        state.selectedIndex = index;
        applySelection({ focus: false });
      }
      if (card.dataset.eventId) openEvent(card.dataset.eventId, { push: true });
    });

    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('popstate', () => applyRoute());
    window.addEventListener('hashchange', () => applyRoute());
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) maybeRefreshStale();
    });
  }

  // ---------------------------------------------------------------------------
  // Инициализация
  // ---------------------------------------------------------------------------

  function cacheDom() {
    dom.regionButtons = Array.from(document.querySelectorAll('.region-button'));
    dom.categorySelect = document.getElementById('category-select');
    dom.citySelect = document.getElementById('city-select');
    dom.resetFilters = document.getElementById('reset-filters');
    dom.bookmarksButton = document.getElementById('bookmarks-button');
    dom.bookmarksBadge = document.getElementById('bookmarks-badge');
    dom.activeBookmarkRow = document.getElementById('active-bookmark-row');
    dom.activeBookmark = document.getElementById('active-bookmark');
    dom.activeBookmarkText = document.getElementById('active-bookmark-text');
    dom.activeBookmarkReset = document.getElementById('active-bookmark-reset');
    dom.saveBookmark = document.getElementById('save-bookmark');
    dom.bookmarksDialog = document.getElementById('bookmarks-dialog');
    dom.bookmarksClose = document.getElementById('bookmarks-close');
    dom.bookmarksList = document.getElementById('bookmarks-list');
    dom.bookmarksEmpty = document.getElementById('bookmarks-empty');
    dom.bookmarkForm = document.getElementById('bookmark-form');
    dom.bookmarkFormTitle = document.getElementById('bookmark-form-title');
    dom.bookmarkName = document.getElementById('bookmark-name');
    dom.bookmarkKeywords = document.getElementById('bookmark-keywords');
    dom.bookmarkCategory = document.getElementById('bookmark-category');
    dom.bookmarkCity = document.getElementById('bookmark-city');
    dom.bookmarkHint = document.getElementById('bookmark-hint');
    dom.bookmarkError = document.getElementById('bookmark-error');
    dom.bookmarkSubmit = document.getElementById('bookmark-submit');
    dom.bookmarkCancel = document.getElementById('bookmark-cancel');
    dom.thresholdRange = document.getElementById('threshold-range');
    dom.thresholdValue = document.getElementById('threshold-value');
    dom.refreshButton = document.getElementById('refresh-button');
    dom.helpButton = document.getElementById('help-button');
    dom.digestStats = document.getElementById('digest-stats');
    dom.liveBadge = document.getElementById('live-badge');
    dom.demoBadge = document.getElementById('demo-badge');
    dom.lastUpdated = document.getElementById('last-updated');
    dom.statusLine = document.getElementById('status-line');
    dom.listView = document.getElementById('list-view');
    dom.detailView = document.getElementById('detail-view');
    dom.errorBanner = document.getElementById('error-banner');
    dom.errorText = document.getElementById('error-text');
    dom.errorRetry = document.getElementById('error-retry');
    dom.listSkeleton = document.getElementById('list-skeleton');
    dom.emptyState = document.getElementById('empty-state');
    dom.emptyDetail = document.getElementById('empty-detail');
    dom.lowerThreshold = document.getElementById('lower-threshold');
    dom.rejectedBlock = document.getElementById('rejected-block');
    dom.rejectedList = document.getElementById('rejected-list');
    dom.eventList = document.getElementById('event-list');
    dom.detailBack = document.getElementById('detail-back');
    dom.detailToolbarMeta = document.getElementById('detail-toolbar-meta');
    dom.detailError = document.getElementById('detail-error');
    dom.detailErrorText = document.getElementById('detail-error-text');
    dom.detailErrorRetry = document.getElementById('detail-error-retry');
    dom.detailSkeleton = document.getElementById('detail-skeleton');
    dom.detailContent = document.getElementById('detail-content');
    dom.helpDialog = document.getElementById('help-dialog');
    dom.helpClose = document.getElementById('help-close');
  }

  function initFormatters() {
    try {
      if (typeof Intl === 'undefined') return;
      if (Intl.DateTimeFormat) {
        state.timeFormat = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' });
        state.secondsFormat = new Intl.DateTimeFormat('ru-RU', {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        });
      }
      if (Intl.RelativeTimeFormat) {
        state.relativeFormat = new Intl.RelativeTimeFormat('ru', { numeric: 'auto' });
      }
    } catch {
      /* останутся ручные фолбэки */
    }
  }

  function init() {
    cacheDom();
    initFormatters();

    const initial = readUrlState();
    state.region = initial.region;
    state.threshold = initial.threshold;
    state.category = initial.category;
    state.city = initial.city;
    state.query = initial.query;
    if (state.city !== ALL_FILTER) state.region = 'ru';

    state.bookmarks = readBookmarks();
    state.activeBookmarkId = null;
    if (state.query.length) {
      const storedId = readStoredActiveBookmarkId();
      let match = storedId
        ? state.bookmarks.find((bookmark) => bookmark.id === storedId && sameQuery(bookmark.keywords, state.query))
        : null;
      if (!match) match = findBookmarkForQuery(state.query);
      if (match) {
        state.activeBookmarkId = match.id;
        persistActiveBookmarkId(match.id);
      } else {
        persistActiveBookmarkId(null);
      }
    } else {
      persistActiveBookmarkId(null);
    }

    rebuildFilterSelects();
    syncControls();
    bindEvents();
    updateActiveBookmarkChip();
    updateBookmarkBadge();

    const initialHash = initial.eventId ? `#/event/${encodeURIComponent(initial.eventId)}` : '';
    try {
      window.history.replaceState(
        { view: initial.eventId ? 'detail' : 'list', id: initial.eventId || null },
        '',
        buildUrl(initialHash),
      );
    } catch {
      /* без истории работаем как есть */
    }

    if (initial.eventId) {
      openEvent(initial.eventId, { push: false });
      if (!state.data && !state.loading) loadDigest({ silent: true, reason: 'init' });
    } else {
      loadDigest({ reason: 'init' });
    }

    startAutoRefresh();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
