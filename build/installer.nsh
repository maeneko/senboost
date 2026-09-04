; Служба senboost-zapret не ставится этим установщиком — её создаёт и настраивает само
; приложение при первом включении обхода (src/main/zapret/service.win32.ts), потому что
; аргументы winws зависят от выбранной пользователем стратегии. Но снять её при удалении
; приложения обязаны мы: иначе в системе остаётся служба, указывающая на удалённый winws.exe.
;
; Установка теперь per-user (perMachine: false в electron-builder.yml) — сам деинсталлятор
; запускается БЕЗ прав администратора, а sc delete и удаление %ProgramData% их требуют.
; Поэтому именно для этого шага отдельно запрашиваем UAC (тем же приёмом Start-Process
; -Verb RunAs, что и src/main/zapret/service.win32.ts), а не поднимаем весь деинсталлятор —
; удаление файлов приложения из %LocalAppData% в повышении не нуждается.
;
; Тем же повышенным вызовом снимаем задачу автозапуска приложения («SenBoost Autostart»,
; src/main/app-autostart.win32.ts): она создана с правами администратора и после удаления
; приложения указывала бы на несуществующий exe.

!macro customUnInstall
  DetailPrint "Останавливаю службу обхода блокировок и снимаю автозапуск..."
  nsExec::Exec `powershell.exe -NoProfile -Command "try { Start-Process powershell -Verb RunAs -Wait -ArgumentList @('-NoProfile','-Command','sc.exe stop senboost-zapret; sc.exe delete senboost-zapret; schtasks.exe /Delete /TN ''SenBoost Autostart'' /F; Remove-Item -Recurse -Force $$env:ProgramData\senboost -ErrorAction SilentlyContinue') } catch {}"`
  Pop $0
!macroend
