# Бэкенд ScopeDiff

Андрей ведёт серверную часть в ветке `backend`. Сервер предоставляет анонимные сессии, каталог услуг, заказы, AI-импорт из текста и скриншотов, диктовку поля, предложения с историей версий и ручным согласованием, экспорт в PDF. [Спецификация API](../shared/api.md) · [Типы](../shared/types.ts)

## Размещение файлов

| Путь относительно `backend/` | Назначение |
|---|---|
| `AGENTS.md` | Инструкции для чата, которому поручена серверная задача |
| `.gitignore` | Исключения, относящиеся к серверной части |
| `local-work/` | Личный трекер, шаблоны, постановки и отчёты. Доступны в рабочей копии Андрея |
| `app/`, `migrations/`, `tests/` | Приложение, окружение Alembic и тесты |
| `requirements.txt`, `requirements-dev.txt`, `alembic.ini` | Зависимости для запуска и тестов, настройки Alembic |
| `Dockerfile`, `.dockerignore`, `compose.yaml` | Сборка образа и локальный запуск API с PostgreSQL. `Dockerfile` и `compose.yaml` хранятся в рабочей копии Андрея. |

## Локальный запуск из PowerShell

Из корня репозитория выполните команды с запущенным Docker Desktop. Локальный пароль Compose хранится в `backend/.env.local`. Если контейнер PostgreSQL уже существует, команда берёт его действующий пароль. Для анализа правок добавьте `DEEPSEEK_API_KEY` в `backend/.env`. Если файла ещё нет, начните с `.env.example`. [Ключи DeepSeek API](https://platform.deepseek.com/api_keys)

```powershell
Set-Location .\backend
py -3.12 -m venv .venv
& .\.venv\Scripts\python.exe -m pip install -r requirements-dev.txt
if (!(Test-Path -LiteralPath '.env')) {
    Copy-Item -LiteralPath '.env.example' -Destination '.env'
}
if (!(Test-Path -LiteralPath '.env.local')) {
    $scopeDiffDbContainer = docker ps -aq --filter 'name=^/scopediff-stage0-db-1$'
    if ($scopeDiffDbContainer) {
        docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' $scopeDiffDbContainer |
            Where-Object { $_ -like 'POSTGRES_PASSWORD=*' } |
            Set-Content -LiteralPath '.env.local' -Encoding ascii
    } elseif (docker volume ls -q --filter 'name=^scopediff-stage0_db_data$') {
        throw 'Укажите действующий пароль локального тома в .env.local как POSTGRES_PASSWORD.'
    } else {
        & .\.venv\Scripts\python.exe -c "from pathlib import Path; from secrets import token_hex; Path('.env.local').open('x', encoding='ascii').write('POSTGRES_PASSWORD=' + token_hex(24) + '\n')"
    }
}
docker compose --env-file .env --env-file .env.local up -d --wait db
docker compose --env-file .env --env-file .env.local build api
docker compose --env-file .env --env-file .env.local run --rm --no-deps api python -m alembic upgrade head
docker compose --env-file .env --env-file .env.local up -d --wait api
Invoke-RestMethod http://127.0.0.1:8000/api/v1/health
```

Ожидаемый ответ `200 {"status":"ok"}`. При недоступности базы API возвращает `503` с кодом `SERVICE_UNAVAILABLE`. Схема доступна по `http://127.0.0.1:8000/openapi.json`. API и PostgreSQL опубликованы только на loopback, порты `8000` и `54328` соответственно.

Чтобы выполнить тесты и проверить Alembic из Windows, настройте подключение к локальному PostgreSQL. Интеграционные тесты создают и удаляют временные схемы.

```powershell
$scopeDiffPasswordLine = Get-Content -LiteralPath '.env.local' | Where-Object { $_ -like 'POSTGRES_PASSWORD=*' } | Select-Object -First 1
$scopeDiffPassword = [uri]::EscapeDataString($scopeDiffPasswordLine.Substring('POSTGRES_PASSWORD='.Length))
$env:DATABASE_URL = "postgresql+psycopg://scopediff:${scopeDiffPassword}@127.0.0.1:54328/scopediff"
Remove-Variable scopeDiffPasswordLine, scopeDiffPassword

& .\.venv\Scripts\python.exe -m pip check
& .\.venv\Scripts\python.exe -m pytest -q
& .\.venv\Scripts\python.exe -m alembic current
```

Без `DATABASE_URL` проверки с настоящим PostgreSQL пропускаются. После применения миграций ожидаемая ревизия Alembic — `0004_public_approval (head)`. Чтобы обновить только образ API, выполните `docker compose --env-file .env --env-file .env.local build api`.

Для остановки выполните `docker compose --env-file .env --env-file .env.local down`. Команда сохраняет именованный том `scopediff-stage0_db_data`.

## Подключение каталога в мобильном приложении

Проверенный локальный адрес API — `http://127.0.0.1:8000/api/v1`. Маршруты можно вызвать из Swagger UI по адресу `http://127.0.0.1:8000/docs`.

| Запрос | Тело запроса | Успешный ответ |
|---|---|---|
| `POST /session` | `{}` | `201`, `{"token":"…"}` |
| `GET /services` | — | `200`, массив услуг, отсортированный по `name` |
| `POST /services` | `{"name":"Монтаж","description":"Два раунда правок"}` | `201`, объект услуги |
| `GET /services/{id}` | — | `200`, объект услуги |
| `PATCH /services/{id}` | Например, `{"name":"Монтаж видео"}` | `200`, объект с обновлённым названием и сохранённым описанием |
| `DELETE /services/{id}` | — | `204`, пустое тело |

На первом запуске вызовите `POST /session` и сохраните `token` в `localStorage`. Передавайте `Authorization: Bearer <token>` в каждом запросе каталога. Первый `GET /services` вернёт `[]`. После успешного `POST /services` возьмите `id` из ответа для `GET`, `PATCH` и `DELETE`. Каждый объект услуги содержит `id`, `name` и `description`. При повторном запуске используйте сохранённый токен. При сетевой ошибке или `503` сохраните токен и покажите ошибку подключения.

Ошибка имеет форму `{"error":{"code":"…","message":"…"}}`. Недействительный Bearer даёт `401 UNAUTHORIZED`, чужой или отсутствующий UUID — `404 NOT_FOUND`, невалидные данные — `422 VALIDATION_ERROR`. `POST /session` ограничен `SESSION_RATE_LIMIT_PER_HOUR` (по умолчанию 10 запросов на IP за скользящий час). Ответ `429 RATE_LIMITED` содержит `Retry-After` в секундах. Счётчик ведётся в одном процессе и сбрасывается при его перезапуске.

## Подключение ручных заказов

Все запросы идут под `/api/v1` с тем же Bearer, что и каталог.

| Запрос | Тело запроса | Успешный ответ |
|---|---|---|
| `GET /orders` | — | `200 OrderSummary[]`, по `updatedAt` от новых к старым. У новой сессии `[]`. |
| `POST /orders` | `OrderInput`, пример ниже | `201 Order`, со статусом `active` и ревизией `1`. |
| `GET /orders/{id}` | — | `200 OrderDetail` с заказом и массивом его предложений. |
| `PATCH /orders/{id}` | Например, `{"agreements":"Смонтировать ролик", "deadline":null}` | `200 Order` с изменёнными договорённостями и снятым сроком. |
| `DELETE /orders/{id}` | — | `204` с пустым телом. |

Пример тела `POST /orders` для заказа без услуги. При создании из каталога передайте `id` выбранной услуги в `serviceId`.

```json
{
  "serviceId": null,
  "title": "Монтаж интервью",
  "agreements": "Один ролик до трёх минут",
  "completedWork": "",
  "deadline": "2026-12-02"
}
```

Ответ `201` с примером серверных значений.

```json
{
  "serviceId": null,
  "title": "Монтаж интервью",
  "agreements": "Один ролик до трёх минут",
  "completedWork": "",
  "deadline": "2026-12-02",
  "id": "838547a4-cbc2-4fb2-b2a9-36a7bd8fe1be",
  "serviceSnapshot": null,
  "status": "active",
  "revision": 1,
  "createdAt": "2026-11-27T20:10:00Z",
  "updatedAt": "2026-11-27T20:10:00Z"
}
```

Список возвращает массив таких объектов с полем `openProposalStatus`. Оно содержит `draft`, `pending` или `countered` для открытого предложения и `null`, если открытого предложения нет. По `status` клиент разделяет активные и завершённые заказы. Заказ без открытого предложения можно завершить через `PATCH` с `{"status":"completed"}`. Для возврата в работу передайте `{"status":"active"}`.

Для заказов с услугой `serviceSnapshot` содержит `id`, `name` и `description` услуги на момент выбора. При удалении услуги `serviceId` становится `null`, прежний снимок сохраняется. Сменить услугу можно через `PATCH` с новым `serviceId`. Явный `{"serviceId":null}` очищает и ссылку, и снимок. Изменение договорённостей, выполненных работ, срока или выбранной услуги повышает `revision` на один за запрос. Для изменения названия или статуса обновляется `updatedAt`. Сессия может читать и менять только свои заказы и выбирать только свои услуги.

## Подключение анализа текстовых правок

Все три маршрута идут под `/api/v1` и требуют тот же Bearer, что и заказы.

| Запрос | Тело запроса | Успешный ответ |
|---|---|---|
| `POST /orders/{id}/proposals` | `multipart/form-data` с `text` или `files` | `201 ProposalResult` с `proposal` и `version` |
| `GET /orders/{id}/proposals` | — | `200 Proposal[]` от новых к старым |
| `GET /proposals/{id}` | — | `200 ProposalDetail` со списком версий по возрастанию номера |

В PowerShell подставьте локальный токен текущей сессии и ID вашего активного заказа. `curl.exe` сам добавит заголовок с границей multipart.

```powershell
curl.exe -H "Authorization: Bearer $scopeDiffToken" `
    --form-string "text=Нужна ещё горизонтальная версия" `
    "http://127.0.0.1:8000/api/v1/orders/$scopeDiffOrderId/proposals"
```

Перед отправкой предупредите пользователя, что текст, скриншоты и контекст заказа передаются DeepSeek и могут содержать персональные данные. Можно передать текст до 12000 символов и до трёх изображений PNG, JPEG или WebP по 5 MiB каждое. Добавляйте каждое изображение в повторяющееся поле `files` и передавайте `FormData` без явно заданного `Content-Type`. Пустой ввод или отсутствие конкретных пожеланий даёт `422 VALIDATION_ERROR`. После `201` откройте документ из `proposal` и `version`. При повторном входе возьмите ID из `GET /orders/{id}` и загрузите документ через `GET /proposals/{id}`. Отображайте цену `null` как неизвестную и `0` как явно бесплатную работу.

При `409 OPEN_PROPOSAL_EXISTS` обновите карточку и откройте сохранённое предложение. Этот же конфликт возможен при попытке завершить заказ. При `409 ORDER_CHANGED` обновите контекст заказа и сохраните текст, чтобы пользователь мог повторить анализ. `409 INVALID_STATE` означает, что заказ завершён. При `429 RATE_LIMITED` ориентируйтесь на `Retry-After` в секундах. При `502 AI_FAILED` покажите сообщение API и сохраните ввод. При таймауте клиента обновите карточку перед повторной отправкой.

Модель `deepseek-flash` вызывается в режиме JSON без thinking. Без `DEEPSEEK_API_KEY` запрос анализа вернёт `502`, health, чтение и ручные операции с заказами доступны. Серверный таймаут включает обе попытки и задаётся переменной `AI_TIMEOUT_SECONDS` (30 секунд по умолчанию). Для успешно отправленного запроса с недопустимым ответом допустим один повтор. [JSON Output](https://api-docs.deepseek.com/guides/json_mode/) · [Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode/)

| Переменная | Лимит по умолчанию |
|---|---|
| `AI_RATE_LIMIT_PER_SESSION_MINUTE` | 5 попыток за минуту на сессию |
| `AI_RATE_LIMIT_PER_SESSION_DAY` | 30 попыток за сутки на сессию |
| `AI_RATE_LIMIT_PER_IP_HOUR` | 30 попыток за час на IP |
| `AI_RATE_LIMIT_GLOBAL_DAY` | 300 попыток за сутки на процесс |
| `AI_MAX_CONCURRENT_PER_SESSION` | 2 одновременных анализа на сессию |

Окна скользящие и учитывают каждый вызов провайдера, включая повтор. Счётчики хранятся в процессе, с запуском одного воркера и сбросом после его перезапуска. Для рабочего аккаунта DeepSeek задайте отдельный бюджет на стороне провайдера.

## Редактирование, экспорт и согласование

Все действия идут по пути `/api/v1/proposals/{id}` с Bearer владельца. Маршруты записи, кроме удаления, возвращают `200 ProposalResult` с полями `proposal` и `version`.

| Действие | Вход | Результат |
|---|---|---|
| `PATCH` | JSON с `expectedVersionId` и полным `content` | Обновляет текущий черновик или делает следующий из `pending`/`countered` |
| `POST /revise` | Multipart с `text` и `expectedVersionId` | Всегда создаёт следующую версию черновика |
| `POST /publish` | JSON с `expectedVersionId` и `format` | Фиксирует версию в `pending` для передачи заказчику |
| `POST /approve` | JSON с `expectedVersionId` | Согласовывает `pending`/`countered` и применяет предложенный срок |
| `POST /reject` | JSON с `expectedVersionId` | Закрывает предложение в `rejected` без применения условий |
| `DELETE` | Без тела | Возвращает `204` для черновика без опубликованных версий |

После чтения через `GET /proposals/{id}` возьмите `proposal.currentVersionId` и найдите эту версию в `versions`. Для `PATCH` передайте её полное редактируемое содержание. У новых пунктов укажите `id: null`, у остальных сохраните идентификаторы. В примере используются фиктивные UUID.

```json
{
  "expectedVersionId": "53ef53be-4b4d-43c7-9ed6-a522e1f756f3",
  "content": {
    "title": "Горизонтальная версия ролика",
    "items": [{
      "id": "98da8ba2-84b4-4848-8a21-467576099763",
      "title": "Ролик 16:9",
      "description": "Адаптировать готовый монтаж под новый формат",
      "category": "extra",
      "reason": "",
      "price": 2400
    }],
    "deadline": "2026-12-10",
    "conditions": "Один раунд правок",
    "comment": null
  }
}
```

Для AI-доработки передайте замечания и текущий ID версии. После ответа используйте новый `version.id` для дальнейших действий. `GET /proposals/{id}` сохраняет предыдущие версии в порядке их номеров.

```powershell
$proposalUrl = 'http://127.0.0.1:8000/api/v1/proposals/537b6148-c24b-4efd-a586-a8bcb9e99a27'
$expectedVersionId = '53ef53be-4b4d-43c7-9ed6-a522e1f756f3'
curl.exe -H "Authorization: Bearer $scopeDiffToken" `
    --form-string "text=Добавьте в условия один раунд правок после сдачи" `
    --form-string "expectedVersionId=$expectedVersionId" `
    "$proposalUrl/revise"
```

Перед первым экспортом отправьте на `POST /publish` тело `{"expectedVersionId":"<текущий UUID>","format":"markdown"}` или укажите `"format":"text"`. Клиент формирует документ из `version` в ответе, включая номер и цены. Используйте `null` для неизвестной доплаты и `0` для бесплатной работы. Экспорт исключает `item.reason`, внутренний `comment` и текст переписки. Статус `pending` означает готовность к согласованию. Повтор публикации той же версии возвращает тот же результат.

Для интерактивного согласования укажите `"format":"link"`. В ответе `proposal.shareUrl` будет публичный HTTPS-адрес страницы предложения. Обладатель ссылки может согласовать опубликованную версию или предложить встречные условия без сессии. Владелец отзывает доступ через `POST /proposals/{id}/revoke-link` с `expectedVersionId`. После публикации новой версии заказчик сможет продолжить по той же ссылке, пока владелец её не отозвал.

После подтверждения заказчиком передайте на `POST /approve` тело `{"expectedVersionId":"<UUID из version.id ответа publish>"}`. Повтор того же запроса возвращает сохранённый результат. `deadline: null` сохраняет прежний срок. `GET /orders/{id}` возвращает исходные договорённости и принятые предложения, а следующий AI-анализ получает принятые версии в контексте.

При `409 VERSION_CONFLICT` перечитайте карточку предложения и предложите пользователю проверить актуальную версию. При `409 ORDER_CHANGED` перечитайте заказ и перепроверьте условия через `PATCH` или `revise`, затем опубликуйте обновлённую версию. При `409 INVALID_STATE` перечитайте карточку и обновите список доступных действий.

## Импорт, диктовка и PDF в мобильном клиенте

`POST /services/import` возвращает сохранённый массив услуг, `POST /orders/import` — заказ и при наличии новых пожеланий черновик с версией. Оба маршрута принимают тот же `FormData`, что и создание предложения. В импорт заказа можно добавить `serviceId`. Диктовка отправляет распознанный текст JSON-запросом `POST /ai/enhance-description` и подставляет ответ `text` в поле формы. [Контракт с полями и кодами ответов](../shared/api.md#3-ai-операции)

Для прямой загрузки PDF используйте `GET /versions/{id}/pdf` с Bearer. Для внешнего браузера запросите `POST /versions/{id}/pdf-link` с Bearer и возьмите `url` из ответа. Если текущая версия черновая, вызовите `publish` с `format: "pdf"`, затем откройте полученный `url`. Ссылка действует десять минут.

Задайте `PUBLIC_API_BASE_URL` как фактический HTTPS-адрес API с `/api/v1`. Его используют PDF и интерактивные ссылки. Для `PDF_SIGNING_KEY` используйте случайный секрет, например значение от `secrets.token_urlsafe(48)`. Задайте его в окружении Render или локальном файле окружения Compose. Параметры должны быть одинаковыми у всех процессов, обслуживающих один адрес. Сохраняйте `--no-access-log` при запуске Uvicorn. На прокси исключите пути `/share/{token}` и `/api/v1/public/{token}…` из журналов запросов или скрывайте в них токен. [Журналы HTTP на Render](https://render.com/docs/logging#http-request-logs)

## Миграция на Render

У сервиса `scopediff-stage0-api` из этапа 0 корневой каталог `backend`, Build Command — `pip install -r requirements.txt`, Health Check Path — `/api/v1/health`. Для Free Web Service выполните миграцию в Start Command. `DATABASE_URL` берётся из уже настроенного окружения сервиса. Для AI добавьте `DEEPSEEK_API_KEY` в Environment сервиса.

```sh
python -m alembic upgrade head && exec uvicorn app.main:app --host 0.0.0.0 --port "$PORT" --workers 1 --no-proxy-headers --no-access-log
```

На Render лимит использует `CF-Connecting-IP`, который выставляет входящий прокси Cloudflare. Флаг `--no-proxy-headers` отключает обработку `X-Forwarded-For` в Uvicorn. В локальном режиме лимит использует адрес ASGI-соединения. [Переменные Render](https://render.com/docs/environment-variables) · [Заголовки Cloudflare](https://developers.cloudflare.com/fundamentals/reference/http-headers/)

После публикации нужного коммита в ветке `backend` выберите **Manual Deploy → Deploy latest commit**. Проверьте успешный запуск, health и наличие `/api/v1/session`, `/api/v1/services` и `/api/v1/orders` во внешнем OpenAPI. Затем повторите сценарий каталога и ручных заказов по внешнему HTTPS-адресу. [Режимы и этапы деплоя Render](https://render.com/docs/deploys)

## Работа с задачами

Один чат ведёт одну порученную задачу. Точка входа на машине Андрея — `backend/local-work/TRACKER.md`; путь к конкретной постановке передаётся в чат. После обычного клонирования локальные материалы доступны только при отдельном переносе из исходной рабочей копии.

[Порядок работы агента](AGENTS.md) · [Обзор проекта](../README.md)
