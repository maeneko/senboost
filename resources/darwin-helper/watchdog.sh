#!/bin/sh
# Подчищает pf, если daemon.sh (супервизор) умер, не успев выполнить свой cleanup() —
# например, получил SIGKILL. Без этого правило route-to пережило бы демона, и трафик на
# заблокированные порты уходил бы в мёртвый utun вместо прохождения как обычно (pf-правило
# не имеет bypass-семантики, в отличие от очереди NFQUEUE на Linux). Портировано из
# watchdog.sh форка Flowseal/zapret-mac-discord-youtube (MIT) без изменений логики.
SUPERVISOR_PID=$1
ENGINE_PID=$2
ANCHOR=com.apple/senboost
TOKEN_FILE=/var/run/senboost-zapret.pf-token

while kill -0 "$SUPERVISOR_PID" 2>/dev/null && kill -0 "$ENGINE_PID" 2>/dev/null; do
    sleep 0.2
done

/sbin/pfctl -a "$ANCHOR" -F all >/dev/null 2>&1 || true
kill "$ENGINE_PID" >/dev/null 2>&1 || true
if [ -s "$TOKEN_FILE" ]; then
    TOKEN=$(/bin/cat "$TOKEN_FILE" 2>/dev/null || true)
    if [ -n "$TOKEN" ]; then /sbin/pfctl -X "$TOKEN" >/dev/null 2>&1 || true; fi
    /bin/rm -f "$TOKEN_FILE"
fi
