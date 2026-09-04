#!/bin/sh
# Меняет RunAtLoad уже установленного LaunchDaemon без перезапуска демона и без разрыва
# pf-правил — root нужен только чтобы переписать защищённый plist в /Library/LaunchDaemons.
# Отдельный скрипт вместо повторного install.sh: переустановка перечитала бы и
# перекопировала utunws/fakes/strategy.cfg и пересобрала pf-правила заново — ради смены
# одного булева поля это лишний риск моргнуть сетью, которого нет у setServiceAutoStart()
# на Windows (`sc config start=`, тоже не трогает работающую службу).
set -eu

PLIST=/Library/LaunchDaemons/com.senboost.zapret.plist

if [ "$#" -ne 1 ]; then
    echo 'autostart.sh: ожидается 1 аргумент (0 или 1)' >&2
    exit 1
fi
case "$1" in
    0) RUNATLOAD=false ;;
    1) RUNATLOAD=true ;;
    *) echo 'autostart.sh: ожидается 0 или 1' >&2; exit 1 ;;
esac

[ -f "$PLIST" ] || { echo 'autostart.sh: демон не установлен' >&2; exit 1; }
/usr/bin/plutil -replace RunAtLoad -bool "$RUNATLOAD" "$PLIST"
