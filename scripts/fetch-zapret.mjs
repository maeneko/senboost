#!/usr/bin/env node
/**
 * Кладёт бинарники и данные zapret в resources/zapret/ — оттуда electron-builder
 * положит их в сборку через extraResources.
 *
 * Три источника:
 *   • bol-van/zapret   — движки (winws.exe + WinDivert, nfqws), версия пинована и
 *     сверяется по sha256sum.txt из релиза;
 *   • Flowseal/zapret-discord-youtube — подобранные сообществом списки доменов и
 *     стратегии winws (переносятся в код генератором `parser-strategies.mjs`,
 *     здесь просто данные: списки + fake-пакеты). У Flowseal нет sha256sum.txt —
 *     версия фиксируется по sha коммита, на который указывает тег.
 *   • Flowseal/zapret-mac-discord-youtube — macOS-порт nfqws (`utunws`, работает через
 *     utun+BPF вместо netfilter/WinDivert). Тоже без sha256sum.txt — сумму архива
 *     релиза фиксируем сами (см. `FLOWSEAL_MAC_ZIP_SHA256`).
 *
 * Каталог resources/zapret в git не хранится: запустите `npm run zapret:fetch`
 * (или просто `npm run build` — он вызывает скрипт сам).
 */

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, copyFile, readFile, writeFile, rm, chmod } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ZAPRET_VERSION = 'v72.13'
const WINDIVERT_VERSION = 'v2.2.2'

/** Тег Flowseal, зафиксированный по sha коммита (проверено: `git/refs/tags/1.10.2`). */
const FLOWSEAL_VERSION = '1.10.2'
const FLOWSEAL_COMMIT = 'dfd8e613b099676cf2aa7b474ee5923801514dec'

/**
 * Релиз Flowseal/zapret-mac-discord-youtube, откуда берём `utunws` — форк nfqws под
 * macOS (utun+BPF вместо netfilter). У репозитория нет sha256sum.txt, поэтому вместо
 * суммы отдельного бинарника фиксируем сумму всего архива релиза — она получена один раз
 * командой `shasum -a 256` по скачанному `ZapretMac-macOS-universal.zip` и проверяется
 * при каждой закачке, чтобы подмена ассета в чужом форке или на CDN не прошла незамеченной.
 */
const FLOWSEAL_MAC_VERSION = '1.1.2'
const FLOWSEAL_MAC_ZIP_SHA256 = '9895b0ec5d13ec05676f755cde71107e72d2661538440c3cc4f06e0e6d47844f'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DEST = join(ROOT, 'resources', 'zapret')

const RELEASE = `https://github.com/bol-van/zapret/releases/download/${ZAPRET_VERSION}`
const ARCHIVE = `zapret-${ZAPRET_VERSION}.tar.gz`
/** Корневой каталог внутри архива — с ним же начинаются пути в sha256sum.txt. */
const PREFIX = `zapret-${ZAPRET_VERSION}`

/** Что забираем из архива bol-van/zapret: путь внутри архива → путь внутри resources/zapret. */
const FILES = {
  'binaries/linux-x86_64/nfqws': 'linux/x64/nfqws',
  'binaries/windows-x86_64/winws.exe': 'win32/x64/winws.exe',
  'binaries/windows-x86_64/cygwin1.dll': 'win32/x64/cygwin1.dll',
  'binaries/windows-x86_64/WinDivert.dll': 'win32/x64/WinDivert.dll',
  'binaries/windows-x86_64/WinDivert64.sys': 'win32/x64/WinDivert64.sys',
  'docs/LICENSE.txt': 'LICENSE.zapret.txt'
}

/** Исполняемый бит нужен только там, где мы сами запускаем бинарник. */
const EXECUTABLE = new Set(['darwin/utunws', 'linux/x64/nfqws'])

/**
 * Списки доменов Flowseal → наши короткие имена (используются и в `lists.ts`, и
 * в сгенерированных стратегиях). `*-user.txt` не берём — у нас все списки и так
 * редактируемые, отдельного пользовательского слоя не нужно.
 */
const FLOWSEAL_LISTS = {
  'lists/list-general.txt': 'lists/general.txt',
  'lists/list-google.txt': 'lists/google.txt',
  'lists/list-exclude.txt': 'lists/exclude.txt',
  'lists/ipset-exclude.txt': 'lists/ipset-exclude.txt',
  'lists/ipset-all.txt': 'lists/ipset-all.txt'
}

/** Fake-пакеты, реально используемые хотя бы одной стратегией general*.bat. */
const FLOWSEAL_FAKES = [
  'ACTIVE_DISCORD_UDP.bin',
  'ACTIVE_GAME_UDP.bin',
  'quic_initial_4pda_to.bin',
  'quic_initial_www_google_com.bin',
  'stun.bin',
  'stun2.bin',
  'tls_clienthello_4pda_to.bin',
  'tls_clienthello_max_ru.bin',
  'tls_clienthello_sochi_park.bin',
  'tls_clienthello_www_google_com.bin'
]

async function download(url) {
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok) throw new Error(`${response.status} ${response.statusText} — ${url}`)
  return Buffer.from(await response.arrayBuffer())
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

/** sha256sum.txt: строки вида "<hex>  zapret-v72.13/binaries/mac64/tpws". */
function parseChecksums(text) {
  const checksums = new Map()
  for (const line of text.split('\n')) {
    const match = /^([0-9a-f]{64})\s+(\S+)$/.exec(line.trim())
    if (match) checksums.set(match[2], match[1])
  }
  return checksums
}

async function fetchZapretEngines(work) {
  console.log(`zapret ${ZAPRET_VERSION}: скачиваю ${ARCHIVE}`)
  const archivePath = join(work, ARCHIVE)
  await writeFile(archivePath, await download(`${RELEASE}/${ARCHIVE}`))

  const checksums = parseChecksums((await download(`${RELEASE}/sha256sum.txt`)).toString('utf8'))

  // tar есть на macOS, Linux и в Windows 10 1803+; распаковываем только нужные пути.
  execFileSync(
    'tar',
    ['-xzf', archivePath, '-C', work, ...Object.keys(FILES).map((p) => `${PREFIX}/${p}`)],
    { stdio: ['ignore', 'ignore', 'inherit'] }
  )

  for (const [source, target] of Object.entries(FILES)) {
    const extracted = join(work, PREFIX, source)
    const content = await readFile(extracted)

    // Лицензии в sha256sum.txt не попадают — там только binaries/**.
    const expected = checksums.get(`${PREFIX}/${source}`)
    if (expected) {
      const actual = sha256(content)
      if (actual !== expected) {
        throw new Error(
          `не совпала контрольная сумма ${source}\n  ожидалось: ${expected}\n  получено:  ${actual}`
        )
      }
    }

    const destination = join(DEST, target)
    await mkdir(dirname(destination), { recursive: true })
    await copyFile(extracted, destination)
    if (EXECUTABLE.has(target)) await chmod(destination, 0o755)

    console.log(`  ${target}${expected ? ' ✓ sha256' : ''}`)
  }

  // Лицензия WinDivert лежит в своём репозитории, в архив zapret не входит.
  const windivertLicense = await download(
    `https://raw.githubusercontent.com/basil00/WinDivert/${WINDIVERT_VERSION}/LICENSE`
  )
  await writeFile(join(DEST, 'LICENSE.WinDivert.txt'), windivertLicense)
  console.log('  LICENSE.WinDivert.txt')
}

async function fetchFlowsealData(work) {
  console.log(
    `Flowseal ${FLOWSEAL_VERSION} (commit ${FLOWSEAL_COMMIT.slice(0, 12)}): скачиваю списки и fake-пакеты`
  )

  const archivePath = join(work, 'flowseal.tar.gz')
  // Тарбол по sha коммита, а не по имени тега — тег можно переставить, sha неизменен.
  await writeFile(
    archivePath,
    await download(
      `https://codeload.github.com/Flowseal/zapret-discord-youtube/tar.gz/${FLOWSEAL_COMMIT}`
    )
  )

  const paths = [
    ...Object.keys(FLOWSEAL_LISTS),
    ...FLOWSEAL_FAKES.map((name) => `bin/${name}`),
    'LICENSE.txt'
  ]

  // GitHub codeload архивирует репозиторий в каталог "<repo>-<sha>/".
  const prefixOut = execFileSync('tar', ['-tzf', archivePath], { encoding: 'utf8' })
    .split('\n')[0]
    .split('/')[0]

  execFileSync('tar', ['-xzf', archivePath, '-C', work, ...paths.map((p) => `${prefixOut}/${p}`)], {
    stdio: ['ignore', 'ignore', 'inherit']
  })

  for (const [source, target] of Object.entries(FLOWSEAL_LISTS)) {
    const destination = join(DEST, target)
    await mkdir(dirname(destination), { recursive: true })
    await copyFile(join(work, prefixOut, source), destination)
    console.log(`  ${target}`)
  }

  const fakesDir = join(DEST, 'fakes')
  await mkdir(fakesDir, { recursive: true })
  for (const name of FLOWSEAL_FAKES) {
    await copyFile(join(work, prefixOut, 'bin', name), join(fakesDir, name))
    console.log(`  fakes/${name}`)
  }

  await copyFile(join(work, prefixOut, 'LICENSE.txt'), join(DEST, 'LICENSE.flowseal.txt'))
  console.log('  LICENSE.flowseal.txt')
}

/** Путь внутри ZapretMac-macOS-universal.zip до самого бинарника. */
const UTUNWS_ZIP_ENTRY = 'ZapretMac.app/Contents/Resources/Payload/bin/utunws'

async function fetchUtunwsEngine(work) {
  console.log(`Flowseal-mac ${FLOWSEAL_MAC_VERSION}: скачиваю ZapretMac-macOS-universal.zip`)

  const zipPath = join(work, 'zapretmac.zip')
  const zipBuffer = await download(
    `https://github.com/Flowseal/zapret-mac-discord-youtube/releases/download/${FLOWSEAL_MAC_VERSION}/ZapretMac-macOS-universal.zip`
  )

  const actual = sha256(zipBuffer)
  if (actual !== FLOWSEAL_MAC_ZIP_SHA256) {
    throw new Error(
      `не совпала контрольная сумма ZapretMac-macOS-universal.zip\n` +
        `  ожидалось: ${FLOWSEAL_MAC_ZIP_SHA256}\n  получено:  ${actual}`
    )
  }
  await writeFile(zipPath, zipBuffer)

  // unzip есть из коробки на macOS и в Git for Windows/WSL; в архиве Flowseal нет sha256sum.txt
  // на отдельные файлы — сумму всего zip уже сверили выше, здесь просто достаём бинарник.
  const utunwsDestination = join(DEST, 'darwin', 'utunws')
  await mkdir(dirname(utunwsDestination), { recursive: true })
  const extracted = execFileSync('unzip', ['-p', zipPath, UTUNWS_ZIP_ENTRY])
  await writeFile(utunwsDestination, extracted)
  await chmod(utunwsDestination, 0o755)
  console.log(`  darwin/utunws (${extracted.length} байт, universal x86_64+arm64)`)

  // LICENSE в архив релиза не входит (только ZapretMac.app) — берём из репозитория по тому
  // же тегу, что и версия релиза, тем же приёмом, что LICENSE.WinDivert.txt выше.
  const license = await download(
    `https://raw.githubusercontent.com/Flowseal/zapret-mac-discord-youtube/${FLOWSEAL_MAC_VERSION}/LICENSE`
  )
  await writeFile(join(DEST, 'LICENSE.flowseal-mac.txt'), license)
  console.log('  LICENSE.flowseal-mac.txt')
}

async function main() {
  const work = await mkdtemp(join(tmpdir(), 'zapret-'))

  try {
    await fetchZapretEngines(work)
    await fetchFlowsealData(work)
    await fetchUtunwsEngine(work)
    console.log(`Готово: ${DEST}`)
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}

// Повторная сборка не должна каждый раз ходить в сеть.
if (
  process.argv.includes('--force') ||
  !existsSync(join(DEST, 'darwin', 'utunws')) ||
  !existsSync(join(DEST, 'linux', 'x64', 'nfqws')) ||
  !existsSync(join(DEST, 'win32', 'x64', 'winws.exe')) ||
  !existsSync(join(DEST, 'lists', 'general.txt'))
) {
  await main()
} else {
  console.log(`zapret уже распакован в ${DEST} (перекачать: npm run zapret:fetch -- --force)`)
}
