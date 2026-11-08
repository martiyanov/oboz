# Веб-версия «Обозревателя» на ВДС

Публичный адрес: **https://agonarena.ru/oboz/**

Страница — тонкая оболочка над тем же ядром, что CLI/TUI: те же источники, та же кластеризация,
та же оценка значимости и подтверждений. Никакой второй логики и никаких внешних CDN.

## Архитектура

```
браузер
  │  https://agonarena.ru/oboz/
  ▼
nginx (TLS, домен agonarena.ru, location /oboz/)
  │  proxy_pass http://127.0.0.1:8788/  (префикс /oboz/ снимается)
  ▼
systemd-сервис oboz-web  (node web/server.mjs, 127.0.0.1:8788)
  │  импортирует src/digest.js — то же ядро, что у `./oboz news` и `./oboz tui`
  ▼
20 RSS-лент + ru.wikipedia.org
  кэш лент: .cache/rss (5 мин), Википедия: .cache/wiki (24 ч), ответы API: память процесса (3 мин)
```

Почему `/oboz/`, а не корень: на `agonarena.ru` уже работает «Тренажёр переговоров» (прокси на
`127.0.0.1:8080`). Корень и остальные маршруты не тронуты; «Обозреватель» живёт в отдельной
префиксной локации.

## Что за файлы

| Путь | Назначение |
|---|---|
| `web/server.mjs` | HTTP-сервер без зависимостей: API, статика, кэш, healthz |
| `web/public/` | `index.html`, `app.js`, `style.css`, `theme.js`, `favicon.svg` — сам интерфейс |
| `deploy/oboz-web.service` | systemd-юнит (User=openclaw, порт 127.0.0.1:8788) |
| `deploy/nginx-oboz.conf` | nginx-snippet с `location /oboz/` |
| `scripts/deploy-web.sh` | обновление: rsync + перезапуск сервиса |
| `docs/WEB_API.md` | контракт API и требования к UI |

## Темы

Светлая и тёмная темы переключаются кнопкой в шапке (иконка солнца/луны). Выбор хранится в
`localStorage['oboz-theme']`; если пользователь ещё не выбирал тему, интерфейс следует системной
(`prefers-color-scheme`) и реагирует на её смену. `theme.js` подключается синхронно в `<head>`,
поэтому тема применяется до первой отрисовки — без вспышки. `meta[name="theme-color"]` меняется
вместе с темой (#fafaf8 / #0b0d0c).

## Фильтры: темы и города

В шапке — два селектора: «тема» (Политика, Экономика, Общество, Технологии, Музыка, Культура,
Наука, Спорт, Происшествия) и «город» (Москва, Нижний Новгород). Они передаются в API как
`category` и `city`, сохраняются в URL и не ослабляют правило подтверждений: событие всё равно
должно превысить порог и иметь несколько независимых источников. Разметка тем/городов —
`topics.json` и `src/topics.js`; разметка городских лент — поле `city` в `sources.json`.

## API

Базовый префикс: `https://agonarena.ru/oboz/`. Полное описание — [`WEB_API.md`](WEB_API.md).

```bash
curl -s https://agonarena.ru/oboz/healthz
curl -s 'https://agonarena.ru/oboz/api/digest?region=ru&threshold=0.7&limit=6'
curl -s 'https://agonarena.ru/oboz/api/event/<id>'
curl -s https://agonarena.ru/oboz/api/sources
```

Параметры `digest`: `region=ru|world|all`, `threshold=0.30…0.95` (шаг 0.05), `limit=6…30`,
`refresh=1` — принудительный пересчёт (не чаще раза в 30 с). Ответ кэшируется в памяти на 3 минуты;
устаревший кэш отдаётся сразу, а обновление идёт в фоне.

## Первичная установка (уже выполнена на этом ВДС)

```bash
# 1. Код
rsync -az --delete --exclude '.git' --exclude '.cache' --exclude '.state' \
  --exclude 'test' ./ openclaw@37.46.18.40:/home/openclaw/oboz/

# 2. systemd
ssh openclaw@37.46.18.40 'sudo -n tee /etc/systemd/system/oboz-web.service' < deploy/oboz-web.service
ssh openclaw@37.46.18.40 'sudo -n systemctl daemon-reload && sudo -n systemctl enable --now oboz-web'

# 3. nginx: snippet + include в server-блок agonarena.ru (443)
ssh openclaw@37.46.18.40 'sudo -n tee /etc/nginx/snippets/oboz-web.conf' < deploy/nginx-oboz.conf
# в /etc/nginx/sites-enabled/agonarena_bot после ssl_certificate_key добавляется:
#   include /etc/nginx/snippets/oboz-web.conf;
ssh openclaw@37.46.18.40 'sudo -n nginx -t && sudo -n systemctl reload nginx'

# 4. Проверка
curl -s https://agonarena.ru/oboz/healthz
```

Перед правкой конфига nginx сделан бэкап:
`/root/agonarena_bot.bak.<timestamp>`. Откат: вернуть файл и `sudo systemctl reload nginx`.

## Обновление кода

```bash
bash scripts/deploy-web.sh
# или: OBOZ_REMOTE_DIR=/srv/oboz bash scripts/deploy-web.sh user@host
```

Скрипт синхронизирует `src/`, `web/`, `config.json`, `sources.json`, перезапускает `oboz-web`
и проверяет `/healthz`.

## Эксплуатация

```bash
ssh openclaw@37.46.18.40
sudo systemctl status oboz-web --no-pager
sudo journalctl -u oboz-web -f          # логи: сборка digest, ошибки, «slow ...»
curl -s http://127.0.0.1:8788/healthz   # версия, uptime, кэш, статистика запросов
curl -s http://127.0.0.1:8788/api/digest?region=ru | head -c 300
```

Переменные окружения сервиса (менять в `/etc/systemd/system/oboz-web.service`):

| Переменная | По умолчанию | Значение |
|---|---|---|
| `OBOZ_WEB_HOST` | `127.0.0.1` | слушать только локально (наружу — через nginx) |
| `OBOZ_WEB_PORT` | `8788` | порт приложения |
| `OBOZ_WEB_CACHE_TTL_MS` | `180000` | TTL ответов digest в памяти |
| `OBOZ_WEB_DEMO` | `0` | `1` — демо-данные без сети (для проверки UI) |
| `OBOZ_WEB_WIKI` | `1` | `0` — не ходить в Википедию |
| `OBOZ_WEB_NO_WARM` | `0` | `1` — не прогревать кэш на старте |

Порог/источники/веса по-прежнему в `config.json` и `sources.json` в корне проекта — общие для
CLI, TUI и веба.

## Безопасность

- Приложение слушает только loopback; наружу — nginx с уже существующим сертификатом
  Let's Encrypt (`agonarena.ru` + `www`).
- Нет npm-зависимостей → нет цепочки поставок; наружу ходим только в RSS-ленты и `ru.wikipedia.org`.
- Статика отдаётся по белому списку путей, API валидирует параметры (регион, порог, лимит, id).
- CSP `default-src 'self'`, `frame-ancestors 'none'`, `X-Frame-Options: DENY`,
  `X-Content-Type-Options: nosniff`, `Referrer-Policy`.
- `limit_req zone=agonarena_api burst=20` в nginx — защита от всплесков.
- Данные пользователя не собираются и не хранятся.

## Диагностика

| Симптом | Что проверить |
|---|---|
| **502 Bad Gateway** на `/oboz/` | `systemctl status oboz-web`, `journalctl -u oboz-web -n 50`; сервис упал/не стартовал |
| **404** на `/oboz/` | не задеплоена статика (`web/public/index.html`); повторить `deploy-web.sh` |
| Пустой список событий | `curl /api/digest` — если пусто, реально нет событий выше порога; снизить порог; проверить `sourcesOk` в `stats` |
| Данные несвежие | TTL кэша 3 мин; `refresh=1`; ленты кэшируются на 5 мин; проверить `journalctl` на ошибки источников |
| Ленты не грузятся с ВДС | `curl -A '<браузерный UA>' -m 15 https://tass.ru/rss/v2.xml` с сервера; часть сайтов режет дата-центры |
| nginx не стартует | `sudo nginx -t`; откатить `agonarena_bot` из `/root/agonarena_bot.bak.*` |
| Домен/префикс | адрес задаётся `location /oboz/` в nginx; приложение использует относительные пути и работает под любым префиксом |

## Поддомен вместо префикса (опционально)

Если захочется `https://oboz.agonarena.ru`:

1. Добавить DNS A-запись `oboz.agonarena.ru → 37.46.18.40`.
2. Создать отдельный server-блок на 80/443 со своим `location / { proxy_pass http://127.0.0.1:8788; }`.
3. Выпустить сертификат: `sudo certbot --nginx -d oboz.agonarena.ru`, перезагрузить nginx.

В коде менять ничего не нужно — интерфейс использует относительные URL.
