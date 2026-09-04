// Рисует иконки для трея: щит с заливкой («обход включён») и щит контуром («выключен»),
// по паре размеров на каждую (16 и 32 px — 1x и 2x для меню-бара macOS).
//
// Чёрный цвет + альфа — это ровно то, что macOS ждёт от template-картинки: систему интересует
// только альфа-канал, цвет она подставляет сама под светлое или тёмное меню-бар.
//
// Скрипт запускается руками (`node scripts/make-tray-icons.mjs`), результат лежит в
// resources/tray и коммитится: в сборку его не включаем, чтобы не тащить генерацию картинок
// в каждый `npm run build`.
import { deflateSync } from 'node:zlib'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'resources', 'tray')

/** Сглаживание: считаем SUPERSAMPLE² проб на пиксель и усредняем — иначе на 16 px рвань. */
const SUPERSAMPLE = 4

/** Толщина контура у «выключенного» щита, в долях размера. */
const STROKE = 0.11

/** Центр, относительно которого сжимаем щит, чтобы получить внутренний край контура. */
const CENTER = { x: 0.5, y: 0.54 }

const TOP = 0.1
const BOTTOM = 0.94
/** Ниже этой линии бока щита сходятся к острию. */
const SHOULDER = 0.56
const HALF_WIDTH = 0.34
/** Скругление верхних углов. */
const CORNER = 0.1

/**
 * Точка внутри щита? Щит — прямоугольник со скруглённым верхом, ниже «плеч» сужающийся
 * по четверти эллипса к острию внизу.
 */
function insideShield(x, y) {
  if (y < TOP || y > BOTTOM) return false

  let halfWidth = HALF_WIDTH
  if (y > SHOULDER) {
    const t = (y - SHOULDER) / (BOTTOM - SHOULDER)
    halfWidth = HALF_WIDTH * Math.sqrt(Math.max(0, 1 - t * t))
  }

  const dx = Math.abs(x - 0.5)
  if (dx > halfWidth) return false

  // Скругление верхних углов: за пределами прямых участков считаем расстояние до центра дуги.
  if (y < TOP + CORNER && dx > halfWidth - CORNER) {
    const cx = halfWidth - CORNER
    const cy = TOP + CORNER
    return (dx - cx) ** 2 + (y - cy) ** 2 <= CORNER * CORNER
  }

  return true
}

/** Тот же щит, сжатый к центру на толщину контура, — внутренняя граница обводки. */
function insideInnerShield(x, y) {
  const scale = 1 / (1 - 2 * STROKE)
  return insideShield((x - CENTER.x) * scale + CENTER.x, (y - CENTER.y) * scale + CENTER.y)
}

/** Альфа пикселя: доля проб, попавших в фигуру. */
function coverage(px, py, size, filled) {
  let hits = 0
  for (let sy = 0; sy < SUPERSAMPLE; sy++) {
    for (let sx = 0; sx < SUPERSAMPLE; sx++) {
      const x = (px + (sx + 0.5) / SUPERSAMPLE) / size
      const y = (py + (sy + 0.5) / SUPERSAMPLE) / size
      if (!insideShield(x, y)) continue
      if (!filled && insideInnerShield(x, y)) continue
      hits++
    }
  }
  return Math.round((hits / (SUPERSAMPLE * SUPERSAMPLE)) * 255)
}

function rgba(size, filled) {
  // По байту на канал, плюс ведущий байт фильтра в начале каждой строки (формат PNG).
  const rows = Buffer.alloc(size * (size * 4 + 1))
  let offset = 0
  for (let y = 0; y < size; y++) {
    rows[offset++] = 0 // filter type 0 (None)
    for (let x = 0; x < size; x++) {
      offset += 3 // R,G,B остаются нулями — чёрный
      rows[offset++] = coverage(x, y, size, filled)
    }
  }
  return rows
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32(buffer) {
  let c = 0xffffffff
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function png(size, filled) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header[8] = 8 // бит на канал
  header[9] = 6 // цветовой тип: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rgba(size, filled), { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

await mkdir(OUT_DIR, { recursive: true })
for (const [name, filled] of [
  ['on', true],
  ['off', false]
]) {
  for (const size of [16, 32]) {
    const path = join(OUT_DIR, `${name}-${size}.png`)
    await writeFile(path, png(size, filled))
    console.log(`создано: ${path}`)
  }
}
