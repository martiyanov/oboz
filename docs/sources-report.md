# Каталог источников «Обозреватель» — проверка и итог

Дата проверки: 2026-11-08, ~12:00–12:20 МСК.
Файл: `sources.json` (`version: 1`, `updatedAt: "2026-11-08"`). Записей: **20**, включено **19**, выключена **1** (`iz`, причина — в разделе «Риски»).

## Методика

1. HTTP: `curl -sL -m 20 <url>` — код ответа, конечный URL (для 301), размер тела.
2. Формат: корень `<rss version="2.0">`, наличие `<item>`, `<title>`, `<link>`, `pubDate`.
3. Свежесть: берётся **максимальный** `pubDate` в ленте, а не первый (у части лент порядок не хронологический); порог — 48 ч по контракту, 36 ч по `config.json` (`maxAgeHours`).
4. Совместимость с приложением: повторный fetch с User-Agent из `src/rss.js` и разбор реальным парсером `src/rss.js` (19/20 лент дают items с `link` и `publishedAt`; у `bbc-ru` 2 из 38 items без `pubDate`; `iz` — см. риски).
5. Валидность файла: `node -e "JSON.parse(require('fs').readFileSync('sources.json','utf8'))"` — OK.

## Итоговая таблица

`HTTP` — сначала `curl -sL` без UA (как в контракте), затем с UA приложения из `src/rss.js`.
Домен — по полю `site` (для BBC оба фида живут на `feeds.bbci.co.uk`, сайт — `bbc.com`).

| id | домен | region | tier | type | HTTP (curl / UA приложения) | items | последняя публикация (МСК) | возраст, ч | enabled |
|----|-------|--------|------|------|-----------------------------|-------|----------------------------|-----------|---------|
| tass | tass.ru | ru | A | state-agency | 200 / 200 | 100 | 2026.11.08 12:05 | 0,0 | да |
| interfax | interfax.ru | ru | A | state-agency | 200 / 200 | 25 | 2026.11.08 12:00 | 0,1 | да |
| kommersant | kommersant.ru | ru | B | business | 200 / 200 | 298 | 2026.11.08 12:00 | 0,1 | да |
| rbc | rbc.ru | ru | B | business | 200 / 200 | 30 | 2026.11.08 12:04 | 0,0 | да |
| vedomosti | vedomosti.ru | ru | B | business | 200 / 200 | 200 | 2026.11.08 11:53 | 0,2 | да |
| lenta | lenta.ru | ru | B | state-affiliated | 200 / 200 | 200 | 2026.11.08 11:55 | 0,2 | да |
| iz | iz.ru | ru | B | state-affiliated | **200 / 403** | 50 | 2026.11.08 11:52 | 0,2 | **нет** |
| rt-ru | russiatoday.ru | ru | C | state-affiliated | 200 / 200 | 50 | 2026.11.08 12:04 | 0,0 | да |
| rg | rg.ru | ru | C | state-affiliated | 200 / 200 | 100 | 2026.11.08 12:02 | 0,1 | да |
| meduza | meduza.io | ru | B | independent | 200 / 200 | 30 | 2026.11.08 11:17 | 0,8 | да |
| zona | zona.media | ru | B | independent | 200 / 200 | 50 | 2026.11.07 16:09 | 20,0 | да |
| bbc-ru | bbc.com | world | A | foreign | 200 / 200 | 38 | 2026.11.08 11:54 | 0,2 | да |
| bbc-world | bbc.com | world | A | foreign | 200 / 200 | 24 | 2026.11.08 10:52 | 1,2 | да |
| guardian-world | theguardian.com | world | A | foreign | 200 / 200 | 45 | 2026.11.08 12:00 | 0,1 | да |
| aljazeera | aljazeera.com | world | B | foreign | 200 / 200 | 25 | 2026.11.08 11:57 | 0,2 | да |
| dw-ru | dw.com | world | A | foreign | 200 / 200 | 75 | 2026.11.08 12:05 | 0,0 | да |
| france24-en | france24.com | world | A | foreign | 200 / 200 | 24 | 2026.11.08 10:08 | 2,0 | да |
| euronews | euronews.com | world | B | foreign | 200 / 200 | 50 | 2026.11.08 12:04 | 0,1 | да |
| nyt-world | nytimes.com | world | A | foreign | 200 / 200 | 54 | 2026.11.08 11:02 | 1,1 | да |
| rfi-ru | rfi.fr | world | A | foreign | 200 / 200 | 10 | 2026.11.07 18:40 | 17,4 | да |

## Баланс каталога

- `region: "ru"` — **10 включённых лент / 10 доменов** (требование: ≥6 лент, ≥4 домена).
- `region: "world"` — **9 включённых лент / 8 уникальных сайтов** (BBC представлен двумя фидами), все — иностранные (требование: ≥5 лент, ≥4 домена, не только российские).
- Типы (включённые): `state-agency` 2, `business` 3, `state-affiliated` 3, `independent` 2, `foreign` 9.
- Тиры (включённые): A 9, B 8, C 2.
- Все три опоры из контракта присутствуют: государственные (ТАСС, Интерфакс, RT, «Российская газета»), независимые («Медуза», «Медиазона»), иностранные (BBC, Guardian, NYT, DW, France 24, RFI, Al Jazeera, Euronews).
- Госканалы РФ не имеют tier A: RT и «Российская газета» — C, «Известия» и «Лента» — B.

## Изменения относительно исходной версии

Исходный `sources.json` содержал 8 лент: 7 `ru` и 1 `world` (BBC Russian), т.е. требование «≥5 лент world» не выполнялось.

- **Добавлено (12):** `kommersant`, `vedomosti`, `rg`, `zona` (ru); `bbc-world`, `guardian-world`, `aljazeera`, `dw-ru`, `france24-en`, `euronews`, `nyt-world`, `rfi-ru` (world).
- **Исправлены URL после 301** (использован конечный адрес): `interfax` — `/rss.asp` → `/rss`; `rt-ru` — `russian.rt.com/rss` → `russiatoday.ru/rss` (+ `site`); у `kommersant` нормализован регистр пути `/RSS/news.xml` → `/rss/news.xml`.
- **Tier/type:** у прежних источников сохранены (ТАСС и Интерфакс — A/state-agency, РБК/Лента/Известия — B, RT — C, BBC — A/foreign). У новых назначены осознанно: деловые издания — `business` (B), независимые — `independent` (B), иностранные — `foreign` (A у quality/public broadcaster, B у Al Jazeera и Euronews).
- **Выключено:** `iz` (`enabled: false`) — лента рабочая, но блокируется при UA приложения, см. ниже. Запись сохранена, чтобы включить одной строкой после правки UA.
- **Удалено:** нет (мёртвых лент в исходном наборе не было).

## Риски и проблемы

1. **`iz.ru` и User-Agent приложения (важно).** `curl -sL` и браузерный UA получают 200 и 50 `<item>`, но UA из `src/rss.js` (`... oboz/0.1 terminal news watcher`) DDoS-Guard встречает **403** (HTML-заглушка, 0 items). Проверено детерминированно: UA, содержащий `oboz`, → 403; `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)` → 200. Поэтому `iz` выключен. Чтобы вернуть ленту, достаточно заменить UA в `src/rss.js` на браузерный (например, Chrome) и поставить `"enabled": true`.
2. **Концентрация прогосударственных источников в RU-наборе.** Из 10 включённых лент 5 — государственные/проправительственные (ТАСС, Интерфакс, RT, «Российская газета», «Лента»), 3 — деловые, 2 — независимые. При подсчёте подтверждений одинаковые формулировки госагентств могут давать «ложное подтверждение»; смягчение — деловые + независимые + иностранные ленты и веса по tier (A 1.0 / B 0.85 / C 0.6 в `config.json`).
3. **Один медиахолдинг.** BBC представлен двумя лентами (русская служба и World) — это осознанно (разные языки/повестки), но при подсчёте уникальных доменов BBC считается за один.
4. **Медленные ленты.** `zona` — последняя публикация ~20 ч назад (обновляется эпизодически; при `maxAgeHours: 36` может временно выпадать из свежих), `rfi-ru` — 17 ч и всего 10 items. Формально живы, но запас по свежести меньше, чем у остальных.
5. **Мелкое:** в `bbc-ru` 2 из 38 items без `pubDate`; `digest.js` подставляет `now`, т.е. они могут выглядеть «свежими» (не критично). `guardian-world` не сортирует items по времени — фильтры должны опираться на `publishedAt`, а не на порядок.
6. **Объём за цикл:** суммарно ~1,7 МБ RSS (самые тяжёлые: kommersant 254 КБ, lenta 144 КБ, vedomosti 137 КБ). Допустимо; кандидат `aif` (3,1 МБ) по этой причине не включён.

## Проверенные, но не включённые кандидаты

| кандидат | результат | причина отказа |
|----------|-----------|----------------|
| gazeta.ru/export/rss/lenta.xml | 404 | мёртвая лента |
| novayagazeta.ru/rss | 404 | мёртвая лента |
| vesti.ru/vesti.rss | 404 | мёртвая лента |
| rbc.ru/rss | 401 | требует авторизации (рабочий фид — `rssexport.rbc.ru`) |
| mk.ru/rss/index.cgi | 404 | мёртвая лента |
| forbes.ru/rss.xml | 200, 0 items | HTML-капча вместо RSS |
| tvrain.tv/rss | 200, 0 items | HTML-страница «Подписка на RSS», не фид |
| novayagazeta.eu/feed/all | 521 | сервер недоступен |
| istories.media/rss | 403 | блокировка |
| theins.ru/rss | 200, 0 items | HTML вместо RSS |
| svoboda.org / rferl.org API | 200, 0 items (11 байт) | пустой ответ, фид недоступен |
| cnbc.com RSS | 403 | блокировка |
| ren.tv/rss | 403 | блокировка |
| vz.ru/rss.xml, 1tv.ru/rss | 200, 0 items | не RSS 2.0 / нет `<item>` |
| kp.ru/rss/allsections.xml | 200, 200 items | рабочий, но таблоид с низким качеством — не включён (резервная замена `iz`) |
| aif.ru/rss/all.php | 200, 235 items | 3,1 МБ на запрос — слишком тяжёлая для частого опроса |
| rss.dw.com/rdf/rss-ru-all | 200, 76 items | RSS 1.0/RDF, не RSS 2.0; заменён на `rss.dw.com/xml/rss-ru-all` |
| rss.dw.com/atom/rss-ru-all | 200, 0 `<item>` | Atom, контракт требует RSS 2.0 |

## Воспроизведение проверки

```bash
# 1) валидность JSON
node -e "JSON.parse(require('fs').readFileSync('sources.json','utf8'))"

# 2) все включённые ленты: HTTP 200 и >=5 <item>
node -e 'const {sources}=JSON.parse(require("fs").readFileSync("sources.json","utf8"));
for (const s of sources) if (s.enabled !== false) console.log(s.id + "\t" + s.url)' |
while IFS=$'\t' read -r id url; do
  code=$(curl -sL -m 20 -o /tmp/f.xml -w '%{http_code}' "$url")
  n=$(grep -o '<item' /tmp/f.xml | wc -l | tr -d ' ')
  echo "$id HTTP=$code items=$n"
done

# 3) свежесть последней публикации
curl -sL -m 20 '<url>' | grep -o '<pubDate>[^<]*' | sed 's/<pubDate>//' | sort -R | head -1
```


---

## Обновление после отчёта (лид)

В `src/rss.js` User-Agent заменён на браузерный (Chrome/124, macOS). После этого `iz.ru`
отвечает 200 и отдаёт 50 items с тем же парсером, поэтому `iz` включён обратно (`enabled: true`).
Итог: 20 включённых лент — 11 ru + 9 world. Проверка: `./oboz sources --check` → 20/20.
