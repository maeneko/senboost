import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ZapretList, ZapretListId } from '../../shared/ipc-contract'
import { bundledListsDir, userListsDir } from './paths'

/**
 * Списки сайтов — данные, а не аргументы запуска. Пользователь правит их
 * полностью свободно (это его решение), включая встроенные из Flowseal.
 * Рабочая копия лежит в userData и переживает обновление приложения; встроенная
 * версия в `resources/zapret/lists` только читается — от неё берём исходное
 * содержимое при первом запуске и при «Сбросить к встроенному».
 *
 * Важно: и tpws, и winws сами перечитывают список, если у файла изменились
 * mtime или размер («automatically reload lists if their modification time or
 * file size is changed», docs/readme zapret) — перезапускать обход после правки
 * списка не нужно. Чтобы это гарантированно сработало (а не поймать читателя
 * на файле, который ещё не дописан), пишем во временный файл и делаем `rename` —
 * это меняет mtime одним атомарным шагом.
 */

const FILE_NAMES: Record<ZapretListId, string> = {
  general: 'general.txt',
  google: 'google.txt',
  exclude: 'exclude.txt',
  'ipset-exclude': 'ipset-exclude.txt',
  'ipset-all': 'ipset-all.txt'
}

export const LIST_IDS = Object.keys(FILE_NAMES) as ZapretListId[]

/** Списки доменов (--hostlist=...) — в отличие от ipset-exclude/ipset-all, где строки это IP/CIDR. */
const HOSTLIST_IDS: ZapretListId[] = ['general', 'google', 'exclude']

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function parseEntries(content: string): string[] {
  return content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
}

function serializeEntries(entries: string[]): string {
  return entries.join('\n') + (entries.length > 0 ? '\n' : '')
}

const DOMAIN_RE = /^\^?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/
const IP_CIDR_RE = /^([0-9a-f:]+|\d{1,3}(\.\d{1,3}){3})(\/\d{1,3})?$/i

/** Понятная ошибка вместо того, чтобы молча положить в список мусор, который tpws пропустит мимо ушей. */
function validateEntry(id: ZapretListId, raw: string): string {
  const entry = raw.trim().toLowerCase()
  if (!entry) throw new Error('Пустая строка в списке.')

  const isHostlist = HOSTLIST_IDS.includes(id)
  const pattern = isHostlist ? DOMAIN_RE : IP_CIDR_RE
  if (!pattern.test(entry)) {
    throw new Error(
      isHostlist
        ? `«${raw}» не похоже на домен (пример: example.com или ^example.com для точного совпадения).`
        : `«${raw}» не похоже на IP-адрес или подсеть (пример: 192.168.0.0/16).`
    )
  }
  return entry
}

function bundledPath(id: ZapretListId): string {
  return join(bundledListsDir(), FILE_NAMES[id])
}

function userPath(id: ZapretListId): string {
  return join(userListsDir(), FILE_NAMES[id])
}

/** Атомарная запись: временный файл в том же каталоге (для atomic rename на одной ФС) + rename. */
async function writeAtomic(path: string, content: string): Promise<void> {
  const tmp = `${path}.${randomUUID()}.tmp`
  await writeFile(tmp, content, 'utf8')
  await rename(tmp, path)
}

async function readBundled(id: ZapretListId): Promise<string> {
  return readFile(bundledPath(id), 'utf8')
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path)
    return true
  } catch {
    return false
  }
}

/** Копирует встроенные списки в userData при первом запуске. Идемпотентно — уже существующие не трогает. */
export async function seedLists(): Promise<void> {
  await mkdir(userListsDir(), { recursive: true })
  for (const id of LIST_IDS) {
    if (await fileExists(userPath(id))) continue
    await writeAtomic(userPath(id), await readBundled(id))
  }
}

async function toZapretList(id: ZapretListId): Promise<ZapretList> {
  const [userContent, bundledContent] = await Promise.all([
    readFile(userPath(id), 'utf8').catch(() => readBundled(id)),
    readBundled(id)
  ])

  return {
    id,
    entries: parseEntries(userContent),
    // Список не тронут пользователем относительно текущей встроенной версии.
    isDefault: sha256(userContent) === sha256(bundledContent)
  }
}

export async function readList(id: ZapretListId): Promise<ZapretList> {
  return toZapretList(id)
}

export async function readAllLists(): Promise<ZapretList[]> {
  return Promise.all(LIST_IDS.map(readList))
}

export async function writeList(id: ZapretListId, rawEntries: string[]): Promise<ZapretList> {
  const seen = new Set<string>()
  const entries: string[] = []
  for (const raw of rawEntries) {
    const entry = validateEntry(id, raw)
    if (seen.has(entry)) continue
    seen.add(entry)
    entries.push(entry)
  }

  await writeAtomic(userPath(id), serializeEntries(entries))
  return toZapretList(id)
}

export async function resetList(id: ZapretListId): Promise<ZapretList> {
  await writeAtomic(userPath(id), await readBundled(id))
  return toZapretList(id)
}

/** Путь к рабочему списку — нужен `strategies.ts`, чтобы подставить его в аргументы движка. */
export function listFilePath(id: ZapretListId): string {
  return userPath(id)
}
