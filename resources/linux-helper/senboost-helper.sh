#!/bin/sh
# Привилегированный помощник обхода блокировок на Linux — единственное, что SenBoost
# запускает через `pkexec`. Не редактировать под bash-специфику: /bin/sh на Debian/Ubuntu —
# это dash, а не bash.
#
# Зовётся из src/main/zapret/nfqws.linux.ts ровно двумя способами:
#   pkexec <этот файл> start <nfqws> <strategy.cfg> <tcp-порты> <udp-порты>
#   pkexec <этот файл> stop
#
# Всё, что можно решить без root (выбор стратегии, генерация strategy.cfg, проверка
# `nfqws --dry-run`), уже сделано на стороне приложения — сюда попадают только готовые пути
# и уже провалидированные строки портов (см. nfqwsConfig() в strategies.ts: там же формат
# портов проверен регуляркой, здесь ему просто доверяем). Раздельные пути/аргументы вместо
# одной строки — чтобы этот скрипт не собирал команду nft из чего-то похожего на shell-код.
#
# Коды выхода — намеренно 3..6, чтобы не путаться с 126/127 самого pkexec (отказ в правах /
# команда не найдена) при разборе результата на стороне приложения.
set -eu

RUN_DIR=/run/senboost
PIDFILE="$RUN_DIR/nfqws.pid"
CONFIG="$RUN_DIR/strategy.cfg"
ERRLOG="$RUN_DIR/nfqws.err"
TABLE_FAMILY=inet
TABLE_NAME=senboost
# Держать в синхроне с NFQUEUE_NUM в nfqws.linux.ts (используется там же для --dry-run).
QUEUE_NUM=220
FW_MARK=0x40000000

log() {
  echo "senboost-helper: $*" >&2
}

# pkexec запускает с урезанным PATH (санирует окружение) — sbin, где обычно лежит nft,
# в нём может не быть. Ищем явно по стандартным местам, а не полагаемся на PATH.
find_nft() {
  for candidate in /usr/sbin/nft /sbin/nft /usr/local/sbin/nft /usr/bin/nft; do
    if [ -x "$candidate" ]; then
      echo "$candidate"
      return 0
    fi
  done
  if command -v nft >/dev/null 2>&1; then
    command -v nft
    return 0
  fi
  return 1
}

# Сносит и таблицу, и демона. Идёт первым шагом `start` (самолечение: следующий успешный
# запуск убирает любой мусор от аварийно прерванной прошлой сессии) и отдельной командой
# `stop`. Всегда завершается успешно — «уже остановлено» не ошибка, тот же принцип, что и
# у stopService() на Windows.
cmd_stop() {
  nft="${1:-}"

  if [ -f "$PIDFILE" ]; then
    pid="$(cat "$PIDFILE" 2>/dev/null || true)"
    # /proc/<pid>/comm — это ровно "nfqws\n" (обрезано до 15 символов ядром, но nfqws
    # короче), сверяем, чтобы не убить чужой процесс, переиспользовавший тот же pid.
    if [ -n "$pid" ] && [ -r "/proc/$pid/comm" ] && [ "$(cat "/proc/$pid/comm" 2>/dev/null)" = "nfqws" ]; then
      kill -TERM "$pid" 2>/dev/null || true
      i=0
      while [ -d "/proc/$pid" ] && [ "$i" -lt 30 ]; do
        i=$((i + 1))
        sleep 0.1
      done
      if [ -d "/proc/$pid" ]; then
        kill -KILL "$pid" 2>/dev/null || true
      fi
    fi
    rm -f "$PIDFILE"
  fi

  rm -f "$CONFIG" "$ERRLOG"

  if [ -z "$nft" ]; then
    nft="$(find_nft || true)"
  fi
  if [ -n "$nft" ] && "$nft" list table "$TABLE_FAMILY" "$TABLE_NAME" >/dev/null 2>&1; then
    "$nft" delete table "$TABLE_FAMILY" "$TABLE_NAME" 2>/dev/null || true
  fi
}

cmd_start() {
  nfqws_bin="$1"
  config_src="$2"
  tcp_ports="$3"
  udp_ports="$4"

  nft="$(find_nft || true)"
  if [ -z "$nft" ]; then
    log "не найдена утилита nft (пакет nftables)"
    exit 3
  fi

  # На всякий случай предупреждаем, если параллельно уже висит другой zapret со своей
  # таблицей/очередью — двойной приём одного трафика в две очереди работать не будет,
  # но это не наша таблица, сносить её самовольно нельзя.
  if "$nft" list table inet zapret >/dev/null 2>&1 || "$nft" list table inet zapretunix >/dev/null 2>&1; then
    log "внимание: обнаружена таблица nftables другого zapret-инструмента — возможен конфликт очередей"
  fi

  cmd_stop "$nft"

  mkdir -p "$RUN_DIR"
  chmod 0755 "$RUN_DIR"

  # strategy.cfg в /run — источник маркера стратегии для LinuxEngine.sync(): читается без
  # root (0644), первая строка — тот же --comment=senboost:<id>:<hash>, что и на Windows.
  cp "$config_src" "$CONFIG"
  chmod 0644 "$CONFIG"

  if ! "$nft" add table "$TABLE_FAMILY" "$TABLE_NAME"; then
    log "не удалось создать таблицу nftables"
    cmd_stop "$nft"
    exit 4
  fi
  "$nft" add chain "$TABLE_FAMILY" "$TABLE_NAME" post '{ type filter hook postrouting priority mangle; }'
  "$nft" add chain "$TABLE_FAMILY" "$TABLE_NAME" pre '{ type filter hook prerouting priority filter; }'

  # bypass обязателен: без него при завершении/падении nfqws весь трафик на эти порты
  # молча дропался бы. С bypass ядро принимает пакет, если очередь никто не слушает —
  # то есть отключение обхода (или его крах) не рвёт пользователю сеть.
  ok=1
  "$nft" add rule "$TABLE_FAMILY" "$TABLE_NAME" post \
    meta mark and $FW_MARK == 0 tcp dport "{$tcp_ports}" \
    ct original packets 1-6 queue num $QUEUE_NUM bypass || ok=0
  "$nft" add rule "$TABLE_FAMILY" "$TABLE_NAME" post \
    meta mark and $FW_MARK == 0 udp dport "{$udp_ports}" \
    ct original packets 1-6 queue num $QUEUE_NUM bypass || ok=0
  "$nft" add rule "$TABLE_FAMILY" "$TABLE_NAME" pre \
    tcp sport "{$tcp_ports}" \
    ct reply packets 1-3 queue num $QUEUE_NUM bypass || ok=0

  if [ "$ok" -ne 1 ]; then
    log "не удалось создать правила nftables"
    cmd_stop "$nft"
    exit 4
  fi

  # nfq_init() у nfqws происходит до daemonize() — если очередь занята, модуля нет в ядре
  # или не хватает прав, процесс завершится с ненулевым кодом ДО демонизации, и мы это
  # увидим здесь же, без опроса готовности.
  if ! "$nfqws_bin" --daemon \
    --pidfile="$PIDFILE" \
    --qnum=$QUEUE_NUM \
    --dpi-desync-fwmark=$FW_MARK \
    "@$CONFIG" 2>"$ERRLOG"; then
    log "nfqws не запустился: $(cat "$ERRLOG" 2>/dev/null || true)"
    cmd_stop "$nft"
    exit 5
  fi

  exit 0
}

action="${1:-}"
case "$action" in
  start)
    shift
    if [ "$#" -ne 4 ]; then
      log "start ожидает 4 аргумента: <nfqws> <config> <tcp-порты> <udp-порты>"
      exit 6
    fi
    cmd_start "$1" "$2" "$3" "$4"
    ;;
  stop)
    cmd_stop ""
    ;;
  *)
    log "неизвестная команда: $action (ожидается start|stop)"
    exit 6
    ;;
esac
