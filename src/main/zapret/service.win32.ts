import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { app } from 'electron'
import {
  ELEVATED_TASK_FLAG,
  TASK_FILES,
  isElevated,
  runElevatedServiceTask
} from './elevated-task.win32'
import { serviceConfigPath, serviceDataDir, winwsPath } from './paths'

const run = promisify(execFile)

export const SERVICE_NAME = 'rknboost-zapret'

const POLL_INTERVAL_MS = 300
const POLL_TIMEOUT_MS = 10000

/** Код возврата Windows для «пользователь отклонил запрос UAC» (ERROR_CANCELLED). */
const UAC_CANCELLED_CODE = 1223

/**
 * `sc.exe` выходит с самим кодом ошибки Win32, и это единственный надёжный способ их
 * различать: текст сообщения локализован, на русской Windows никакой `/not started/`
 * не сматчится.
 */
const ERROR_SERVICE_ALREADY_RUNNING = 1056
const ERROR_SERVICE_NOT_ACTIVE = 1062

export type ServiceState = 'Running' | 'Stopped' | 'StartPending' | 'StopPending' | 'Other'
export type ServiceStartMode = 'Auto' | 'Manual' | 'Disabled' | 'Other'

export interface ServiceInfo {
  state: ServiceState
  startMode: ServiceStartMode
  /** Значение `PathName` из CIM — то, что реально прописано в `binPath` службы. */
  binPath: string
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function exitCodeOf(error: unknown): number {
  const code = (error as { code?: number | string } | undefined)?.code
  return typeof code === 'number' ? code : 1
}

function normalizeState(raw: string | undefined): ServiceState {
  switch (raw) {
    case 'Running':
      return 'Running'
    case 'Stopped':
      return 'Stopped'
    case 'Start Pending':
      return 'StartPending'
    case 'Stop Pending':
      return 'StopPending'
    default:
      return 'Other'
  }
}

function normalizeStartMode(raw: string | undefined): ServiceStartMode {
  switch (raw) {
    case 'Auto':
      return 'Auto'
    case 'Manual':
      return 'Manual'
    case 'Disabled':
      return 'Disabled'
    default:
      return 'Other'
  }
}

/**
 * Опрос через `Get-CimInstance Win32_Service`, а не парсинг вывода `sc query` — у CIM
 * `State`/`StartMode` это английские константы независимо от языка Windows, а `sc` печатает
 * локализованный текст, который парсить надёжно нельзя.
 */
export async function queryService(): Promise<ServiceInfo | null> {
  const script =
    `Get-CimInstance Win32_Service -Filter "Name='${SERVICE_NAME}'" | ` +
    'Select-Object State,StartMode,PathName | ConvertTo-Json -Compress'

  let stdout: string
  try {
    ;({ stdout } = await run('powershell.exe', ['-NoProfile', '-Command', script]))
  } catch (error) {
    throw new Error(
      `Не удалось опросить службу: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    )
  }

  const trimmed = stdout.trim()
  if (!trimmed || trimmed === 'null') return null

  const raw = JSON.parse(trimmed) as { State?: string; StartMode?: string; PathName?: string }
  return {
    state: normalizeState(raw.State),
    startMode: normalizeStartMode(raw.StartMode),
    binPath: raw.PathName ?? ''
  }
}

function explainScError(error: unknown, verb: string): string {
  const message = error instanceof Error ? error.message : String(error)
  if (/access is denied/i.test(message)) {
    return (
      `Не удалось ${verb} службу: отказано в доступе. Похоже, права для обычных пользователей ` +
      'не выданы — переустановите приложение.'
    )
  }
  return `Не удалось ${verb} службу: ${message}`
}

async function pollUntil(
  predicate: (info: ServiceInfo | null) => boolean
): Promise<ServiceInfo | null> {
  const deadline = Date.now() + POLL_TIMEOUT_MS
  for (;;) {
    const info = await queryService()
    if (predicate(info)) return info
    if (Date.now() >= deadline) return info
    await sleep(POLL_INTERVAL_MS)
  }
}

/**
 * `sc start` только просит SCM перевести службу в running и возвращается сразу — если не
 * дождаться реального состояния, свежепадающая служба (например, WinDivert не загрузился)
 * выглядела бы как успех.
 */
export async function startService(): Promise<ServiceInfo | null> {
  try {
    await run('sc.exe', ['start', SERVICE_NAME])
  } catch (error) {
    // «Служба уже запущена» — цель достигнута, не ошибка: так бывает, когда пользователь
    // выбрал в списке ту же стратегию, что уже работает, и перенастройка не понадобилась.
    if (exitCodeOf(error) !== ERROR_SERVICE_ALREADY_RUNNING) {
      throw new Error(explainScError(error, 'запустить'), { cause: error })
    }
  }

  const info = await pollUntil((i) => i?.state === 'Running' || i?.state === 'Stopped')
  if (info?.state !== 'Running') {
    throw new Error(
      `Служба запущена системой, но не перешла в рабочее состояние (текущее: ` +
        `${info?.state ?? 'неизвестно'}). Возможная причина — не загрузился драйвер WinDivert ` +
        '(включён Secure Boot, драйвер без действующей подписи, или Windows 7 без нужного обновления).'
    )
  }
  return info
}

export async function stopService(): Promise<ServiceInfo | null> {
  try {
    await run('sc.exe', ['stop', SERVICE_NAME])
  } catch (error) {
    // «Служба не запущена» — не ошибка с точки зрения пользователя, тот же паттерн, что в
    // engine.darwin.ts. Раньше это ловилось регуляркой по тексту `/not.*started/` — на русской
    // Windows она не срабатывала никогда, и остановка уже остановленной службы падала ошибкой.
    if (exitCodeOf(error) !== ERROR_SERVICE_NOT_ACTIVE) {
      throw new Error(explainScError(error, 'остановить'), { cause: error })
    }
  }
  // `pollUntil` возвращает последнее состояние и по истечении таймаута, независимо от предиката,
  // поэтому результат обязательно проверяем. Иначе «остановка», не уложившаяся в POLL_TIMEOUT_MS,
  // молча сходила бы за успешную — и вызывающий код (перенастройка стратегии в engine.win32.ts)
  // пошёл бы копировать winws.exe поверх ещё работающего, ровно в ту ошибку, от которой
  // остановка и защищает.
  const info = await pollUntil((i) => i === null || i.state === 'Stopped')
  if (info && info.state !== 'Stopped') {
    throw new Error(
      `Служба не остановилась за ${POLL_TIMEOUT_MS / 1000} с (состояние: ${info.state}).`
    )
  }
  return info
}

/**
 * PowerShell 5.1 (то, что стоит на Windows по умолчанию) требует BOM, чтобы правильно
 * прочитать кириллицу в UTF-8 файле скрипта — без BOM она превращается в кракозябры.
 */
const UTF8_BOM = '\uFEFF'

function withBom(script: string): string {
  return UTF8_BOM + script
}

/**
 * Выполняется без прав администратора: запрашивает повышение через `Start-Process -Verb RunAs`
 * и ждёт завершения. Если пользователь отклонил UAC, `Start-Process` бросает исключение —
 * ловим его и выходим с ERROR_CANCELLED, чтобы вызывающий код отличил отказ от реальной ошибки.
 *
 * Повышаем САМО приложение (`$AppPath` с флагом `--elevated-service-task`), а не powershell.exe:
 * Windows пишет в окне UAC имя того файла, который повышают, и запрос от «Windows PowerShell»
 * с подписью Microsoft выглядит так, будто права просит что-то постороннее. Повышенный
 * экземпляр приложения уже сам, без второго UAC, запускает worker.ps1 из того же каталога
 * (см. runElevatedServiceTask в elevated-task.win32.ts).
 *
 * `$AppDir` нужен только в dev-режиме: там `$AppPath` — это electron.exe, которому каталог
 * приложения передаётся первым аргументом. В собранном приложении он пустой.
 */
const OUTER_SCRIPT = `
param(
  [Parameter(Mandatory=$true)][string]$AppPath,
  [Parameter(Mandatory=$true)][string]$TaskDir,
  [string]$AppDir = ''
)

try {
  $argList = @()
  if ($AppDir) { $argList += $AppDir }
  $argList += @('${ELEVATED_TASK_FLAG}', $TaskDir)

  $p = Start-Process -FilePath $AppPath -Verb RunAs -Wait -PassThru -ArgumentList $argList
  exit $p.ExitCode
}
catch {
  exit ${UAC_CANCELLED_CODE}
}
`

/**
 * Работает от администратора. Три действия: установить/перенастроить службу (`install`),
 * поменять только тип автозапуска (`setAutoStart`), снять службу целиком (`remove`).
 * Результат пишет в `$ResultPath` — код возврата процесса тут ненадёжен (PowerShell не всегда
 * пробрасывает его наружу через несколько уровней Start-Process), а JSON-файл однозначен.
 */
const WORKER_SCRIPT = `
param(
  [Parameter(Mandatory=$true)][string]$PayloadPath,
  [Parameter(Mandatory=$true)][string]$ResultPath
)

$ErrorActionPreference = 'Stop'
$ServiceName = '${SERVICE_NAME}'

function Write-Result($ok, $errorMessage) {
  $obj = @{ ok = $ok; error = $errorMessage }
  $json = $obj | ConvertTo-Json -Compress
  [System.IO.File]::WriteAllText($ResultPath, $json, (New-Object System.Text.UTF8Encoding($false)))
}

# Прямой вызов "& sc.exe create ... binPath= $binPath" ломает значения с embedded-кавычками:
# PowerShell (& / call operator, и точно так же Start-Process -ArgumentList) перепаковывает
# аргументы по-своему и режет уже готовую строку binPath на два токена по пробелу перед "@" —
# sc.exe получает лишний позиционный аргумент и падает с кодом 1639 (Invalid command line),
# хотя та же строка, набранная руками в cmd.exe, разбирается верно. ProcessStartInfo.Arguments —
# нижний уровень (.NET передаёт эту строку в CreateProcess как есть, без повторной токенизации
# самим PowerShell) — единственный способ гарантированно передать её той же строкой.
function Invoke-ScRaw($rawArgs) {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = 'sc.exe'
  $psi.Arguments = $rawArgs
  $psi.UseShellExecute = $false
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.CreateNoWindow = $true
  $proc = [System.Diagnostics.Process]::Start($psi)
  $stdout = $proc.StandardOutput.ReadToEnd()
  $stderr = $proc.StandardError.ReadToEnd()
  $proc.WaitForExit()
  return [pscustomobject]@{ ExitCode = $proc.ExitCode; Output = ("$stdout $stderr").Trim() }
}

# WinDivert64.sys — файл драйвера, загруженного в ядро: пока драйвер не выгружен, файл занят,
# и Copy-Item поверх него падает с «Процесс не может получить доступ к файлу ... используется
# другим процессом». SCM рапортует службе состояние Stopped, как только winws.exe отдал сигнал
# об остановке, — выгрузка драйвера происходит уже после этого, поэтому при быстром
# переподключении (выключил и сразу включил, сменил стратегию) перенастройка попадала ровно
# в этот зазор.
#
# Отсюда две меры. Первая и главная: не копировать то, что не менялось, — при смене стратегии
# бинарники те же самые, и трогать занятый .sys незачем (Copy-Item сохраняет LastWriteTime
# источника, так что длина + время записи однозначно отличают уже скопированный файл).
# Вторая — на случай, когда копировать действительно надо (обновление приложения принесло
# новый zapret): ждём выгрузки драйвера повторами, а не падаем на первой же попытке.
function Copy-IfChanged($source, $destination) {
  $src = Get-Item -LiteralPath $source
  if (Test-Path -LiteralPath $destination) {
    $dst = Get-Item -LiteralPath $destination
    if ($dst.Length -eq $src.Length -and $dst.LastWriteTimeUtc -eq $src.LastWriteTimeUtc) { return }
  }

  $attempts = 20
  for ($attempt = 1; $attempt -le $attempts; $attempt++) {
    try {
      Copy-Item -LiteralPath $source -Destination $destination -Force
      return
    }
    catch {
      if ($attempt -eq $attempts) {
        throw "Не удалось обновить $destination за 10 с: $($_.Exception.Message) Если обход только что был выключен, драйвер WinDivert ещё выгружается — повторите через несколько секунд."
      }
      Start-Sleep -Milliseconds 500
    }
  }
}

try {
  $payload = Get-Content -Raw -Path $PayloadPath | ConvertFrom-Json

  switch ($payload.action) {
    'install' {
      $dir = $payload.serviceDataDir
      New-Item -ItemType Directory -Path $dir -Force | Out-Null

      # Снимаем наследование прав каталога: конфиг читает служба от SYSTEM, писать в него
      # должны только SYSTEM и администраторы — иначе обычный пользователь мог бы подменить
      # аргументы winws, которые выполняются с правами SYSTEM.
      & icacls $dir /inheritance:r | Out-Null
      & icacls $dir /grant '*S-1-5-18:(OI)(CI)F' | Out-Null
      & icacls $dir /grant '*S-1-5-32-544:(OI)(CI)F' | Out-Null
      & icacls $dir /grant '*S-1-5-32-545:(OI)(CI)RX' | Out-Null

      $configPath = $payload.configPath
      # UTF-8 без BOM — этого требует сам winws при чтении @<config_file> (docs/windows.md zapret).
      $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
      [System.IO.File]::WriteAllText($configPath, $payload.configBody, $utf8NoBom)

      # Служба должна ссылаться на копию winws.exe в этом же защищённом каталоге, а не на
      # оригинал в папке установки приложения: установка теперь per-user (%LocalAppData%),
      # эта папка доступна на запись обычному пользователю — SYSTEM-служба, ссылающаяся туда,
      # была бы локальным повышением привилегий. Копируем winws.exe и рядом лежащие
      # cygwin1.dll/WinDivert.dll/WinDivert64.sys, от них он зависит при запуске.
      $sourceDir = Split-Path -Parent $payload.winwsPath
      $protectedWinws = Join-Path $dir 'winws.exe'
      foreach ($name in @('winws.exe', 'cygwin1.dll', 'WinDivert.dll', 'WinDivert64.sys')) {
        Copy-IfChanged (Join-Path $sourceDir $name) (Join-Path $dir $name)
      }

      # sc.exe читает binPath как ОДИН аргумент — значит всю строку нужно взять в одну пару
      # кавычек, а внутренние кавычки экранировать как \\" (без этого CommandLineToArgvW режет
      # значение на два токена по пробелу перед "@", и sc create падает с кодом 1639).
      # Тот же приём — в service_create.cmd из zapret-win-bundle.
      $binPath = '"\\"' + $protectedWinws + '\\" @\\"' + $configPath + '\\""'
      $startType = if ($payload.autoStart) { 'auto' } else { 'demand' }

      & sc.exe query $ServiceName | Out-Null
      $serviceExists = ($LASTEXITCODE -eq 0)

      if ($serviceExists) {
        $scArgs = 'config ' + $ServiceName + ' binPath= ' + $binPath + ' start= ' + $startType
        $result = Invoke-ScRaw $scArgs
        if ($result.ExitCode -ne 0) { throw "sc config завершился с кодом $($result.ExitCode) : $($result.Output)" }
      } else {
        $scArgs = 'create ' + $ServiceName + ' binPath= ' + $binPath + ' start= ' + $startType + ' DisplayName= "RKNboost: обход блокировок"'
        $result = Invoke-ScRaw $scArgs
        if ($result.ExitCode -ne 0) { throw "sc create завершился с кодом $($result.ExitCode) : $($result.Output)" }
      }
      & sc.exe description $ServiceName 'Служба RKNboost: обходит блокировки через winws/WinDivert.' | Out-Null

      # Разрешаем интерактивным пользователям запуск/остановку/чтение статуса службы, но не
      # смену конфигурации и не смену прав — иначе любой пользователь на машине мог бы подменить
      # аргументы, с которыми служба запускает winws от имени SYSTEM.
      $sddlLines = & sc.exe sdshow $ServiceName
      $sddl = ($sddlLines | Where-Object { $_ -match '^D:' } | Select-Object -First 1)
      if (-not $sddl) { throw 'sc sdshow не вернул дескриптор безопасности' }
      $sddl = $sddl -replace '\\(A;;[^;]*;;;IU\\)', ''
      $sddl = $sddl -replace '^D:', 'D:(A;;CCLCSWRPWPLORC;;;IU)'
      $sdsetOut = & sc.exe sdset $ServiceName $sddl 2>&1 | Out-String
      if ($LASTEXITCODE -ne 0) { throw "sc sdset завершился с кодом $LASTEXITCODE : $($sdsetOut.Trim())" }

      Write-Result $true $null
    }
    'setAutoStart' {
      $startType = if ($payload.autoStart) { 'auto' } else { 'demand' }
      $out = & sc.exe config $ServiceName start= $startType 2>&1 | Out-String
      if ($LASTEXITCODE -ne 0) { throw "sc config завершился с кодом $LASTEXITCODE : $($out.Trim())" }
      Write-Result $true $null
    }
    'remove' {
      & sc.exe stop $ServiceName 2>$null | Out-Null
      Start-Sleep -Milliseconds 500
      & sc.exe delete $ServiceName | Out-Null
      # Тот же занятый WinDivert64.sys, что и при install: сразу после остановки драйвер ещё
      # загружен, и Remove-Item падает. Повторяем, а если так и не вышло — не проваливаем
      # удаление: служба уже снята, а оставшиеся файлы система освободит и без нас.
      for ($attempt = 1; $attempt -le 10; $attempt++) {
        if (-not (Test-Path $payload.serviceDataDir)) { break }
        try {
          Remove-Item -Path $payload.serviceDataDir -Recurse -Force
          break
        }
        catch {
          Start-Sleep -Milliseconds 500
        }
      }
      Write-Result $true $null
    }
    default {
      throw "Неизвестное действие: $($payload.action)"
    }
  }
}
catch {
  Write-Result $false $_.Exception.Message
  exit 1
}
`

async function readResult(path: string): Promise<{ ok: boolean; error: string | null } | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as { ok: boolean; error: string | null }
  } catch {
    return null
  }
}

/**
 * Пишет payload во временный каталог и выполняет `worker.ps1`.
 *
 * Если приложение уже запущено от администратора (в собранном виде — всегда), worker
 * запускается напрямую: ни UAC, ни лишних процессов. Иначе — не более одного запроса UAC
 * на всё действие: `outer.ps1` (без прав) через `Start-Process -Verb RunAs` поднимает
 * приложение с флагом задачи, а уже оно запускает worker.
 *
 * Результат в обоих случаях читаем из `result.json`, а не из кода возврата процесса.
 */
async function runElevated(payload: Record<string, unknown>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'rknboost-svc-'))
  const workerPath = join(dir, TASK_FILES.worker)
  const outerPath = join(dir, 'outer.ps1')
  const payloadPath = join(dir, TASK_FILES.payload)
  const resultPath = join(dir, TASK_FILES.result)

  try {
    await writeFile(workerPath, withBom(WORKER_SCRIPT), 'utf8')
    await writeFile(payloadPath, JSON.stringify(payload), 'utf8')

    let exitCode = 0
    if (await isElevated()) {
      // Приложение и так запущено от администратора (в собранном виде — всегда, см.
      // requestedExecutionLevel в electron-builder.yml). Повышать нечего: запускаем worker
      // напрямую, без outer.ps1 и без второго экземпляра приложения на каждое действие.
      exitCode = await runElevatedServiceTask(dir)
    } else {
      await writeFile(outerPath, withBom(OUTER_SCRIPT), 'utf8')
      try {
        await run('powershell.exe', [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          outerPath,
          '-AppPath',
          process.execPath,
          '-TaskDir',
          dir,
          // В dev electron.exe нужен каталог приложения первым аргументом; в сборке — нет.
          ...(app.isPackaged ? [] : ['-AppDir', app.getAppPath()])
        ])
      } catch (error) {
        exitCode = exitCodeOf(error)
      }
    }

    if (exitCode === UAC_CANCELLED_CODE) {
      throw new Error('Установка отменена — запрос на права администратора был отклонён.')
    }

    const result = await readResult(resultPath)
    if (!result?.ok) {
      throw new Error(
        result?.error
          ? `Не удалось настроить службу: ${result.error}`
          : `Настройка службы завершилась с ошибкой (код ${exitCode}).`
      )
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

export interface ApplyServiceConfigOptions {
  /** Тело `strategy.cfg` — из `winwsConfigFile()` в `strategies.ts`. */
  configBody: string
  autoStart: boolean
}

/**
 * Установить службу (если её ещё нет) или перенастроить существующую — один запрос UAC.
 * Заодно копирует `winws.exe` + WinDivert из папки установки приложения (per-user,
 * доступна на запись обычному пользователю) в защищённый каталог службы — см.
 * `protectedWinwsPath()` в `paths.ts` — и указывает binPath именно туда.
 * Саму службу не запускает — вызывающий код (`Win32Engine.start()`) делает это отдельным
 * вызовом `startService()`, который уже не требует прав благодаря ACL, выставленному здесь.
 */
export async function applyServiceConfig(options: ApplyServiceConfigOptions): Promise<void> {
  await runElevated({
    action: 'install',
    serviceDataDir: serviceDataDir(),
    configPath: serviceConfigPath(),
    configBody: options.configBody,
    winwsPath: winwsPath(),
    autoStart: options.autoStart
  })
}

/** Только тип автозапуска — не трогает аргументы winws, отдельный (более лёгкий) UAC-запрос. */
export async function setServiceAutoStart(autoStart: boolean): Promise<void> {
  await runElevated({ action: 'setAutoStart', autoStart })
}

/** Используется деинсталлятором (`build/installer.nsh`) и на случай ручной переустановки. */
export async function removeService(): Promise<void> {
  await runElevated({ action: 'remove', serviceDataDir: serviceDataDir() })
}
