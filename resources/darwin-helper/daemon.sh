#!/bin/sh
# Супервизор обхода — то, что реально запускает launchd (com.rknboost.zapret.plist.in,
# ProgramArguments). Живёт под root, пока LaunchDaemon загружен; KeepAlive/SuccessfulExit
# в plist перезапускает этот скрипт заново при любом его завершении — поэтому определение
# интерфейса/MAC шлюза выполняется здесь при каждом старте (в том числе после смены сети),
# а не один раз в install.sh. Портировано из run.sh форка Flowseal/zapret-mac-discord-youtube
# (MIT) — та же логика с utunws через utun+BPF, свои идентификаторы (см. install.sh).
set -eu

DEST='/Library/Application Support/RKNboost/zapret'
ANCHOR=com.apple/rknboost
UTUN_UNIT=61
UTUN_IFACE=utun60
UTUN_LOCAL=10.78.0.1
UTUN_REMOTE=10.78.0.2
PIDFILE=/var/run/rknboost-zapret.pid
TOKEN_FILE=/var/run/rknboost-zapret.pf-token
ROUTE6_FILE=/var/run/rknboost-zapret.route6
ENGINE_PID=
WATCHDOG_PID=

if [ -L "$DEST" ] || [ ! -f "$DEST/strategy.cfg" ] || [ ! -f "$DEST/ports.conf" ]; then
    exit 1
fi
TCP_PORTS=$(/usr/bin/sed -n '1p' "$DEST/ports.conf")
UDP_PORTS=$(/usr/bin/sed -n '2p' "$DEST/ports.conf")
# ':' — диапазоны в синтаксисе pf (19294:19344), не дефис — см. install.sh.
case ",$TCP_PORTS," in *[!0-9,:]*) exit 1 ;; esac
case ",$UDP_PORTS," in *[!0-9,:]*) exit 1 ;; esac

clear_intercept() {
    /sbin/pfctl -a "$ANCHOR" -F all >/dev/null 2>&1 || true
}

release_pf_token() {
    if [ -s "$TOKEN_FILE" ]; then
        TOKEN=$(/bin/cat "$TOKEN_FILE" 2>/dev/null || true)
        if [ -n "$TOKEN" ]; then /sbin/pfctl -X "$TOKEN" >/dev/null 2>&1 || true; fi
        /bin/rm -f "$TOKEN_FILE"
    fi
}

cleanup() {
    trap - EXIT INT TERM HUP
    clear_intercept
    if [ -n "$WATCHDOG_PID" ]; then kill "$WATCHDOG_PID" >/dev/null 2>&1 || true; fi
    if [ -n "$ENGINE_PID" ]; then kill "$ENGINE_PID" >/dev/null 2>&1 || true; fi
    if [ -n "$WATCHDOG_PID" ]; then wait "$WATCHDOG_PID" >/dev/null 2>&1 || true; fi
    if [ -n "$ENGINE_PID" ]; then wait "$ENGINE_PID" >/dev/null 2>&1 || true; fi
    release_pf_token
    /bin/rm -f "$PIDFILE"
}

trap cleanup EXIT INT TERM HUP
clear_intercept
/usr/bin/pkill -9 -f "$DEST/bin/utunws" >/dev/null 2>&1 || true

PHYSICAL_IFACE=$(/sbin/route -n get default | /usr/bin/awk '/interface:/{print $2; exit}')
GATEWAY=$(/sbin/route -n get default | /usr/bin/awk '/gateway:/{print $2; exit}')
# Нет маршрута по умолчанию или он смотрит не в физический интерфейс (например, весь
# трафик уже уходит в VPN/другой utun) — переотправка через BPF работать не будет, честная
# ошибка вместо демона, который поднялся, но ничего не десинхронизирует.
if [ -z "$PHYSICAL_IFACE" ] || [ -z "$GATEWAY" ]; then exit 1; fi
/sbin/ping -c 1 -t 1 "$GATEWAY" >/dev/null 2>&1 || true
GATEWAY_MAC=$(/usr/sbin/arp -n "$GATEWAY" | /usr/bin/awk '/ at /{print $4; exit}')
case "$GATEWAY_MAC" in
    *:*:*:*:*:*) ;;
    *) exit 1 ;;
esac

GATEWAY6_MAC=
if /sbin/route -n get -inet6 default >"$ROUTE6_FILE" 2>/dev/null; then
    GATEWAY6=$(/usr/bin/awk '/gateway:/{print $2; exit}' "$ROUTE6_FILE")
    if [ -n "$GATEWAY6" ]; then
        GATEWAY6_MAC=$(/usr/sbin/ndp -n "$GATEWAY6" 2>/dev/null | /usr/bin/awk '/ at |%/{for(i=1;i<=NF;i++) if($i ~ /^([0-9a-f]{1,2}:){5}[0-9a-f]{1,2}$/){print $i; exit}}')
    fi
fi
/bin/rm -f "$ROUTE6_FILE"

export ZAPRET_IFACE="$PHYSICAL_IFACE"
export ZAPRET_GATEWAY_MAC="$GATEWAY_MAC"
export ZAPRET_GATEWAY6_MAC="$GATEWAY6_MAC"
export ZAPRET_UTUN_UNIT=$UTUN_UNIT
"$DEST/bin/utunws" --pidfile="$PIDFILE" "@$DEST/strategy.cfg" >>"$DEST/engine.log" 2>&1 &
ENGINE_PID=$!

I=0
while ! /sbin/ifconfig "$UTUN_IFACE" >/dev/null 2>&1; do
    I=$((I + 1))
    if ! kill -0 "$ENGINE_PID" 2>/dev/null || [ "$I" -gt 100 ]; then exit 1; fi
    sleep 0.1
done
/sbin/ifconfig "$UTUN_IFACE" "$UTUN_LOCAL" "$UTUN_REMOTE" netmask 255.255.255.255 up
# utunws сам пишет pidfile до начала работы (fopen до цикла чтения utun) — chmod здесь
# только на случай нестандартного umask, чтобы sync()/наблюдатель читали его без root.
/bin/chmod 0644 "$PIDFILE" 2>/dev/null || true
"$DEST/watchdog.sh" $$ "$ENGINE_PID" &
WATCHDOG_PID=$!

if /sbin/pfctl -s info 2>/dev/null | /usr/bin/grep -q '^Status: Disabled'; then
    TOKEN=$(/sbin/pfctl -E 2>&1 | /usr/bin/awk '/Token :/ { print $3 }')
    if [ -n "$TOKEN" ]; then /bin/echo "$TOKEN" >"$TOKEN_FILE"; fi
fi

printf '%s\n' \
  "pass out quick route-to ($UTUN_IFACE $UTUN_REMOTE) inet proto tcp from any to any port {$TCP_PORTS} user { >root } no state" \
  "pass out quick route-to ($UTUN_IFACE $UTUN_REMOTE) inet proto udp from any to any port {$UDP_PORTS} user { >root } no state" \
  | /sbin/pfctl -a "$ANCHOR" -f -

# Смена сети (Wi-Fi ↔ Ethernet, новый шлюз при DHCP-обновлении) делает пойманный при старте
# gateway MAC неверным — переотправка на старый MAC уходит в никуда. Выход отсюда с ошибкой
# перезапускает весь скрипт заново через KeepAlive плиста, включая переопределение шлюза.
while kill -0 "$ENGINE_PID" 2>/dev/null; do
    sleep 2
    CURRENT_IFACE=$(/sbin/route -n get default 2>/dev/null | /usr/bin/awk '/interface:/{print $2; exit}')
    CURRENT_GATEWAY=$(/sbin/route -n get default 2>/dev/null | /usr/bin/awk '/gateway:/{print $2; exit}')
    if [ "$CURRENT_IFACE" != "$PHYSICAL_IFACE" ] || [ "$CURRENT_GATEWAY" != "$GATEWAY" ]; then exit 1; fi
done
exit 1
