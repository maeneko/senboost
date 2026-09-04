#!/bin/sh
# Привилегированная остановка обхода блокировок на macOS. Без аргументов — вызывается и как
# osascript-точка входа из utunws.darwin.ts (выключение обхода), и напрямую (уже под root,
# без повторной элевации) из install.sh, когда новая установка не поднялась.
#
# Полный снос, а не пауза: LaunchDaemon, strategy.cfg, pf-правила — всё убирается. Обратное
# решение (оставить демона установленным и просто «выключенным», как служба на Windows) не
# подходит здесь — на macOS нет отдельного «выключенного» состояния для LaunchDaemon кроме
# unload/bootout, так что «выключить» и «удалить установку» здесь одно и то же действие.
# Настройка автозапуска (RunAtLoad) значения не теряет — она хранится в приложении и
# применяется заново при следующем включении (см. engine.darwin.ts).
set -eu

LABEL=com.rknboost.zapret
ANCHOR=com.apple/rknboost
DEST='/Library/Application Support/RKNboost/zapret'
PLIST=/Library/LaunchDaemons/$LABEL.plist
PIDFILE=/var/run/rknboost-zapret.pid
TOKEN_FILE=/var/run/rknboost-zapret.pf-token
KEEPINIT_FILE=/var/db/rknboost-zapret.keepinit

/bin/launchctl disable system/"$LABEL" >/dev/null 2>&1 || true
/bin/launchctl bootout system/"$LABEL" >/dev/null 2>&1 || true
/sbin/pfctl -a "$ANCHOR" -F all >/dev/null 2>&1 || true
# См. install.sh про то, почему по полному пути, а не по имени процесса.
/usr/bin/pkill -9 -f "$DEST/bin/utunws" >/dev/null 2>&1 || true
/bin/rm -f "$PIDFILE" "$PLIST"

if [ -s "$TOKEN_FILE" ]; then
    TOKEN=$(/bin/cat "$TOKEN_FILE" 2>/dev/null || true)
    if [ -n "$TOKEN" ]; then /sbin/pfctl -X "$TOKEN" >/dev/null 2>&1 || true; fi
    /bin/rm -f "$TOKEN_FILE"
fi
if [ -s "$KEEPINIT_FILE" ]; then
    KEEPINIT=$(/bin/cat "$KEEPINIT_FILE" 2>/dev/null || true)
    case "$KEEPINIT" in
        *[!0-9]*|'') ;;
        *) /usr/sbin/sysctl -w "net.inet.tcp.keepinit=$KEEPINIT" >/dev/null 2>&1 || true ;;
    esac
    /bin/rm -f "$KEEPINIT_FILE"
fi
