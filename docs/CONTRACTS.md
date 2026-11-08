# Контракты модулей «Обозреватель»

Команда: `oboz`. MVP: терминальная сводка новостей по региону (`ru` / `world`) с порогом значимости,
проверкой подтверждений и пошаговым разбором каждого события вплоть до первоисточника и Википедии.

## 1. `sources.json` — каталог фидов

```json
{
  "version": 1,
  "updatedAt": "2026-11-08",
  "sources": [
    {
      "id": "tass",
      "name": "ТАСС",
      "url": "https://tass.ru/rss/v2.xml",
      "site": "https://tass.ru",
      "lang": "ru",
      "region": "ru",
      "tier": "A",
      "type": "state-agency",
      "topics": ["politics", "economy", "society", "world"],
      "enabled": true
    }
  ]
}
```

Поля:
- `id` — `[a-z0-9-]+`, уникален, стабилен (используется в UI и логах).
- `url` — рабочий RSS 2.0, проверен `curl -sL` (HTTP 200, минимум 5 `<item>`).
- `region` — `"ru"` или `"world"`: основная повестка ленты.
- `tier` — доверие: `A` (агентство первого ряда / качественное издание), `B` (крупное медиа),
  `C` (агрегатор / госканал / низкая независимость). Влияет на confidence и на вес при подсчёте подтверждений.
- `type` — `state-agency` | `state-affiliated` | `independent` | `business` | `foreign` | `aggregator`.
- `enabled` — `false` отключает ленту, не удаляя запись.

Требования к каталогу MVP:
- ≥ 6 лент `region: "ru"`, покрывающих ≥ 4 разных домена;
- ≥ 5 лент `region: "world"`, покрывающих ≥ 4 разных домена (не только российские);
- ни одной 404/пустой/замороженной ленты; у каждой дата последней публикации не старше 48 ч;
- в наборе должны быть и государственные (ТАСС, Интерфакс, RT), и независимые (Медуза), и иностранные
  (BBC и др.) источники — иначе «подтверждение» получается однобоким.

## 2. `src/evidence.js` — доказательная база события (ESM)

Модуль вызывается из `src/digest.js` после кластеризации. На вход получает событие со склеенными
публикациями разных источников:

```js
event = {
  id: "a1b2c3d4",
  title: "Мужчина погиб при атаке БПЛА в Курской области",     // заголовок кластера (самый полный)
  summary: "Губернатор сообщил, что дрон атаковал трактор...",  // описание/лид
  entities: ["Курская область", "Хинштейн", "БПЛА"],           // уже извлечённые имена/топонимы
  articles: [
    {
      sourceId: "interfax",
      sourceName: "Интерфакс",
      domain: "interfax.ru",
      tier: "A",
      type: "state-agency",
      title: "Мужчина погиб при атаке БПЛА в Курской области",
      excerpt: "Мужчина погиб после атаки украинского дрона...",
      link: "https://www.interfax.ru/russia/1127652",
      publishedAt: 1794129060000
    }
  ]
}
```

Экспорт (все функции — ESM, `export`; чистая логика отделена от сети):

```js
// 1) Факты/тезисы, на которые можно кликнуть в TUI.
export function extractClaims(event) -> Claim[]
// Claim = {
//   id: "c1",
//   text: "Мужчина погиб после атаки дрона в Поныровском районе",
//   kind: "statement" | "number" | "attribution",
//   numbers: [{ value: 1, unit: "чел" }],       // пусто, если чисел нет
//   support: ["https://...", "https://..."]      // ссылки на публикации, где встречается тезис
// }
// Правила: 1–5 тезисов; предложения длиннее 220 символов резать; дедуп похожих; первый тезис — из title.

// 2) Расхождения между источниками (разные цифры/детали).
export function detectConflicts(event) -> Conflict[]
// Conflict = {
//   kind: "numbers" | "detail",
//   label: "Число погибших",
//   values: [{ value: "1", unit: "чел", links: ["https://..."] }],
//   note: "Источники расходятся: 1 и 2"
// }
// Ищем только осмысленные расхождения: числа с единицами (чел, человек, %, млрд, млн, тыс, км, часов)
// рядом со словами «погиб/жертв/ранен/пострадал» либо повторяющиеся числа в заголовках кластера.

// 3) Признаки первоисточника и спекулятивности.
export function attributionSignals(event) -> {
  official: boolean,        // есть ссылка на орган власти/пресс-службу/официальное сообщение
  markers: string[],        // найденные официальные маркеры
  speculative: string[],    // «якобы», «по слухам», «источник сообщил» и т.п.
  score: number             // 0..1: +0.5 за official, +0.15 за каждый маркер (макс 3), -0.2 за спекулятивность
}

// 4) Ссылки на Википедию как фоновое подтверждение сущностей.
export async function wikipediaFor(event, opts) -> WikiRef[]
// WikiRef = { title, url, extract, lang: "ru" }
// opts = { limit = 3, timeoutMs = 8000, cacheDir = ".cache/wiki" }
// Использовать https://ru.wikipedia.org/w/api.php (action=query&list=search, затем prop=extracts&exintro).
// Кэш на диск по ключу сущности (TTL 24 ч), сетевые ошибки НЕ пробрасывать: вернуть [] и записать warning.

// 5) Сборка всего блока доказательств.
export async function buildEvidence(event, opts) -> {
  claims: Claim[],
  conflicts: Conflict[],
  attribution: { official, markers, speculative, score },
  wiki: WikiRef[],
  notes: string[]    // короткие пометки для UI на русском, напр. "2 источника расходятся в цифрах"
}
// opts: { wiki = true, limit = 3, timeoutMs = 8000, cacheDir = ".cache/wiki" }
// Гарантии: не бросает исключений при недоступной сети; суммарно ≤ 3 wiki-запроса; общий таймаут ≤ 8 с.
```

Требования к качеству:
- никаких сетевых вызовов в `extractClaims` / `detectConflicts` / `attributionSignals`;
- устойчивость к HTML-сущностям и `&laquo;`/`&nbsp;` в тексте;
- модуль не импортирует внутренние модули проекта, кроме `node:*`;
- тесты: `test/evidence.test.js` на фикстурах (без сети), плюс помечать сетевые тесты отдельно
  (`node --test --test-name-pattern`).

## 3. Общая модель события (после `src/digest.js`)

```js
{
  id, title, summary, scope: ["ru"] | ["world"] | ["ru","world"],
  score, severity, corroboration, confidence,       // 0..1
  domains: ["interfax.ru", "tass.ru", ...],
  articles: [...], claims: [...], conflicts: [...],
  attribution: {...}, wiki: [...],
  verdict: { pass: boolean, reasons: string[] },
  publishedAt, latestAt
}
```

Поле `region` в ранних набросках заменено на `scope` (массив: событие может относиться и к России,
и к миру); `--json` отдаёт `scope`, а `region` остаётся только параметром фильтра.

Порог (`config.json` → `threshold`, по умолчанию 0.55) применяется к `score`; при этом событие
проходит, только если `domains.length >= minDomains` И `confidence >= minConfidence`.
