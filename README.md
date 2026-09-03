# RKNboost

очередная обертка под zapret

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

## Ссылки

- **[bol-van/zapret](https://github.com/bol-van/zapret)** — сам движок zapret, спасибо за столь хороший инструмент
- **[Flowseal/zapret-discord-youtube](https://github.com/Flowseal/zapret-discord-youtube)** —
  списки сайтов (`resources/zapret/lists/`) и fake-пакеты (`resources/zapret/fakes/`). (`FLOWSEAL_COMMIT`), лицензия —
  `LICENSE.flowseal.txt`.
