> **Обновление 2026-11-11:** каталог расширен до **39 лент (20 ru + 19 world)**; добавлены The Washington Post World, NPR World, CNN World, WSJ World, Bloomberg Markets, UN News, The Economist. Раздел «Мир» теперь фильтруется по большинству зарубежных источников события, а английские severity-ключи добавлены в `config.json`.

# Каталог источников «Обозреватель» — проверка и итог

Дата проверки: 2026-11-08, ~12:00–12:20 МСК.
Файл: `sources.json` (`version: 1`, `updatedAt: "2026-11-08"`). Записей: **32**, включено **32** — 20 базовых + 12 тематических (технологии, музыка, Москва, Нижний Новгород), см. раздел «Расширение каталога».

## Методика

1. HTTP: `curl -sL -m 20 <url>` — код ответа, конечный URL (для 301), размер тела.
2. Формат: корень `<rss version="2.0">`, наличие `<item>`, `<title>`, `<link>`, `pubDate`.
3. Свежесть: берётся **максимальный** `pubDate` в ленте, а не первый (у части лент порядок не хронологический); порог — 48 ч по контракту, 36 ч по `config.json` (`maxAgeHours`).
4. Совместимость с приложением: повторный fetch с User-Agent из `src/rss.js` и разбор реальным парсером `src/rss.js` (на момент базовой проверки 19/20 лент давали items с `link`; `iz` блокировался старым UA — см. риски; после смены UA лидом — 20/20).
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
| iz | iz.ru | ru | B | state-affiliated | 200 / 200 | 50 | 2026.11.08 11:52 | 0,2 | да |
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

- `region: "ru"` — **20 включённых лент / 20 доменов** (требование: ≥6 лент, ≥4 домена).
- `region: "world"` — **12 включённых лент / 11 уникальных сайтов** (BBC — два фида на одном домене), все — иностранные (требование: ≥5 лент, ≥4 домена, не только российские).
- Категории: `tech` — 4 ленты (3 ru + 1 world), `music` — 4 (2 ru + 2 world), `city`/Москва — 2, `city`/Нижний Новгород — 2.
- Типы (включённые): `state-agency` 2, `business` 3, `state-affiliated` 5, `independent` 9, `foreign` 12, `aggregator` 1.
- Тиры (включённые): A 10, B 18, C 4.
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

1. **`iz.ru` и User-Agent приложения (решено).** При старом UA `... oboz/0.1 terminal news watcher` DDoS-Guard отдавал **403** (HTML-заглушка, 0 items), поэтому `iz` был выключен. Лид заменил UA в `src/rss.js` на браузерный (Chrome/124), после чего лента отвечает 200 и отдаёт 50 items; `iz` включён обратно (`enabled: true`).
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

---

## Расширение каталога: технологии, музыка, Москва, Нижний Новгород

Проверено 2026-11-08, ~14:00–14:10 МСК. Добавлено **12 новых лент**, существующие 20 записей и их `id`/`url` не изменены. Итог: **32 записи, все включены**.

Методика — как у приложения: `curl -sL -m 25` с браузерным UA из `src/rss.js` (Chrome/124) + разбор реальным парсером `src/rss.js`. Критерии: HTTP 200, ≥5 `<item>`, у каждого item есть `<link>`, возраст самой новой публикации ≤48 ч (по `config.json` — ≤36 ч). **Контроль: 32/32 лент OK.**

### Новые ленты

| id | домен | region | topics | city | tier | type | HTTP | items | последняя публикация (МСК) | возраст, ч |
|----|-------|--------|--------|------|------|------|------|-------|----------------------------|-----------|
| 3dnews | 3dnews.ru | ru | tech, science | — | B | independent | 200 | 55 | 2026.11.08 00:52 | 13,2 |
| ixbt | ixbt.com | ru | tech | — | B | independent | 200 | 50 | 2026.11.08 13:53 | 0,2 |
| habr | habr.com | ru | tech | — | C | aggregator | 200 | 40 | 2026.11.08 13:59 | 0,0 |
| techcrunch | techcrunch.com | world | tech | — | B | foreign | 200 | 20 | 2026.11.08 01:07 | 12,9 |
| intermedia | intermedia.ru | ru | music, culture | — | B | independent | 200 | 150 | 2026.11.08 13:08 | 0,9 |
| soyuz | soyuz.ru | ru | music, culture | — | B | independent | 200 | 68 | 2026.11.07 23:15 | 14,8 |
| pitchfork | pitchfork.com | world | music, culture | — | A | foreign | 200 | 29 | 2026.11.07 20:11 | 17,8 |
| nme | nme.com | world | music, culture | — | B | foreign | 200 | 10 | 2026.11.08 13:35 | 0,4 |
| moskvichmag | moskvichmag.ru | ru | city, society, culture | moscow | B | independent | 200 | 11 | 2026.11.08 06:59 | 7,0 |
| m24 | m24.ru | ru | city, society | moscow | C | state-affiliated | 200 | 100 | 2026.11.08 13:52 | 0,2 |
| vremyan | vremyan.ru | ru | city, society | nizhny | B | independent | 200 | 100 | 2026.11.08 13:45 | 0,3 |
| niann | niann.ru | ru | city, society | nizhny | B | independent | 200 | 80 | 2026.11.08 13:51 | 0,2 |

Конечные URL после 301: `ixbt` — `.../export/news/rss.xml`, `pitchfork` — `/feed/feed-news/rss`.

### Покрытие категорий

- **Технологии (`tech`) — 4 ленты:** 3DNews, iXBT (ru, B/independent), Хабр (ru, C/aggregator), TechCrunch (world, B/foreign). Требование «≥3, из них 2 ru + 1 world» выполнено.
- **Музыка (`music`) — 4 ленты:** ИнтерМедиа, Союз (ru, B/independent), Pitchfork (world, A/foreign), NME (world, B/foreign). Требование «≥3, 1–2 ru + 1–2 world» выполнено.
- **Москва — 2 ленты:** Москвич Mag (B, independent), Москва 24 (C, state-affiliated). У обеих `city: "moscow"`.
- **Нижний Новгород — 2 ленты:** Время Н (B, independent), НИА «Нижний Новгород» (B, independent). У обеих `city: "nizhny"`.
- Итог каталога: **20 ru + 12 world = 32 ленты**, 31 уникальный домен (BBC — два фида), A 10 / B 18 / C 4.

### Риски и ограничения новых лент

1. **`m24` — смешанная повестка.** «Москва 24» — городской госканал, но в ленте заметная доля федеральных и мировых новостей (в выборке из 12 заголовков ~5 про Москву). Текущая логика «события из city-ленты автоматически получают город» пометит Москвой **все** её события → возможна ложная геолокация. Рекомендация лиду: при разметке города проверять упоминание «Москв/столиц/мэр/Собянин» в заголовке/лиде или понижать вес city-событий из госканалов. Чистой независимой альтернативы нет: The Village — 502, Moslenta — анти-бот, mskagency.ru — 404, mos.ru — таймаут, mk.ru/rss/msk.xml — 404.
2. **`moskvichmag` — мало items.** 11 items, последняя публикация ~7 ч назад; повестка лайфстайл (рестораны, выставки, районы), город чистый, но событий мало — при простое может выпадать по `maxAgeHours: 36`.
3. **Музыкальные ru-ленты — шоубиза/кино вперемешку.** ИнтерМедиа и Союз дают и музыку, и сериалы/кино/знаменитостей, поэтому `topics: ["music","culture"]`; обе — порталы/агентства (B), контент местами PR-ный. В обоих фидах внутри item дублируются пары `<title>`/`<link>` (парсер берёт первый, дедуп по ссылке в `fetchAllSources` это скрывает).
4. **Техно-ленты дублируют друг друга.** Хабр — агрегатор с UGC (C), 3DNews и iXBT — тематические издания (B); события часто пересекаются — шумно, зато corroboration по техно-событиям будет хорошим.
5. **Свежесть с меньшим запасом:** Pitchfork 17,8 ч, Союз 14,8 ч, 3DNews 13,2 ч, TechCrunch 12,9 ч — в пределах 36/48 ч, но если лента замрёт, выпадет из свежих.
6. **Объём:** 12 новых лент ≈ 1,8 МБ за цикл (тяжёлые: Время Н 351 КБ, Союз 306 КБ, НИА 282 КБ, iXBT 218 КБ); каталог целиком ≈ 3,5 МБ. Опираться на дисковый кэш (`cacheTtlSec: 300`).
7. **Холдинги/дубли:** пересечений по холдингам с базовым набором нет (Pitchfork — Condé Nast, NME — NME Networks, TechCrunch — Yahoo). Ни одна новая лента не дублирует уже существующие общие СМИ.

### Проверенные, но не добавленные кандидаты (эта задача)

| кандидат | результат | причина |
|----------|-----------|---------|
| afisha.ru/rss/, the-flow.ru/rss, soyuz.ru/rss, kanobu.ru/rss | 404 | мёртвые ленты (рабочий фид — `soyuz.ru/rss/news`) |
| zvuki.ru/rss/news, rap.ru/rss | 404 | мёртвые ленты |
| rockcult.ru/feed | 200, 0 items | HTML/не фид |
| gigster.ru | 500 | серверная ошибка |
| colta.ru/rss | 200, 50 items, 321 ч | замороженная лента |
| daily.afisha.ru/rss/ | 200, 5 items | подборки-лайфстайл, не городская/музыкальная повестка |
| the-village.ru | 502 | сервер недоступен |
| moslenta.ru | 200, HTML | анти-бот заглушка |
| mskagency.ru (/rss/, /rss2, /feed) | 404 / HTML | рабочего RSS нет |
| mos.ru, msk.kp.ru, mk.ru/rss/msk.xml | таймаут / 404 | недоступны |
| nn.ru/rss/news/, nn.rbc.ru, gorodn.ru | 404 | мёртвые ленты |
| newsnn.ru/rss, nn.mk.ru/rss/, niann.ru/?a=rss, vremyan.ru/rss | 200, HTML | страница-индекс RSS, а не фид (рабочие фиды: `vremyan.ru/rss/news.rss`, `niann.ru/rss`) |
| pravda-nn.ru/feed | 500 | серверная ошибка |
| nn.aif.ru/rss/, nta-nn.ru | 403 | блокировка |
| nn.mk.ru/rss/nn.xml (mk.ru/rss/nn.xml) | 200, 25 items | рабочий таблоид, не добавлен — хватило двух NN-лент |
| theverge.com/rss/index.xml | Atom, 0 `<item>` | не RSS 2.0 |
| nplus1.ru/rss | 200, 10 items, 43 ч | живой, но свежесть на границе 36 ч — не добавлен |
| vc.ru/rss | 200, 12 items | рабочий агрегатор, не добавлен (достаточно 3 ru-техно) |
| wired.com, arstechnica, billboard, stereogum, consequence, rollingstone | 200 | рабочие, не добавлены — достаточно TechCrunch / Pitchfork / NME |

