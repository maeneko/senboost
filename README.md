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
npm run build:linux    # AppImage + .deb (x64)
```

## Обход блокировок по платформам

| Платформа | Движок                                                        | Права                                                 | Статус                               |
| --------- | ------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------ |
| Windows   | `winws` + драйвер WinDivert, служба `rknboost-zapret`         | UAC при первой настройке                              | стабильно, гарантированно работает   |
| macOS     | `utunws` (форк nfqws под utun+BPF) + правила pf, LaunchDaemon | пароль администратора при каждом включении/выключении | частично — движок портирован недавно |
| Linux     | `nfqws` + правила nftables (NFQUEUE)                          | пароль через `pkexec` при каждом включении/выключении | частично                             |

На всех трёх платформах — один и тот же движок zapret уровня пакетов (winws/nfqws/utunws —
одна и та же сборка `nfq/nfqws.c` под разный бэкенд), поэтому используется один набор из
22 стратегий Flowseal/zapret-discord-youtube.

На macOS для работы нужна версия 14 (Sonoma) или новее — движок собран под соответствующий
API ядра. Переотправка пакетов идёт через BPF на MAC-адрес шлюза, поэтому активный
VPN/туннель (маршрут по умолчанию уходит в свой utun) ломает обход — выключите другие VPN
перед включением. Как и на других платформах, полезно сменить DNS на сторонний
(1.1.1.1/8.8.8.8 или DNS-over-HTTPS) — блокировку по DNS сам zapret не лечит.
Принудительная остановка (если приложение недоступно):

```bash
sudo "/Library/Application Support/RKNboost/zapret/stop.sh"
```

На Linux дополнительно нужны пакеты `nftables` и `polkit` (в .deb — заявлены как зависимости
и ставятся сами; для AppImage — своими силами, `sudo apt install nftables policykit-1`).
Ни службы, ни автозапуска с системой на Linux нет: демон и правила nftables переживают выход
из приложения (правила закрыты флагом `bypass` — без работающего nfqws трафик просто проходит
как есть, а не блокируется), но после перезагрузки заново их никто не поднимает.

## Ссылки

- **[bol-van/zapret](https://github.com/bol-van/zapret)** — сам движок zapret, спасибо за столь хороший инструмент
- **[Flowseal/zapret-discord-youtube](https://github.com/Flowseal/zapret-discord-youtube)** —
  списки сайтов (`resources/zapret/lists/`), fake-пакеты (`resources/zapret/fakes/`) и все
  22 стратегии (`src/main/zapret/strategies.win32.generated.ts`).
- **[Flowseal/zapret-mac-discord-youtube](https://github.com/Flowseal/zapret-mac-discord-youtube)** —
  macOS-порт nfqws (`utunws`, `resources/zapret/darwin/`) и референс для привилегированных
  скриптов LaunchDaemon (`resources/darwin-helper/`).
- **[Sergeydigl3/zapret-discord-youtube-linux](https://github.com/Sergeydigl3/zapret-discord-youtube-linux)** —
  референс для Linux-порта: те же стратегии Flowseal через `nfqws`, nftables вместо WinDivert.
