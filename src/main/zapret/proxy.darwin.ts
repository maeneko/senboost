import { app } from 'electron'
import { execFile } from 'node:child_process'
import { readFile, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

/**
 * Домены и адреса, которые не должны идти через прокси. Без этого списка отвалится
 * всё локальное: tpws по документации запрещает подключения к тому же хосту,
 * на котором работает сам, включая localhost.
 */
const BYPASS = ['*.local', '169.254/16', 'localhost', '127.0.0.1', '::1']

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
 * системный диалог авторизации.
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
        throw new Error('Изменение системного прокси отменено.', { cause: elevationError })
      throw new Error(`Не удалось изменить настройки прокси: ${text}`, { cause: elevationError })
    }
  }
}

/** Сетевые сервисы, кроме выключенных: у тех `networksetup` ставит «*» перед именем. */
async function activeServices(): Promise<string[]> {
  const stdout = await networksetup(['-listallnetworkservices'])
  return stdout
    .split('\n')
    .slice(1) // первая строка — пояснение про звёздочку
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('*'))
}

async function readServiceState(service: string): Promise<ServiceProxyState> {
  const stdout = await networksetup(['-getsocksfirewallproxy', service])
  const value = (key: string): string =>
    new RegExp(`^${key}:\\s*(.*)$`, 'm').exec(stdout)?.[1]?.trim() ?? ''

  const bypassOutput = await networksetup(['-getproxybypassdomains', service])
  // Пустой список macOS печатает фразой «There aren't any bypass domains…»,
  // а в доменах пробелов не бывает — по этому и отличаем.
  const bypass = bypassOutput
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.includes(' '))

  return {
    service,
    enabled: value('Enabled').toLowerCase() === 'yes',
    server: value('Server'),
    port: value('Port'),
    bypass
  }
}

async function saveSnapshot(snapshot: ProxySnapshot): Promise<void> {
  await writeFile(snapshotPath(), JSON.stringify(snapshot, null, 2), 'utf8')
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

/** Прописать socks-прокси во все активные сетевые сервисы, запомнив прежнее состояние. */
export async function applySystemProxy(host: string, port: number): Promise<void> {
  const services = await activeServices()
  if (services.length === 0) throw new Error('Не найдено ни одного активного сетевого сервиса.')

  // Снимок делаем до первой правки и сразу пишем на диск: если приложение
  // упадёт посреди применения, следующий запуск сможет всё вернуть.
  const snapshot: ProxySnapshot = {
    takenAt: new Date().toISOString(),
    services: await Promise.all(services.map(readServiceState))
  }
  await saveSnapshot(snapshot)

  for (const service of services) {
    await networksetup(['-setsocksfirewallproxy', service, host, String(port)])
    await networksetup(['-setproxybypassdomains', service, ...BYPASS])
    await networksetup(['-setsocksfirewallproxystate', service, 'on'])
  }
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
 * Снимок остался с прошлого запуска — значит приложение завершилось аварийно,
 * не сняв прокси, и система сейчас смотрит в несуществующий socks. Чиним на старте.
 */
export async function hasStaleSnapshot(): Promise<boolean> {
  return (await loadSnapshot()) !== null
}
