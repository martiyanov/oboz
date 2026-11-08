/* ОБОЗРЕВАТЕЛЬ — тема оформления.
   ES5, без внешних запросов. Подключается в <head> синхронно, чтобы
   выставить data-theme до первой отрисовки и не допустить вспышки. */
(function () {
  'use strict';

  var STORAGE_KEY = 'oboz-theme';
  var COLORS = { light: '#fafaf8', dark: '#0b0d0c' };
  var root = document.documentElement;
  var media = null;
  var reducedMotion = null;
  var transitionTimer = null;

  try {
    if (window.matchMedia) media = window.matchMedia('(prefers-color-scheme: light)');
  } catch (error) {
    media = null;
  }
  try {
    if (window.matchMedia) reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  } catch (error) {
    reducedMotion = null;
  }

  function storedTheme() {
    try {
      var value = window.localStorage.getItem(STORAGE_KEY);
      if (value === 'light' || value === 'dark') return value;
    } catch (error) {
      /* localStorage может быть недоступен (приватный режим) */
    }
    return null;
  }

  function systemTheme() {
    return media && media.matches ? 'light' : 'dark';
  }

  function currentTheme() {
    return storedTheme() || systemTheme();
  }

  function toggleButton() {
    return document.getElementById('theme-toggle');
  }

  function updateToggle(theme) {
    var button = toggleButton();
    if (!button) return;
    var nextName = theme === 'light' ? 'тёмную' : 'светлую';
    button.setAttribute('aria-label', 'Включить ' + nextName + ' тему');
    button.setAttribute('title', theme === 'light' ? 'Включить тёмную тему' : 'Включить светлую тему');
    button.setAttribute('data-current-theme', theme);
  }

  function apply(theme) {
    root.setAttribute('data-theme', theme);
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', COLORS[theme] || COLORS.dark);
    updateToggle(theme);
  }

  function animate() {
    if (reducedMotion && reducedMotion.matches) return;
    if (transitionTimer) window.clearTimeout(transitionTimer);
    root.className += ' theme-transition';
    transitionTimer = window.setTimeout(function () {
      transitionTimer = null;
      root.className = root.className.replace(/(^|\s)theme-transition(\s|$)/g, ' ').replace(/\s{2,}/g, ' ').replace(/^\s+|\s+$/g, '');
    }, 230);
  }

  function save(theme) {
    try {
      window.localStorage.setItem(STORAGE_KEY, theme);
    } catch (error) {
      /* без сохранения тема всё равно применится */
    }
  }

  function setTheme(theme, animateChange) {
    if (theme !== 'light' && theme !== 'dark') return;
    if (animateChange) animate();
    apply(theme);
    save(theme);
  }

  function bindToggle() {
    apply(currentTheme());
    var button = toggleButton();
    if (!button || button.getAttribute('data-oboz-bound') === '1') return;
    button.setAttribute('data-oboz-bound', '1');
    button.addEventListener('click', function () {
      setTheme(currentTheme() === 'light' ? 'dark' : 'light', true);
    });
  }

  /* Ранняя установка: до отрисовки страницы и до загрузки CSS. */
  apply(currentTheme());

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindToggle);
  } else {
    bindToggle();
  }

  /* Пока пользователь не выбрал тему вручную — следуем системной. */
  if (media) {
    var onSystemChange = function () {
      if (!storedTheme()) {
        animate();
        apply(systemTheme());
      }
    };
    if (media.addEventListener) media.addEventListener('change', onSystemChange);
    else if (media.addListener) media.addListener(onSystemChange);
  }

  /* Синхронизация между вкладками. */
  window.addEventListener('storage', function (event) {
    if (!event || event.key !== STORAGE_KEY) return;
    if (event.newValue !== 'light' && event.newValue !== 'dark') return;
    animate();
    apply(event.newValue);
  });

  /* Небольшой публичный API — на случай, если интерфейсу понадобится тема. */
  window.ObozTheme = {
    KEY: STORAGE_KEY,
    COLORS: COLORS,
    get: currentTheme,
    system: systemTheme,
    hasStored: function () {
      return storedTheme() !== null;
    },
    set: function (theme) {
      setTheme(theme, true);
    },
  };
})();
