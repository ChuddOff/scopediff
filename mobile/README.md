# mobile

A LeCodes app. The whole SDK is available as globals (`UIScreen`, `UIText`, `Scene2D`, …) —
no imports needed. `main.ts` is the entry point.

## Режимы запуска

Основной вход `main.ts` использует HTTP-клиент для FastAPI. После деплоя укажите согласованный HTTPS URL с путём `/api/v1` в `api/config.ts`. Запуск без адреса покажет сообщение о настройке сервера. Токен анонимной сессии хранится через `secureStorage`. В браузерном предпросмотре LeCodes реализует этот SDK API через локальное хранилище своего хоста.

```sh
lecodes dev --web                        # FastAPI, как в конкурсной сборке
lecodes compile -o .lecodes/scopediff.js  # основная сборка без mock API
lecodes dev --web --entry dev-mock.ts     # отдельный вход с локальными демоданными
```

Для браузерного предпросмотра FastAPI должен разрешать CORS для origin предпросмотра, включая заголовки `Authorization` и `Content-Type`. Интерактивную ссылку возвращает `publish`. Для открытия PDF в браузере потребуется согласованный источник временной подписанной ссылки. В v1 уже описано авторизованное получение PDF как файла, доступное через `getVersionPdf`.

## Проверки без телефона

```sh
lecodes test --entry dev-mock.ts
lecodes test --entry tests/dictation.ts --dir tests/dictation
lecodes test --entry tests/http-client.ts --dir tests/http
npx --yes --package typescript@5.9.3 tsc --noEmit --strict
```

Для проверки фактического HTTP и multipart запустите `node tests/http-wire/server.cjs` в отдельном терминале, затем выполните:

```sh
lecodes test --entry tests/http-wire.ts --dir tests/http-wire --wait-network --settle 100
```

Тестовый сервер слушает только `127.0.0.1:49335` и использует тестовые данные. Параметр `--settle 100` позволяет проверить состояние загрузки до задержанного ответа сервера. Формат сценариев описан в [CLAUDE.md](./CLAUDE.md).

Контекстная диктовка использует `POST /api/v1/ai/enhance-description`. HTTP-клиент готов к подключению после согласования и реализации обработчика. Тест диктовки использует управляемое распознавание и локальную обработку, поэтому не требует микрофона.

## Подготовка конкурсного проекта LeCodes

Из каталога `mobile/` соберите отдельный каталог с разрешёнными файлами. В него входят HTTP-вход, рабочие экраны и ресурсы шрифтов. Файлы mock, тесты и локальные конфигурации остаются в рабочей копии.

```powershell
node tools/stage-release.cjs
Set-Location .lecodes/release
lecodes compile -o .lecodes/scopediff.js
```

Из этого же каталога в CLI 2.14.8 привязать сборку к существующему проекту можно так:

```powershell
lecodes link --project "https://le.codes/app/projects/oegpwopq" --no-types
lecodes status
```

Команда `link --project` требует аккаунт с правом редактирования. При первом запуске CLI может понадобиться `lecodes login`.

Пока команда уточняет назначение `app.server.ts`, держите точную копию файла из того же снимка командного проекта в `.lecodes/release/app.server.ts`. Её можно взять из существующей локальной копии проекта или у коллеги. CLI считает отсутствующий файл удалённым, даже если он указан в `.lecodesignore`.

После обновления исходников повторите `node tools/stage-release.cjs` из `mobile/`. Для привязанного каталога скрипт сверяет SHA-256 серверного файла с манифестом и сохраняет оба файла. Проверьте вывод `lecodes status` из `.lecodes/release`. При совпадении копии с манифестом `app.server.ts` не появится в списке изменений.

## Go native

```
lecodes app init ios         # generate a native Xcode shell in ios/
lecodes app sync             # embed the compiled bundle + plugins into it
lecodes app open             # open it in Xcode, build & run
```

## Layout

- `main.ts` — the HTTP entry point. `dev-mock.ts` is the explicit mock entry.
- `tests/` — headless flow tests (`lecodes test`); failing steps dump the frame to
  `tests/.artifacts/`
- `CLAUDE.md` — guidance for AI assistants (the headless feedback loop + testability conventions)
- `assets/` — images/fonts the app references (created on demand)
- `tsconfig.json` + `.lecodes/types/` — generated IDE types (rewritten by the CLI; don't edit).
  They come from the SDK bundled in the CLI; `lecodes update` refreshes them from the platform.
- `.lecodes/` is gitignored — per-checkout state (those types + `manifest.json`, this machine's
  sync cursor once linked). After a fresh git clone: `lecodes update`, then
  `lecodes link --project <uuid>` to re-attach.
- `.lecodesignore` — files a future `lecodes push` would skip

Full command list: `lecodes --help`.
