// МОИ НОВОСТИ — приватная страница Обозревателя.
// Ванильный ES2020, без innerHTML для данных, сессия только через HttpOnly-cookie.
(() => {
  'use strict';

  const SESSION_ENDPOINT = 'api/private/session';
  const LOGIN_ENDPOINT = 'api/private/login';
  const LOGOUT_ENDPOINT = 'api/private/logout';
  const CATALOG_ENDPOINT = 'api/private/catalog';
  const PROJECTS_ENDPOINT = 'api/private/projects';
  const DIGEST_ENDPOINT = 'api/private/digest';
  const MAX_PROJECTS = 40;
  const MAX_KEYWORDS = 30;
  const PUBLIC_DOSSIER_BASE = './#/event/';

  const state = {
    authenticated: false,
    catalog: null,
    projects: [],
    threshold: 0.55,
    digest: null,
    loading: false,
    saving: false,
    editingProjectId: null,
    lastAction: null,
    relativeFormat: null,
    timeFormat: null,
  };

  const dom = {};

  // ---------------------------------------------------------------------------
  // Утилиты
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

  function truncate(text, max) {
    const value = String(text || '');
    if (value.length <= max) return value;
    return `${value.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
  }

  function scoreValue(value) {
    const n = Number(value);
    return Number.isFinite(n) ? String(Math.round(clampNumber(n, 0, 1) * 100)) : '—';
  }

  function scoreBand(value) {
    const n = Number(value);
    if (n >= 0.85) return 'score-high';
    if (n >= 0.65) return 'score-mid';
    return 'score-low';
  }

  function formatClock(timestamp) {
    const ts = Number(timestamp);
    if (!Number.isFinite(ts) || ts <= 0) return '—';
    try {
      if (state.timeFormat) return state.timeFormat.format(new Date(ts));
    } catch {
      /* фолбэк */
    }
    const date = new Date(ts);
    if (Number.isNaN(date.getTime())) return '—';
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
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
        try { return state.relativeFormat.format(-minutes, 'minute'); } catch { /* фолбэк */ }
      }
      return `${minutes} ${plural(minutes, 'минуту', 'минуты', 'минут')} назад`;
    }
    if (abs < 86400) {
      const hours = Math.max(1, Math.round(abs / 3600));
      if (state.relativeFormat) {
        try { return state.relativeFormat.format(-hours, 'hour'); } catch { /* фолбэк */ }
      }
      return `${hours} ${plural(hours, 'час', 'часа', 'часов')} назад`;
    }
    const days = Math.max(1, Math.round(abs / 86400));
    if (state.relativeFormat) {
      try { return state.relativeFormat.format(-days, 'day'); } catch { /* фолбэк */ }
    }
    return `${days} ${plural(days, 'день', 'дня', 'дней')} назад`;
  }

  function categoryLabel(id) {
    const categories = state.catalog && Array.isArray(state.catalog.categories) ? state.catalog.categories : [];
    const found = categories.find((category) => category.id === id);
    return found ? found.label : String(id || '');
  }

  function cityLabel(id) {
    const cities = state.catalog && Array.isArray(state.catalog.cities) ? state.catalog.cities : [];
    const found = cities.find((city) => city.id === id);
    return found ? found.label : String(id || '');
  }

  function sourceLabel(id) {
    const sources = state.catalog && Array.isArray(state.catalog.sources) ? state.catalog.sources : [];
    const found = sources.find((source) => source.id === id);
    return found ? found.name : String(id || '');
  }

  function isAuthError(error) {
    return Boolean(error && error.status === 401);
  }

  // ---------------------------------------------------------------------------
  // API (всегда same-origin cookie, без хранения пароля)
  // ---------------------------------------------------------------------------

  async function api(path, options) {
    const opts = Object.assign({ method: 'GET', skipAuthRedirect: false }, options || {});
    const headers = Object.assign({ Accept: 'application/json' }, opts.headers || {});
    let body = opts.body;
    if (body !== undefined && body !== null && typeof body !== 'string') {
      try {
        body = JSON.stringify(body);
      } catch {
        throw new Error('не удалось подготовить данные');
      }
      headers['Content-Type'] = 'application/json';
    }
    let response;
    try {
      response = await fetch(path, {
        method: opts.method,
        credentials: 'same-origin',
        cache: 'no-store',
        headers,
        body,
      });
    } catch {
      throw new Error('нет связи с сервером');
    }
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    if (response.status === 401 && !opts.skipAuthRedirect) {
      showLogin();
      const error = new Error('требуется вход');
      error.status = 401;
      throw error;
    }
    if (!response.ok) {
      const error = new Error((payload && typeof payload.error === 'string' && payload.error) || `HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return payload || {};
  }

  // ---------------------------------------------------------------------------
  // Формы входа/выхода
  // ---------------------------------------------------------------------------

  function setLoginError(message) {
    if (!dom.loginError) return;
    dom.loginError.textContent = message || '';
    dom.loginError.hidden = !message;
  }

  function setLoginBusy(busy) {
    if (!dom.loginSubmit) return;
    dom.loginSubmit.disabled = busy;
    dom.loginSubmit.textContent = busy ? 'Вхожу…' : 'Войти';
  }

  function showLogin(message) {
    state.authenticated = false;
    state.digest = null;
    state.projects = [];
    if (dom.projectsDialog && dom.projectsDialog.open) dom.projectsDialog.close();
    if (dom.dashboardView) dom.dashboardView.hidden = true;
    if (dom.loginView) dom.loginView.hidden = false;
    if (dom.logoutButton) dom.logoutButton.hidden = true;
    if (dom.privatePassword) {
      dom.privatePassword.value = '';
      dom.privatePassword.focus();
    }
    if (dom.feed) clearNode(dom.feed);
    setLoginError(message || '');
    document.title = 'Вход — Мои новости';
  }

  function showDashboard() {
    state.authenticated = true;
    if (dom.loginView) dom.loginView.hidden = true;
    if (dom.dashboardView) dom.dashboardView.hidden = false;
    if (dom.logoutButton) dom.logoutButton.hidden = false;
    setLoginError('');
    document.title = 'Мои новости — Обозреватель';
  }

  async function login(event) {
    event.preventDefault();
    const password = dom.privatePassword ? dom.privatePassword.value : '';
    if (!password) {
      setLoginError('Введите пароль.');
      return;
    }
    setLoginError('');
    setLoginBusy(true);
    try {
      await api(LOGIN_ENDPOINT, { method: 'POST', body: { password }, skipAuthRedirect: true });
      if (dom.privatePassword) dom.privatePassword.value = '';
      showDashboard();
      await loadDashboard();
    } catch (error) {
      if (error.status === 401) setLoginError('Неверный пароль.');
      else if (error.status === 429) setLoginError('Слишком много попыток входа — попробуйте позже.');
      else if (error.status === 403) setLoginError('Запрос отклонён. Обновите страницу и попробуйте снова.');
      else setLoginError(`Не удалось войти: ${error.message}`);
    } finally {
      setLoginBusy(false);
    }
  }

  async function logout() {
    if (dom.logoutButton) dom.logoutButton.disabled = true;
    try {
      await api(LOGOUT_ENDPOINT, { method: 'POST', skipAuthRedirect: true });
    } catch {
      /* сессия могла уже истечь — всё равно показываем форму */
    } finally {
      if (dom.logoutButton) dom.logoutButton.disabled = false;
      if (dom.projectsDialog && dom.projectsDialog.open) dom.projectsDialog.close();
      showLogin('');
    }
  }

  // ---------------------------------------------------------------------------
  // Дашборд
  // ---------------------------------------------------------------------------

  function setDashboardError(message) {
    if (!dom.dashboardError || !dom.dashboardErrorText) return;
    dom.dashboardErrorText.textContent = message || '';
    dom.dashboardError.hidden = !message;
  }

  function setDashboardBusy(busy) {
    state.loading = busy;
    if (dom.refreshButton) {
      dom.refreshButton.disabled = busy;
      dom.refreshButton.textContent = busy ? 'Обновляю…' : 'Обновить';
    }
    if (dom.thresholdSelect) dom.thresholdSelect.disabled = busy;
  }

  async function loadDashboard() {
    setDashboardError('');
    setDashboardBusy(true);
    try {
      const catalog = await api(CATALOG_ENDPOINT);
      state.catalog = catalog;
      state.projects = Array.isArray(catalog.projects) ? catalog.projects : [];
      await loadDigest(false);
    } catch (error) {
      if (!isAuthError(error)) {
        setDashboardError(`Не удалось загрузить данные: ${error.message}`);
      }
    } finally {
      setDashboardBusy(false);
    }
  }

  async function loadDigest(refresh) {
    setDashboardError('');
    setDashboardBusy(true);
    state.lastAction = () => loadDigest(Boolean(refresh));
    try {
      const threshold = Number(state.threshold).toFixed(2);
      const suffix = refresh ? '&refresh=1' : '';
      const digest = await api(`${DIGEST_ENDPOINT}?threshold=${encodeURIComponent(threshold)}${suffix}`);
      state.digest = digest;
      renderDashboard();
    } catch (error) {
      if (!isAuthError(error)) {
        setDashboardError(`Не удалось загрузить ленту: ${error.message}`);
      }
    } finally {
      setDashboardBusy(false);
    }
  }

  function renderDashboard() {
    const digest = state.digest;
    if (!digest) return;
    if (dom.privateUpdated) {
      const generated = Date.parse(digest.generatedAt || '');
      dom.privateUpdated.textContent = Number.isFinite(generated)
        ? `обновлено ${formatClock(generated)} · приватная лента по проектам`
        : 'приватная лента по проектам';
    }
    if (dom.privateStats) {
      const stats = digest.digestStats || {};
      const totalMatched = Number.isFinite(Number(digest.totalMatched)) ? Number(digest.totalMatched) : 0;
      const projectsWithMatches = Array.isArray(digest.projects)
        ? digest.projects.filter((group) => group.events && group.events.length).length
        : 0;
      dom.privateStats.textContent =
        `порог ${Number(digest.threshold || state.threshold).toFixed(2)} · ` +
        `проектов с совпадениями ${projectsWithMatches} · совпадений ${totalMatched} · ` +
        `проверено событий ${Number(stats.events) || 0} (прошло ${Number(stats.passed) || 0})`;
    }
    renderFeed();
  }

  function renderFeed() {
    if (!dom.feed) return;
    clearNode(dom.feed);
    const digest = state.digest;
    const groups = digest && Array.isArray(digest.projects) ? digest.projects : [];
    if (!groups.length) {
      if (dom.feedEmpty) dom.feedEmpty.hidden = false;
      return;
    }
    if (dom.feedEmpty) dom.feedEmpty.hidden = true;
    groups.forEach((group) => {
      dom.feed.append(buildProjectBlock(group));
    });
  }

  function buildProjectBlock(group) {
    const project = group && group.project ? group.project : {};
    const events = Array.isArray(group.events) ? group.events : [];
    const total = Number.isFinite(Number(group.total)) ? Number(group.total) : events.length;

    const block = el('section', 'private-project');
    block.dataset.projectId = project.id || '';

    const head = el('div', 'private-project-head');
    const name = el('h2', 'private-project-name', project.name || 'Проект');
    head.append(name);
    head.append(el('span', 'private-priority', `приоритет ${Number(project.priority) || 3}`));
    head.append(el('span', 'private-project-count', `${total} ${plural(total, 'совпадение', 'совпадения', 'совпадений')}`));
    block.append(head);

    if (project.description) {
      block.append(el('p', 'private-project-description', truncate(project.description, 300)));
    }

    if (!events.length) {
      block.append(el('p', 'private-project-empty', 'По проекту пока нет подтверждённых новостей.'));
      return block;
    }

    const list = el('div', 'private-events');
    events.forEach((event) => list.append(buildEventRow(event)));
    block.append(list);
    return block;
  }

  function buildEventRow(event) {
    const row = el('article', 'private-event');
    row.dataset.eventId = String(event.id || '');

    const score = el('span', `private-event-score ${scoreBand(event.score)}`, scoreValue(event.score));
    row.append(score);

    const body = el('div', 'private-event-body');
    const title = el('h3', 'private-event-title', event.title || 'Без заголовка');
    body.append(title);

    if (event.summary) body.append(el('p', 'private-event-summary', truncate(event.summary, 260)));

    const meta = el('div', 'private-event-meta');
    const topics = Array.isArray(event.topics) ? event.topics.slice(0, 4) : [];
    if (topics.length) {
      meta.append(el('span', 'private-event-topics', topics.map(categoryLabel).join(' · ')));
    }
    const sourceNames = [];
    const seenSources = new Set();
    const articles = Array.isArray(event.articles) ? event.articles : [];
    for (const article of articles) {
      const name = article && (article.sourceName || article.sourceId);
      if (!name || seenSources.has(name)) continue;
      seenSources.add(name);
      sourceNames.push(String(name));
      if (sourceNames.length >= 4) break;
    }
    if (sourceNames.length) {
      if (meta.childNodes.length) meta.append(el('span', 'private-dot', '·'));
      meta.append(el('span', 'private-event-sources', sourceNames.join(' · ')));
    }
    const timestamp = Number.isFinite(Number(event.latestAt)) ? event.latestAt : event.publishedAt;
    if (meta.childNodes.length) meta.append(el('span', 'private-dot', '·'));
    meta.append(el('span', 'private-event-time', relativeTime(timestamp)));
    if (Number.isFinite(Number(event.relevance))) {
      meta.append(el('span', 'private-dot', '·'));
      meta.append(el('span', 'private-event-relevance', `релевантность ${Number(event.relevance)}`));
    }
    body.append(meta);

    const actions = el('div', 'private-event-actions');
    if (event.id) {
      const dossier = el('a', 'private-dossier', 'досье');
      dossier.href = `${PUBLIC_DOSSIER_BASE}${encodeURIComponent(String(event.id))}`;
      dossier.target = '_blank';
      dossier.rel = 'noopener noreferrer';
      dossier.dataset.testid = 'private-dossier';
      actions.append(dossier);
    }
    body.append(actions);
    row.append(body);
    return row;
  }

  // ---------------------------------------------------------------------------
  // Проекты
  // ---------------------------------------------------------------------------

  function setProjectsError(message) {
    if (!dom.projectsError) return;
    dom.projectsError.textContent = message || '';
    dom.projectsError.hidden = !message;
  }

  function setProjectFormError(message) {
    if (!dom.projectError) return;
    dom.projectError.textContent = message || '';
    dom.projectError.hidden = !message;
  }

  function openProjectsDialog() {
    if (!dom.projectsDialog) return;
    setProjectsError('');
    hideProjectForm();
    renderProjectsList();
    if (!dom.projectsDialog.open) {
      try {
        dom.projectsDialog.showModal();
      } catch {
        dom.projectsDialog.setAttribute('open', '');
      }
    }
    if (dom.projectsClose) dom.projectsClose.focus();
  }

  function closeProjectsDialog() {
    if (!dom.projectsDialog) return;
    if (dom.projectsDialog.open) dom.projectsDialog.close();
    else dom.projectsDialog.removeAttribute('open');
  }

  function renderProjectsList() {
    if (!dom.projectsList) return;
    clearNode(dom.projectsList);
    const projects = Array.isArray(state.projects) ? state.projects : [];
    if (dom.projectsEmpty) dom.projectsEmpty.hidden = projects.length > 0;
    if (dom.projectLimit) dom.projectLimit.textContent = `${projects.length} / ${MAX_PROJECTS}`;
    if (dom.projectAdd) dom.projectAdd.disabled = projects.length >= MAX_PROJECTS;

    projects.forEach((project) => {
      const item = el('div', 'private-project-item');
      item.dataset.projectId = project.id || '';

      const info = el('div', 'private-project-item-info');
      const title = el('div', 'private-project-item-title');
      title.append(el('span', null, project.name || project.id));
      title.append(el('span', 'private-priority', `приоритет ${project.priority}`));
      if (!project.enabled) title.append(el('span', 'private-disabled', 'выключен'));
      info.append(title);
      if (project.description) info.append(el('p', 'private-project-item-description', truncate(project.description, 160)));
      const keywords = Array.isArray(project.keywords) ? project.keywords : [];
      info.append(el('p', 'private-project-item-keywords', keywords.length ? keywords.join(', ') : 'нет ключевых слов'));

      const actions = el('div', 'private-project-item-actions');
      const toggleLabel = el('label', 'private-check private-check-small');
      const toggle = document.createElement('input');
      toggle.type = 'checkbox';
      toggle.checked = project.enabled !== false;
      toggle.dataset.projectToggle = project.id;
      toggle.setAttribute('aria-label', `Проект «${project.name}» включён`);
      toggleLabel.append(toggle, el('span', null, 'вкл'));
      actions.append(toggleLabel);

      const edit = el('button', 'private-small-button', 'редактировать');
      edit.type = 'button';
      edit.dataset.projectEdit = project.id;
      const remove = el('button', 'private-small-button private-small-danger', 'удалить');
      remove.type = 'button';
      remove.dataset.projectDelete = project.id;
      actions.append(edit, remove);

      item.append(info, actions);
      dom.projectsList.append(item);
    });
  }

  function renderCheckboxes(container, items, selected, dataKey) {
    if (!container) return;
    clearNode(container);
    const selectedSet = new Set(Array.isArray(selected) ? selected : []);
    const options = Array.isArray(items) ? items : [];
    if (!options.length) {
      container.append(el('p', 'private-note', 'Нет доступных значений.'));
      return;
    }
    options.forEach((item) => {
      const id = String(item.id || '');
      const label = el('label', 'private-check');
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.value = id;
      input.checked = selectedSet.has(id);
      input.dataset[dataKey] = id;
      label.append(input, el('span', null, item.label || item.name || id));
      container.append(label);
    });
  }

  function renderProjectForm(project) {
    if (!dom.projectForm) return;
    const source = project || {};
    state.editingProjectId = source.id || null;
    if (dom.projectFormTitle) dom.projectFormTitle.textContent = source.id ? 'Редактировать проект' : 'Новый проект';
    if (dom.projectSave) dom.projectSave.textContent = source.id ? 'Сохранить изменения' : 'Сохранить';
    if (dom.projectId) dom.projectId.value = source.id || '';
    if (dom.projectName) dom.projectName.value = source.name || '';
    if (dom.projectDescription) dom.projectDescription.value = source.description || '';
    if (dom.projectPriority) dom.projectPriority.value = String(Number(source.priority) || 3);
    if (dom.projectEnabled) dom.projectEnabled.checked = source.enabled !== false;
    if (dom.projectKeywords) dom.projectKeywords.value = Array.isArray(source.keywords) ? source.keywords.join(', ') : '';

    const catalog = state.catalog || { categories: [], cities: [], sources: [] };
    const categories = Array.isArray(catalog.categories) ? catalog.categories.filter((item) => item.id !== 'all') : [];
    const cities = Array.isArray(catalog.cities) ? catalog.cities.filter((item) => item.id !== 'all') : [];
    renderCheckboxes(dom.projectTopics, categories, source.topics, 'projectTopic');
    renderCheckboxes(dom.projectSources, catalog.sources, source.sources, 'projectSource');
    renderCheckboxes(dom.projectCities, cities, source.cities, 'projectCity');
    setProjectFormError('');
    dom.projectForm.hidden = false;
    if (dom.projectName) dom.projectName.focus();
  }

  function hideProjectForm() {
    state.editingProjectId = null;
    if (dom.projectForm) dom.projectForm.hidden = true;
    setProjectFormError('');
  }

  function readChecked(container, dataKey) {
    if (!container) return [];
    const inputs = container.querySelectorAll('input[type="checkbox"]');
    const out = [];
    inputs.forEach((input) => {
      if (input.checked && input.dataset && input.dataset[dataKey]) out.push(input.dataset[dataKey]);
    });
    return out;
  }

  function normalizeKeywords(value) {
    const parts = String(value || '').split(',');
    const out = [];
    const seen = new Set();
    for (const part of parts) {
      const word = part.trim();
      if (!word) continue;
      const key = word.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(word.slice(0, 60));
      if (out.length >= MAX_KEYWORDS) break;
    }
    return out;
  }

  function makeProjectId() {
    const existing = new Set(state.projects.map((project) => project.id));
    let id = `prj-${Date.now().toString(36)}`;
    while (existing.has(id)) id = `${id}x`;
    return id;
  }

  async function saveProjects(nextProjects, options) {
    const opts = Object.assign({ success: '' }, options || {});
    state.saving = true;
    if (dom.projectSave) dom.projectSave.disabled = true;
    setProjectsError('');
    setProjectFormError('');
    try {
      const response = await api(PROJECTS_ENDPOINT, { method: 'PUT', body: { projects: nextProjects } });
      state.projects = Array.isArray(response.projects) ? response.projects : nextProjects;
      renderProjectsList();
      hideProjectForm();
      setProjectsError('');
      await loadDigest(false);
      return true;
    } catch (error) {
      if (isAuthError(error)) return false;
      setProjectsError(`Не удалось сохранить проекты: ${error.message}`);
      setProjectFormError(`Не удалось сохранить: ${error.message}`);
      return false;
    } finally {
      state.saving = false;
      if (dom.projectSave) dom.projectSave.disabled = false;
    }
  }

  async function submitProjectForm(event) {
    event.preventDefault();
    if (!dom.projectName || !dom.projectKeywords) return;
    const name = dom.projectName.value.trim();
    if (!name) {
      setProjectFormError('Введите название проекта.');
      dom.projectName.focus();
      return;
    }
    const keywords = normalizeKeywords(dom.projectKeywords.value);
    if (!keywords.length) {
      setProjectFormError('Добавьте хотя бы одно ключевое слово.');
      dom.projectKeywords.focus();
      return;
    }
    const editingId = state.editingProjectId;
    if (!editingId && state.projects.length >= MAX_PROJECTS) {
      setProjectFormError(`Можно хранить не больше ${MAX_PROJECTS} проектов.`);
      return;
    }
    const project = {
      id: editingId || makeProjectId(),
      name,
      description: dom.projectDescription ? dom.projectDescription.value.trim().slice(0, 300) : '',
      enabled: dom.projectEnabled ? dom.projectEnabled.checked : true,
      priority: dom.projectPriority ? Number(dom.projectPriority.value) || 3 : 3,
      keywords,
      topics: readChecked(dom.projectTopics, 'projectTopic'),
      sources: readChecked(dom.projectSources, 'projectSource'),
      cities: readChecked(dom.projectCities, 'projectCity'),
    };
    const next = state.projects.slice();
    if (editingId) {
      const index = next.findIndex((item) => item.id === editingId);
      if (index >= 0) next[index] = project;
      else next.push(project);
    } else {
      next.push(project);
    }
    await saveProjects(next, { success: 'Проект сохранён.' });
  }

  async function deleteProject(id) {
    const project = state.projects.find((item) => item.id === id);
    if (!project) return;
    const next = state.projects.filter((item) => item.id !== id);
    if (state.editingProjectId === id) hideProjectForm();
    await saveProjects(next, { success: `Проект «${project.name}» удалён.` });
  }

  async function toggleProject(id, enabled) {
    const next = state.projects.map((project) => (
      project.id === id ? Object.assign({}, project, { enabled }) : project
    ));
    await saveProjects(next, { success: enabled ? 'Проект включён.' : 'Проект выключен.' });
  }

  // ---------------------------------------------------------------------------
  // Инициализация
  // ---------------------------------------------------------------------------

  function cacheDom() {
    dom.loginView = document.getElementById('login-view');
    dom.dashboardView = document.getElementById('dashboard-view');
    dom.loginForm = document.getElementById('login-form');
    dom.privatePassword = document.getElementById('private-password');
    dom.loginError = document.getElementById('login-error');
    dom.loginSubmit = document.getElementById('login-submit');
    dom.logoutButton = document.getElementById('logout-button');
    dom.privateUpdated = document.getElementById('private-updated');
    dom.privateStats = document.getElementById('private-stats');
    dom.thresholdSelect = document.getElementById('threshold-select');
    dom.refreshButton = document.getElementById('refresh-button');
    dom.projectsButton = document.getElementById('projects-button');
    dom.dashboardError = document.getElementById('dashboard-error');
    dom.dashboardErrorText = document.getElementById('dashboard-error-text');
    dom.dashboardRetry = document.getElementById('dashboard-retry');
    dom.feed = document.getElementById('projects-feed');
    dom.feedEmpty = document.getElementById('feed-empty');
    dom.projectsDialog = document.getElementById('projects-dialog');
    dom.projectsClose = document.getElementById('projects-close');
    dom.projectsList = document.getElementById('projects-list');
    dom.projectsEmpty = document.getElementById('projects-empty');
    dom.projectAdd = document.getElementById('project-add');
    dom.projectLimit = document.getElementById('project-limit');
    dom.projectForm = document.getElementById('project-form');
    dom.projectFormTitle = document.getElementById('project-form-title');
    dom.projectId = document.getElementById('project-id');
    dom.projectName = document.getElementById('project-name');
    dom.projectDescription = document.getElementById('project-description');
    dom.projectPriority = document.getElementById('project-priority');
    dom.projectEnabled = document.getElementById('project-enabled');
    dom.projectKeywords = document.getElementById('project-keywords');
    dom.projectTopics = document.getElementById('project-topics');
    dom.projectSources = document.getElementById('project-sources');
    dom.projectCities = document.getElementById('project-cities');
    dom.projectError = document.getElementById('project-error');
    dom.projectSave = document.getElementById('project-save');
    dom.projectCancel = document.getElementById('project-cancel');
    dom.projectsError = document.getElementById('projects-error');
  }

  function initFormatters() {
    try {
      if (typeof Intl === 'undefined') return;
      if (Intl.DateTimeFormat) {
        state.timeFormat = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' });
      }
      if (Intl.RelativeTimeFormat) {
        state.relativeFormat = new Intl.RelativeTimeFormat('ru', { numeric: 'auto' });
      }
    } catch {
      /* останутся ручные фолбэки */
    }
  }

  function bindEvents() {
    if (dom.loginForm) dom.loginForm.addEventListener('submit', login);
    if (dom.logoutButton) dom.logoutButton.addEventListener('click', logout);
    if (dom.dashboardRetry) dom.dashboardRetry.addEventListener('click', () => {
      if (typeof state.lastAction === 'function') state.lastAction();
      else loadDashboard();
    });
    if (dom.thresholdSelect) {
      dom.thresholdSelect.addEventListener('change', () => {
        state.threshold = Number(dom.thresholdSelect.value) || 0.55;
        loadDigest(false);
      });
    }
    if (dom.refreshButton) dom.refreshButton.addEventListener('click', () => loadDigest(true));
    if (dom.projectsButton) dom.projectsButton.addEventListener('click', openProjectsDialog);
    if (dom.projectsClose) dom.projectsClose.addEventListener('click', closeProjectsDialog);
    if (dom.projectsDialog) {
      dom.projectsDialog.addEventListener('click', (event) => {
        if (event.target === dom.projectsDialog) closeProjectsDialog();
      });
    }
    if (dom.projectAdd) dom.projectAdd.addEventListener('click', () => renderProjectForm(null));
    if (dom.projectCancel) dom.projectCancel.addEventListener('click', hideProjectForm);
    if (dom.projectForm) dom.projectForm.addEventListener('submit', submitProjectForm);
    if (dom.projectsList) {
      dom.projectsList.addEventListener('click', (event) => {
        const target = event.target;
        if (!target || typeof target.closest !== 'function') return;
        const edit = target.closest('[data-project-edit]');
        if (edit) {
          const project = state.projects.find((item) => item.id === edit.dataset.projectEdit);
          if (project) renderProjectForm(project);
          return;
        }
        const remove = target.closest('[data-project-delete]');
        if (remove) {
          deleteProject(remove.dataset.projectDelete);
        }
      });
      dom.projectsList.addEventListener('change', (event) => {
        const target = event.target;
        if (!target || !target.dataset || !target.dataset.projectToggle) return;
        toggleProject(target.dataset.projectToggle, Boolean(target.checked));
      });
    }
  }

  async function init() {
    cacheDom();
    initFormatters();
    bindEvents();
    try {
      const session = await api(SESSION_ENDPOINT, { skipAuthRedirect: true });
      if (session && session.authenticated) {
        showDashboard();
        await loadDashboard();
      } else {
        showLogin('');
      }
    } catch (error) {
      showLogin(`Не удалось проверить сессию: ${error.message}`);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
