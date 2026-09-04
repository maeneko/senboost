#!/bin/sh
# Привилегированная установка обхода блокировок на macOS — единственное, что SenBoost
# запускает через osascript "with administrator privileges" (см. elevate.darwin.ts) для
# включения обхода. Не редактировать под bash-специфику: этот файл исполняется как
# /bin/sh — на macOS это тот же путь, что и на Linux, но лучше не полагаться на bashisms.
#
# Зовётся из src/main/zapret/utunws.darwin.ts ровно так:
#   osascript … 'do shell script "'\''<этот файл>'\'' '\''<utunws>'\'' …" with administrator privileges'
#
# Аргументы (все уже подготовлены и провалидированы на стороне приложения — сюда попадают
# только готовые пути и провалидированные строки портов, тот же принцип, что у Linux-
# помощника resources/linux-helper/senboost-helper.sh):
#   1: utunws_src   — путь к бинарнику utunws в resources/zapret/darwin (ещё не установлен)
#   2: fakes_src    — каталог с fake-пакетами (resources/zapret/fakes)
#   3: config_src   — уже отрендеренный strategy.cfg (маркер --comment=senboost:<id>:<hash>
#                      первой строкой, пути {LISTS}/{FAKES} уже резолвлены — см. strategies.ts)
#   4: tcp_ports    — список портов TCP для pf, формат "80,443,8443" (уже проверен регуляркой
#                      в packetEngineConfig())
#   5: udp_ports    — то же для UDP
#   6: run_at_load  — 0 или 1: должен ли демон переживать перезагрузку системы без
#                      запущенного приложения (настройка «Автозапуск» в интерфейсе)
set -eu

HELPER_DIR=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
DEST='/Library/Application Support/SenBoost/zapret'
LABEL=com.senboost.zapret
PLIST=/Library/LaunchDaemons/$LABEL.plist
ANCHOR=com.apple/senboost
PIDFILE=/var/run/senboost-zapret.pid
TOKEN_FILE=/var/run/senboost-zapret.pf-token
KEEPINIT_FILE=/var/db/senboost-zapret.keepinit

if [ "$#" -ne 6 ]; then
    echo 'install.sh: ожидается 6 аргументов' >&2
    exit 1
fi
UTUNWS_SRC=$1
FAKES_SRC=$2
CONFIG_SRC=$3
TCP_PORTS=$4
UDP_PORTS=$5
RUN_AT_LOAD=$6

[ -x "$UTUNWS_SRC" ] || { echo 'install.sh: не найден бинарник utunws' >&2; exit 1; }
[ -d "$FAKES_SRC" ] || { echo 'install.sh: не найден каталог fake-пакетов' >&2; exit 1; }
[ -f "$CONFIG_SRC" ] || { echo 'install.sh: не найден strategy.cfg' >&2; exit 1; }
# Формат уже проверен регуляркой в packetEngineConfig()/utunwsConfig() — здесь просто не
# доверяем слепо тому, что дошло до root, тот же приём, что в senboost-helper.sh на Linux.
# ':' — не опечатка: utunwsConfig() переводит диапазоны в синтаксис pf (19294-19344 →
# 19294:19344, см. toPfPortRanges() в strategies.ts), дефисов в этих строках уже нет.
case ",$TCP_PORTS," in *[!0-9,:]*) echo 'install.sh: странный формат tcp-портов' >&2; exit 1 ;; esac
case ",$UDP_PORTS," in *[!0-9,:]*) echo 'install.sh: странный формат udp-портов' >&2; exit 1 ;; esac
case "$RUN_AT_LOAD" in
    0) RUNATLOAD=false ;;
    1) RUNATLOAD=true ;;
    *) echo 'install.sh: run_at_load должен быть 0 или 1' >&2; exit 1 ;;
esac

# Сносим прошлую установку — самолечение на случай аварийно прерванной прошлой сессии,
# тот же приём, что cmd_stop() в senboost-helper.sh на Linux делает первым шагом start.
/bin/launchctl bootout system/"$LABEL" >/dev/null 2>&1 || true
/sbin/pfctl -a "$ANCHOR" -F all >/dev/null 2>&1 || true
# Матчим процесс по полному пути НАШЕЙ установки, а не по имени: "utunws" называется так
# же и у независимо установленного Flowseal/zapret-mac-discord-youtube — pkill -x убил бы
# чужой процесс, если пользователь пользуется обоими приложениями одновременно.
/usr/bin/pkill -9 -f "$DEST/bin/utunws" >/dev/null 2>&1 || true
if [ -s "$TOKEN_FILE" ]; then
    TOKEN=$(/bin/cat "$TOKEN_FILE" 2>/dev/null || true)
    if [ -n "$TOKEN" ]; then /sbin/pfctl -X "$TOKEN" >/dev/null 2>&1 || true; fi
    /bin/rm -f "$TOKEN_FILE"
fi
/bin/rm -f "$PIDFILE"

# Копия, а не запуск прямо из resources/zapret приложения: root не должен исполнять файл
# из каталога, куда обычный пользователь может писать (то же рассуждение, что у
# protectedWinwsPath() в paths.ts на Windows). daemon.sh/watchdog.sh лежат рядом с этим
# скриптом в bundledDarwinHelperDir() — тоже часть сборки, тоже копируем в защищённое место.
/bin/rm -rf "$DEST/bin" "$DEST/fakes"
/bin/mkdir -p "$DEST/bin" "$DEST/fakes"
/usr/bin/ditto "$UTUNWS_SRC" "$DEST/bin/utunws"
/usr/bin/ditto "$FAKES_SRC" "$DEST/fakes"
/usr/bin/ditto "$HELPER_DIR/daemon.sh" "$DEST/daemon.sh"
/usr/bin/ditto "$HELPER_DIR/watchdog.sh" "$DEST/watchdog.sh"
# Скачанный релиз-архив помечен com.apple.quarantine — карантин на исполняемый файл внутри
# защищённого каталога, который запускает launchd, только мешал бы.
/usr/bin/xattr -dr com.apple.quarantine "$DEST" >/dev/null 2>&1 || true

/usr/bin/install -m 0644 "$CONFIG_SRC" "$DEST/strategy.cfg"
printf '%s\n%s\n' "$TCP_PORTS" "$UDP_PORTS" > "$DEST/ports.conf"

/usr/sbin/chown -R root:wheel "$DEST"
/bin/chmod 755 "$DEST" "$DEST/bin" "$DEST/bin/utunws" "$DEST/daemon.sh" "$DEST/watchdog.sh" "$DEST/fakes"
/bin/chmod 644 "$DEST/strategy.cfg" "$DEST/ports.conf"

/usr/bin/sed \
    -e "s|@LABEL@|$LABEL|g" \
    -e "s|@DEST@|$DEST|g" \
    -e "s|@RUNATLOAD@|$RUNATLOAD|g" \
    "$HELPER_DIR/com.senboost.zapret.plist.in" > "$PLIST"
/usr/sbin/chown root:wheel "$PLIST"
/bin/chmod 644 "$PLIST"

# net.inet.tcp.keepinit=7000 удлиняет время до TCP RST на этапе установления соединения —
# desync нужно время сработать. Сохраняем исходное значение один раз, откатываем в stop.sh.
if [ ! -s "$KEEPINIT_FILE" ]; then
    /usr/sbin/sysctl -n net.inet.tcp.keepinit > "$KEEPINIT_FILE"
    /bin/chmod 600 "$KEEPINIT_FILE"
fi
/usr/sbin/sysctl -w net.inet.tcp.keepinit=7000 >/dev/null

/bin/launchctl enable system/"$LABEL"
I=0
while ! /bin/launchctl bootstrap system "$PLIST"; do
    I=$((I + 1))
    if [ "$I" -gt 10 ]; then
        /bin/sh "$HELPER_DIR/stop.sh"
        exit 1
    fi
    sleep 0.5
done
/bin/launchctl kickstart -k system/"$LABEL"

I=0
while ! /sbin/ifconfig utun60 >/dev/null 2>&1; do
    I=$((I + 1))
    if [ "$I" -gt 100 ]; then
        /bin/sh "$HELPER_DIR/stop.sh"
        echo 'install.sh: utunws не поднялся' >&2
        /usr/bin/tail -n 40 "$DEST/engine.log" >&2 2>/dev/null || true
        exit 1
    fi
    sleep 0.1
done
