import { app } from 'electron'
import { execFile } from 'node:child_process'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

/**
 * Разовая миграция с версий на `tpws` (≤0.5.4, socks5-прокси уровня TCP-соединений).
 * Новый движок (`utunws`, см. `engine.darwin.ts`) обходит блокировки на уровне пакетов
 * через pf/utun и системный прокси не использует вовсе — `applySystemProxy()` (когда-то
 * прописывала socks в сетевые настройки) больше не нужна и удалена.
 *
 * Но у пользователей, обновляющихся со старой версии, снимок настроек мог остаться на
 * диске: если tpws-приложение завершилось аварийно (`kill -9`, крах системы), оно не
 * успевало снять socks-прокси из системных настроек сети — тогда система тычется в
 * несуществующий сервер, и после обновления просто нет интернета, пока кто-то не откатит
 * прокси руками. `restoreSystemProxy()`/`hasStaleSnapshot()` остаются ровно ради этого
 * разового отката в `recoverZapret()` (`zapret/index.ts`), до открытия окна.
 */

interface ServiceProxyState {
  service: string
  enabled: boolean
  server: string
  port: string
  bypass: string[]
}

/** Что было до нас — чтобы вернуть настройки ровно в исходное состояние. */
interface ProxySnapshot {
  takenAt: string
  services: ServiceProxyState[]
}

function snapshotPath(): string {
  return join(app.getPath('userData'), 'proxy-snapshot.json')
}

/**
 * `networksetup` требует членства в группе admin. На обычном Mac пользователь в ней
 * состоит и пароль не спрашивается. Если же включена политика «требовать пароль
 * администратора для системных настроек», команда падает — тогда повторяем её через
 * системный диалог авторизации (та же логика, что и `runPrivileged()` в `elevate.darwin.ts`,
 * этот файл написан раньше и его исторически не трогаем — обе копии удаляются вместе с
 * этой миграцией, когда версии ≤0.5.4 отойдут в прошлое).
 */
async function networksetup(args: string[]): Promise<string> {
  try {
    const { stdout } = await run('/usr/sbin/networksetup', args)
    return stdout
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (!/root|denied|permission/i.test(message)) throw error

    const command = ['/usr/sbin/networksetup', ...args]
      .map((part) => `'${part.replaceAll("'", `'\\''`)}'`)
      .join(' ')

    try {
      const { stdout } = await run('/usr/bin/osascript', [
        '-e',
        `do shell script "${command.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}" with administrator privileges`
      ])
      return stdout
    } catch (elevationError) {
      const text = elevationError instanceof Error ? elevationError.message : String(elevationError)
      if (text.includes('-128'))
        throw new Error('Восстановление системного прокси отменено.', { cause: elevationError })
      throw new Error(`Не удалось восстановить настройки прокси: ${text}`, {
        cause: elevationError
      })
    }
  }
}

async function loadSnapshot(): Promise<ProxySnapshot | null> {
  try {
    return JSON.parse(await readFile(snapshotPath(), 'utf8')) as ProxySnapshot
  } catch {
    return null
  }
}

async function restoreService(state: ServiceProxyState): Promise<void> {
  if (state.enabled && state.server) {
    await networksetup([
      '-setsocksfirewallproxy',
      state.service,
      state.server,
      state.port || '1080'
    ])
    await networksetup(['-setsocksfirewallproxystate', state.service, 'on'])
  } else {
    await networksetup(['-setsocksfirewallproxystate', state.service, 'off'])
  }

  // Пустой список сбрасывается специальным словом Empty — иначе останется наш.
  const bypass = state.bypass.length > 0 ? state.bypass : ['Empty']
  await networksetup(['-setproxybypassdomains', state.service, ...bypass])
}

/** Вернуть настройки прокси в состояние из снимка. Без снимка ничего не трогаем. */
export async function restoreSystemProxy(): Promise<boolean> {
  const snapshot = await loadSnapshot()
  if (!snapshot) return false

  for (const state of snapshot.services) {
    await restoreService(state)
  }
  await rm(snapshotPath(), { force: true })
  return true
}

/**
 * Снимок остался с прошлого запуска старой версии — значит tpws завершился аварийно,
 * не сняв прокси, и система сейчас смотрит в несуществующий socks. Чиним на старте.
 */
export async function hasStaleSnapshot(): Promise<boolean> {
  return (await loadSnapshot()) !== null
}
