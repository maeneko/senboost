import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  access,
  chmod,
  constants,
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import {
  bundledFakesDir,
  bundledHelperPath,
  linuxInstalledConfigPath,
  linuxPidfilePath,
  linuxStagingDir,
  nfqwsPath,
  stagedFakesDir,
  stagedHelperPath,
  stagedNfqwsPath
} from './paths'
import { parseStrategyMarker } from './strategies'

const run = promisify(execFile)

async function sha256(path: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex')
}

async function filesIdentical(a: string, b: string): Promise<boolean> {
  try {
    const [hashA, hashB] = await Promise.all([sha256(a), sha256(b)])
    return hashA === hashB
  } catch {
    // Копии ещё нет (первый запуск) или она нечитаема — надёжнее перекопировать.
    return false
  }
}

/**
 * Копирует nfqws, помощника и fake-пакеты из `resources/zapret`/`resources/linux-helper`
 * в `linuxStagingDir()` — см. её комментарий в paths.ts про то, почему это не оптимизация,
 * а необходимость под AppImage. Сравниваем содержимое, а не mtime — тот же мотив, что у
 * `binariesNeedCopy()` в engine.win32.ts: `copyFile` всегда ставит текущее время, хотя
 * зафиксированная версия zapret даёт одни и те же байты между сборками.
 */
export async function stageRuntime(): Promise<void> {
  await mkdir(linuxStagingDir(), { recursive: true })
  await mkdir(stagedFakesDir(), { recursive: true })

  if (!(await filesIdentical(nfqwsPath(), stagedNfqwsPath()))) {
    await copyFile(nfqwsPath(), stagedNfqwsPath())
  }
  await chmod(stagedNfqwsPath(), 0o755)

  if (!(await filesIdentical(bundledHelperPath(), stagedHelperPath()))) {
    await copyFile(bundledHelperPath(), stagedHelperPath())
  }
  await chmod(stagedHelperPath(), 0o755)

  const fakesSrcDir = bundledFakesDir()
  for (const name of await readdir(fakesSrcDir)) {
    const src = join(fakesSrcDir, name)
    const dst = join(stagedFakesDir(), name)
    if (!(await filesIdentical(src, dst))) {
      await copyFile(src, dst)
    }
  }
}

/**
 * `nfqws --dry-run @<файл>` — проверяет только аргументы фильтра, root не нужен (в отличие
 * от рабочего запуска демона). Запускаем бинарник из сборки напрямую: dry-run идёт от uid
 * самого приложения, а не root, так что FUSE-примонтированный AppImage тут не помеха —
 * ограничение касается только `pkexec` (см. linuxStagingDir()). Дословный аналог
 * `Win32Engine['dryRun']`.
 */
export async function dryRun(configBody: string): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'rknboost-dryrun-'))
  const configPath = join(dir, 'dry-run.cfg')
  try {
    await writeFile(configPath, configBody, 'utf8')
    await run(nfqwsPath(), ['--dry-run', `@${configPath}`])
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Стратегия содержит недопустимые параметры nfqws: ${message}`, {
      cause: error
    })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** Отрендеренный конфиг лежит здесь до pkexec — сам помощник, уже под root, копирует его в /run. */
async function writeStagedConfig(body: string): Promise<string> {
  const path = join(linuxStagingDir(), 'pending-strategy.cfg')
  await writeFile(path, body, 'utf8')
  return path
}

/** Хвост stderr помощника — тот же лимит и мотив, что у `stderrTail` в engine.darwin.ts. */
const STDERR_TAIL_LIMIT = 4000

function runHelper(args: string[]): Promise<{ code: number; stderr: string }> {
  return new Promise((resolveHelper) => {
    const child = spawn('pkexec', [stagedHelperPath(), ...args], {
      stdio: ['ignore', 'ignore', 'pipe']
    })

    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-STDERR_TAIL_LIMIT)
    })

    // pkexec не найден — spawn сообщает об этом событием 'error', а не кодом выхода
    // (см. launchUninstaller() в uninstall.win32.ts, та же причина).
    child.on('error', (error) => resolveHelper({ code: 127, stderr: error.message }))
    child.on('close', (code) => resolveHelper({ code: code ?? 1, stderr }))
  })
}

export interface StartNfqwsOptions {
  configBody: string
  tcpPorts: string
  udpPorts: string
}

/** Единственные два места, где приложение просит root — включение и выключение обхода. */
export async function startNfqws(options: StartNfqwsOptions): Promise<void> {
  await stageRuntime()
  const configPath = await writeStagedConfig(options.configBody)

  const { code, stderr } = await runHelper([
    'start',
    stagedNfqwsPath(),
    configPath,
    options.tcpPorts,
    options.udpPorts
  ])

  if (code !== 0) {
    throw new Error(
      `Не удалось запустить обход (pkexec, код ${code})` +
        (stderr ? `: ${stderr}` : ' — запрос прав администратора отклонён или прерван.')
    )
  }
}

export async function stopNfqws(): Promise<void> {
  // Помощник может понадобиться, даже если start() в эту сессию ещё не звали — например,
  // sync() увидел уже работающий с прошлого сеанса демон, и первое действие пользователя
  // в новом запуске приложения — «Выключить».
  await stageRuntime()

  const { code, stderr } = await runHelper(['stop'])
  if (code !== 0) {
    throw new Error(
      `Не удалось остановить обход (pkexec, код ${code})` +
        (stderr ? `: ${stderr}` : ' — запрос прав администратора отклонён или прерван.')
    )
  }
}

export interface NfqwsState {
  pid: number | null
  strategyId: string | null
}

/** `/proc/<pid>` — существование каталога о процессе видно без прав, сигнал слать не нужно. */
export async function isProcessAlive(pid: number): Promise<boolean> {
  try {
    await access(`/proc/${pid}`, constants.F_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Не требует root: `nfqws.pid` и `strategy.cfg` в `/run/rknboost` помощник кладёт с правами
 * 0644 (см. rknboost-helper.sh) именно затем, чтобы это чтение — и восстановление состояния
 * в `LinuxEngine.sync()` — обходилось без пароля.
 */
export async function readNfqwsState(): Promise<NfqwsState> {
  let pid: number | null = null
  try {
    const raw = (await readFile(linuxPidfilePath(), 'utf8')).trim()
    const parsed = Number.parseInt(raw, 10)
    if (Number.isInteger(parsed) && parsed > 0 && (await isProcessAlive(parsed))) {
      pid = parsed
    }
  } catch {
    // pidfile нет или процесс из него уже не живёт — считаем демон не запущенным.
  }

  let strategyId: string | null = null
  try {
    const content = await readFile(linuxInstalledConfigPath(), 'utf8')
    strategyId = parseStrategyMarker(content.split('\n')[0]?.trim() ?? null)
  } catch {
    // strategy.cfg нет — не страшно, id останется null.
  }

  return { pid, strategyId }
}
