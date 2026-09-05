/**
 * 生成应用图标 build/icon.png（256x256 RGBA）。
 * 与托盘图标同款视觉：emerald 圆角方块 + 斜杠纹理 + 居中 "A"。
 * 零依赖：手写 PNG 编码（zlib deflate + CRC32）。
 */
import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SIZE = 256
const R = 56
const BG = [59, 130, 246, 255]
const DARK = [37, 99, 235, 255]
const FG = [238, 242, 247, 255]

const px = Buffer.alloc(SIZE * SIZE * 4)

function set(x, y, [r, g, b, a]) {
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return
  const i = (y * SIZE + x) * 4
  const oldA = px[i + 3]
  if (oldA === 0 || a === 255) {
    px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a
  } else {
    const na = a + (oldA * (255 - a)) / 255
    px[i] = Math.round((r * a + px[i] * oldA * (1 - a / 255)) / na)
    px[i + 1] = Math.round((g * a + px[i + 1] * oldA * (1 - a / 255)) / na)
    px[i + 2] = Math.round((b * a + px[i + 2] * oldA * (1 - a / 255)) / na)
    px[i + 3] = Math.round(na)
  }
}

// 圆角方块底
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const cx = Math.min(Math.max(x, R), SIZE - 1 - R)
    const cy = Math.min(Math.max(y, R), SIZE - 1 - R)
    const dx = x - cx, dy = y - cy
    if (dx * dx + dy * dy <= R * R) set(x, y, BG)
  }
}
// 斜杠纹理
for (let i = 0; i < SIZE; i++) {
  const d = Math.floor((i * 2.2) % SIZE)
  for (let t = -2; t <= 2; t++) {
    set(d + t, i, DARK)
  }
}

// 字母 A（5x7 位图放大）
const A = [
  0b01110, 0b10001, 0b10001, 0b11111, 0b10001, 0b10001, 0b10001
]
const scale = 22
const w = 5 * scale, h = 7 * scale
const ox = Math.floor((SIZE - w) / 2), oy = Math.floor((SIZE - h) / 2)
for (let gy = 0; gy < 7; gy++) {
  for (let gx = 0; gx < 5; gx++) {
    if (A[gy] & (1 << (4 - gx))) {
      for (let sy = 0; sy < scale; sy++) {
        for (let sx = 0; sx < scale; sx++) {
          set(ox + gx * scale + sx, oy + gy * scale + sy, FG)
        }
      }
    }
  }
}

// ---- PNG 编码 ----
function crc32(buf) {
  let c, table = crc32.table
  if (!table) {
    table = crc32.table = []
    for (let n = 0; n < 256; n++) {
      c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      table[n] = c >>> 0
    }
  }
  c = 0xffffffff
  for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(SIZE, 0)
ihdr.writeUInt32BE(SIZE, 4)
ihdr[8] = 8 // bit depth
ihdr[9] = 6 // RGBA
// 每行前加 filter byte 0
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1))
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0
  px.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4)
}
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0))
])

const out = resolve(dirname(fileURLToPath(import.meta.url)), 'icon.png')
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, png)
console.log(`icon written: ${out} (${png.length} bytes)`)
