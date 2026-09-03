#!/usr/bin/env node
/**
 * Разовый (перезапускаемый) генератор: превращает `general*.bat` из
 * Flowseal/zapret-discord-youtube в `src/main/zapret/strategies.win32.generated.ts`.
 *
 * Зачем отдельным скриптом, а не частью `fetch-zapret.mjs`: вывод коммитится в
 * репозиторий — в рантайме и в сборке .bat-файлов быть не должно, только сгенерированный
 * TypeScript. Запускать вручную при обновлении `FLOWSEAL_COMMIT` в `fetch-zapret.mjs`,
 * проверяя результат через `git diff`, а не доверяя вслепую (формат батников может
 * измениться — тогда парсер должен упасть, а не тихо сгенерировать мусор).
 *
 * Формат batch-файлов Flowseal строго регулярный (проверено на всех 22 вариантах):
 *   start "zapret: %~n0" /min "%BIN%winws.exe" --arg1 --arg2 ^
 *   --arg3 ^
 *   ...
 *   --argN
 * Это одна команда, продолжающаяся через `^` в конце строки — не программа, а
 * длинная командная строка winws. Переносим только сами аргументы.
 */

import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Держим в синхроне с `fetch-zapret.mjs` — версия данных должна совпадать.
const FLOWSEAL_COMMIT = 'dfd8e613b099676cf2aa7b474ee5923801514dec'
const FLOWSEAL_VERSION = '1.10.2'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUTPUT = join(ROOT, 'src', 'main', 'zapret', 'strategies.win32.generated.ts')

/** Списки Flowseal → наши короткие имена (совпадает с `FLOWSEAL_LISTS` в fetch-zapret.mjs). */
const LIST_FILES = {
  'list-general.txt': 'general',
  'list-google.txt': 'google',
  'list-exclude.txt': 'exclude',
  'ipset-exclude.txt': 'ipset-exclude',
  'ipset-all.txt': 'ipset-all'
}

/** Пользовательские дубликаты списков — у нас все списки и так редактируемые, лишние. */
const DROP_LIST_SUFFIXES = ['-user.txt']

/** Игровой фильтр Flowseal по умолчанию выключен: `GameFilterTCP=12`, `GameFilterUDP=12`. */
const GAME_FILTER_DISABLED = '12'

function idFromFilename(filename) {
  // "general.bat" → "general" / "Стандартная"; "general (ALT2).bat" → "alt2" / "ALT2"
  const match = /^general(?: \((.+)\))?\.bat$/.exec(filename)
  if (!match) throw new Error(`Неожиданное имя файла стратегии: ${filename}`)
  const variant = match[1]
  if (!variant) return { id: 'general', name: 'Стандартная' }
  const id = variant.toLowerCase().replace(/\s+/g, '-')
  return { id, name: variant }
}

/** Разбивает командную строку на токены, учитывая кавычки, без внешней библиотеки. */
function tokenize(command) {
  const tokens = command.match(/(?:[^\s"]|"[^"]*")+/g) ?? []
  return tokens.map((token) => token.replace(/^"(.*)"$/, '$1'))
}

function resolvePlaceholders(token) {
  for (const [flowsealName, ourName] of Object.entries(LIST_FILES)) {
    if (token.includes(`%LISTS%${flowsealName}`)) {
      return token.replace(`%LISTS%${flowsealName}`, `{LISTS}/${ourName}.txt`)
    }
  }
  const binMatch = /%BIN%([A-Za-z0-9_.]+\.bin)/.exec(token)
  if (binMatch) return token.replace(binMatch[0], `{FAKES}/${binMatch[1]}`)

  return token
    .replaceAll('%GameFilterTCP%', GAME_FILTER_DISABLED)
    .replaceAll('%GameFilterUDP%', GAME_FILTER_DISABLED)
}

function isDroppedUserListArg(token) {
  return DROP_LIST_SUFFIXES.some((suffix) => token.includes(`%LISTS%`) && token.includes(suffix))
}

function parseBatFile(filename, content) {
  const marker = 'winws.exe"'
  const start = content.indexOf(marker)
  if (start === -1) throw new Error(`${filename}: не нашёл запуск winws.exe`)

  // Дальше до конца файла — одна командная строка, продолжающаяся через "^\n".
  const rest = content.slice(start + marker.length)
  const joined = rest.replace(/\^\r?\n/g, ' ')

  const tokens = tokenize(joined)
    .map((t) => t.trim())
    .filter(Boolean)
    .filter((t) => !isDroppedUserListArg(t))
    // Кавычки в .bat защищали путь от разбора cmd.exe при запуске через `start`.
    // Мы передаём argv напрямую в spawn (без шелла) — кавычки внутри значения
    // остались бы буквальными символами в имени файла, поэтому убираем везде.
    .map((t) => t.replaceAll('"', ''))
    .map(resolvePlaceholders)

  if (tokens.length < 5)
    throw new Error(`${filename}: подозрительно мало аргументов (${tokens.length})`)

  const { id, name } = idFromFilename(filename)
  return { id, name, args: tokens }
}

async function main() {
  const work = await mkdtemp(join(tmpdir(), 'flowseal-strategies-'))

  try {
    console.log(
      `Flowseal ${FLOWSEAL_VERSION} (commit ${FLOWSEAL_COMMIT.slice(0, 12)}): скачиваю batch-файлы`
    )
    const archivePath = join(work, 'flowseal.tar.gz')
    const response = await fetch(
      `https://codeload.github.com/Flowseal/zapret-discord-youtube/tar.gz/${FLOWSEAL_COMMIT}`
    )
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
    await writeFile(archivePath, Buffer.from(await response.arrayBuffer()))

    const prefix = execFileSync('tar', ['-tzf', archivePath], { encoding: 'utf8' })
      .split('\n')[0]
      .split('/')[0]
    execFileSync('tar', ['-xzf', archivePath, '-C', work], {
      stdio: ['ignore', 'ignore', 'inherit']
    })

    const srcDir = join(work, prefix)
    const batFiles = (await readdir(srcDir)).filter(
      (name) => name.startsWith('general') && name.endsWith('.bat')
    )
    batFiles.sort()

    if (batFiles.length === 0)
      throw new Error('Не нашлось ни одного general*.bat — формат репозитория изменился')

    const strategies = []
    for (const filename of batFiles) {
      const content = await readFile(join(srcDir, filename), 'utf8')
      strategies.push(parseBatFile(filename, content))
      console.log(
        `  ${filename} → ${strategies.at(-1).id} (${strategies.at(-1).args.length} аргументов)`
      )
    }

    const ids = new Set(strategies.map((s) => s.id))
    if (ids.size !== strategies.length)
      throw new Error('Столкновение id — два файла дали одинаковый идентификатор')

    const body = strategies
      .map(
        (s) =>
          `  {\n    id: ${JSON.stringify(s.id)},\n    name: ${JSON.stringify(s.name)},\n    args: [\n${s.args
            .map((a) => `      ${JSON.stringify(a)}`)
            .join(',\n')}\n    ]\n  }`
      )
      .join(',\n')

    const output = `/**
 * СГЕНЕРИРОВАНО \`scripts/import-flowseal-strategies.mjs\` из
 * Flowseal/zapret-discord-youtube ${FLOWSEAL_VERSION} (commit ${FLOWSEAL_COMMIT}).
 * Не редактировать руками — перезапустить генератор и закоммитить результат.
 *
 * \`{LISTS}\` и \`{FAKES}\` — плейсхолдеры путей, резолвятся в \`strategies.ts\`
 * через \`resolvePlaceholders()\` в фактические пути userData/resources.
 */

export interface GeneratedWin32Strategy {
  id: string
  name: string
  args: string[]
}

export const WIN32_STRATEGIES: readonly GeneratedWin32Strategy[] = [
${body}
]
`

    await writeFile(OUTPUT, output)
    console.log(`Готово: ${OUTPUT} (${strategies.length} стратегий)`)
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}

await main()
