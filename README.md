# RKNboost

[github.com/maeneko/rknboost](https://github.com/maeneko/rknboost)

## Требования

- Node.js 20+ (проверено на 24)
- npm 10+

## Команды

```bash
npm install        # зависимости + скачивание бинарника Electron
npm run dev        # dev-режим: HMR для UI, авто-рестарт main-процесса
npm run start      # запуск собранной версии без упаковки
npm run build      # typecheck + сборка main/preload/renderer в out/
npm run lint       # ESLint
npm run format     # Prettier
npm run typecheck  # tsc для node- и web-частей отдельно

npm run build:unpack   # быстрая проверка: приложение без установщика (release/*-unpacked)
npm run build:mac      # .dmg + .zip  (x64 + arm64)
npm run build:win      # NSIS .exe    (x64; arm64 не собираем — нет подписанного WinDivert)
npm run build:linux    # AppImage + .deb
```

> Установщики под чужую ОС локально собрать нельзя — для этого есть CI
> (`.github/workflows/ci.yml` собирает все три платформы и кладёт артефакты в Actions).

> Если после `npm install` команда `npm run dev` падает с `Error: Electron uninstall` —
> бинарник Electron не докачался; исправляется повторным запуском
> `node node_modules/electron/install.js`.

## Структура

```
src/
  main/         # Node-процесс: окна, меню, доступ к ОС
    index.ts      lifecycle приложения, single instance
    window.ts     createWindow / createPopupWindow, настройки безопасности
    ipc.ts        все ipcMain.handle
  preload/      # мост между main и renderer (sandbox, contextBridge)
  shared/       # ipc-contract.ts — типы каналов, общие для всех процессов
  renderer/     # React-приложение (обычный браузерный код, без Node API)
build/          # иконки и entitlements для electron-builder
resources/      # файлы, попадающие в собранное приложение (иконка окна)
out/            # результат electron-vite build
release/        # готовые установщики
```

## Как добавить свой IPC-канал

1. Опишите канал в `src/shared/ipc-contract.ts` (аргументы и результат).
2. Зарегистрируйте обработчик в `src/main/ipc.ts` через хелпер `handle(...)` — типы проверятся.
3. Добавьте метод в объект `api` в `src/preload/index.ts`.
4. Вызывайте из React как `window.api.мойМетод()` — тип подтянется автоматически.

События из main в renderer описываются в `IpcEvents` и подписываются через `subscribe(...)`
(пример — `onThemeChanged`, возвращает функцию отписки для `useEffect`).

## Что показывают демо-карточки

| Карточка         | Каналы                                    | Что демонстрирует                                             |
| ---------------- | ----------------------------------------- | ------------------------------------------------------------- |
| Система          | `app:info`                                | версии Electron/Chromium/Node, платформа, путь к userData     |
| IPC ping         | `ping`                                    | минимальный invoke/handle                                     |
| Нативный диалог  | `dialog:open-file`                        | системный выбор файла + `fs.stat` в main                      |
| Всплывающее окно | `dialog:message-box`, `window:open-popup` | модальный диалог ОС и второе `BrowserWindow`                  |
| Тема оформления  | `theme:*`                                 | `nativeTheme` как источник правды, реакция на смену темы в ОС |

Тайтлбар системный на всех платформах — окно создаётся без `frame`/`titleBarStyle`, рамку
и кнопки свернуть/развернуть/закрыть рисует сама ОС.

## Безопасность

- `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`;
- renderer не имеет доступа к `ipcRenderer` — только к методам из `window.api`;
- `setWindowOpenHandler` и `will-navigate` не дают уйти на внешний origin, ссылки открываются
  в системном браузере, причём только с протоколами из `ALLOWED_EXTERNAL_PROTOCOLS`;
- в `index.html` задан CSP без внешних источников.

## Иконки

`build/icon.png` (1024×1024) — исходник, из него electron-builder делает иконки для всех платформ;
`build/icon.icns` и `build/icon.ico` лежат рядом как готовые варианты. `resources/icon.png` —
иконка окна для Linux. Замените эти файлы своими, имена оставьте прежними.

## Подпись и нотаризация

По умолчанию выключены (`notarize: false`), сборки неподписанные — их можно запускать локально,
но macOS покажет предупреждение Gatekeeper при переносе на другую машину.

Чтобы включить:

- **macOS**: переменные окружения `CSC_LINK` (base64 сертификата Developer ID) и `CSC_KEY_PASSWORD`,
  плюс `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` и `notarize: true`
  в `electron-builder.yml`.
- **Windows**: `CSC_LINK` и `CSC_KEY_PASSWORD` с .pfx-сертификатом.

В CI эти значения передаются секретами GitHub — место уже отмечено комментарием в
`.github/workflows/ci.yml`.

## Обход блокировок (zapret)

Движки и данные — из двух сторонних проектов, оба MIT, оба скачиваются `npm run zapret:fetch`
(вызывается автоматически из `npm run build`) в `resources/zapret/` (в git не хранится):

- **[bol-van/zapret](https://github.com/bol-van/zapret)** — сами движки: `tpws` (macOS, SOCKS5-прокси
  без root) и `winws.exe` + драйвер **WinDivert** (Windows, служба с правами администратора).
  WinDivert — LGPLv3/GPLv2 на выбор; лицензии обоих проектов кладутся рядом с бинарниками
  (`LICENSE.zapret.txt`, `LICENSE.WinDivert.txt`).
- **[Flowseal/zapret-discord-youtube](https://github.com/Flowseal/zapret-discord-youtube)** —
  списки сайтов (`resources/zapret/lists/`) и fake-пакеты (`resources/zapret/fakes/`). Версия
  зафиксирована по sha коммита в `scripts/fetch-zapret.mjs` (`FLOWSEAL_COMMIT`), лицензия —
  `LICENSE.flowseal.txt`.

Свои сгенерированные стратегии для Windows (`src/main/zapret/strategies.win32.generated.ts`,
22 варианта) — не батники: `scripts/import-flowseal-strategies.mjs` разбирает `general*.bat`
из того же репозитория Flowseal и переносит аргументы `winws` в TypeScript. Файл коммитится;
перегенерировать и свериться через `git diff` нужно вручную при обновлении `FLOWSEAL_COMMIT`.
На macOS `tpws` не умеет ни fake-пакетов, ни UDP — там свои профили
(`src/main/zapret/strategies.ts`, раздел `DARWIN_DEFINITIONS`) поверх тех же списков.

Списки сайтов пользователь может редактировать полностью (включая встроенные) — рабочая копия
живёт в `userData/zapret-lists` и переживает обновление приложения; `tpws`/`winws` сами
перечитывают список при изменении файла, перезапуск обхода не нужен (`src/main/zapret/lists.ts`).

### Windows: служба и права

`winws` требует драйвер WinDivert и права администратора, поэтому на Windows он работает не как
обычный дочерний процесс, а как служба Windows `rknboost-zapret` (`src/main/zapret/service.win32.ts`).
Устанавливает и настраивает её само приложение — не инсталлятор, — потому что аргументы `winws`
зависят от выбранной пользователем стратегии.

- **Приложение запрашивает права администратора при каждом запуске**
  (`win.requestedExecutionLevel: requireAdministrator` в `electron-builder.yml`). Поэтому все
  действия со службой выполняются напрямую, без отдельных запросов UAC по ходу работы.
  Если приложение почему-то запущено без прав (dev-режим — там манифеста нет), включается
  запасной путь: `outer.ps1` через `Start-Process -Verb RunAs` поднимает само приложение
  с флагом `--elevated-service-task`, и UAC запрашивается на него, а не на `powershell.exe` —
  в окне UAC пользователь должен видеть имя приложения, а не постороннюю программу.
  При установке службы обычным пользователям выдаётся право на `start`/`stop` именно этой
  службы (`sc sdset`), так что и без прав включение-выключение обхода работает.
- **Автозапуск с системой** включён по умолчанию (`sc config start= auto`) — обход работает и
  после перезагрузки, не дожидаясь запуска приложения. Отключается переключателем в настройках
  (тоже через UAC). Выключение обхода кнопкой на главном экране действует только до следующей
  перезагрузки, если автозапуск остался включён — служба поднимется вместе с системой заново.
- **arm64 не поддерживается**: у WinDivert нет подписанной сборки под arm64 (только x64 через
  эмуляцию на Windows 11), поэтому `electron-builder.yml` собирает Windows-инсталлятор только
  для x64.
- Установщик — **per-user** (ставится в `%LocalAppData%`, один клик, без UAC на саму установку).

  > ⚠️ Известный компромисс. Каталог установки доступен на запись обычному пользователю, а exe
  > при этом требует администратора — значит подмена `RKNboost.exe` даёт злоумышленнику права
  > администратора с подтверждения самого пользователя. Это осознанный выбор владельца проекта
  > в пользу быстрой установки без UAC. Безопасный вариант — `perMachine: true`, тогда exe лежит
  > в защищённом от записи `Program Files`, но установка снова требует UAC и мастера.

  Служба работает от `LocalSystem`, и её `binPath` не должен указывать в каталог, куда обычный
  пользователь может писать без прав администратора — поэтому при первом включении обхода
  приложение копирует `winws.exe` и WinDivert в защищённый ACL'ом
  каталог в `%ProgramData%` (`protectedWinwsPath()` в `src/main/zapret/paths.ts`) и указывает
  службе именно на эту копию, а не на оригинал в папке установки. При удалении приложения
  деинсталлятор (`build/installer.nsh`) сам останавливает и снимает службу вместе с этой копией.

- На одну машину служба одна: её конфиг (`%ProgramData%\rknboost\zapret\strategy.cfg`) хранит
  стратегию того пользователя, который последним её менял, — с несколькими пользователями на
  одной машине это разделяется некорректно.

## Авто-обновления

Не подключены. Если понадобятся: `npm i electron-updater`, добавить секцию `publish`
в `electron-builder.yml` и вызвать `autoUpdater.checkForUpdatesAndNotify()` в `src/main/index.ts`.
