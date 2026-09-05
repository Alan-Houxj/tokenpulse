/**
 * 生成应用图标 build/icon.png（256x256 RGBA）。
 * 视觉与产品顶栏 Logo 一致：圆角方块蓝底 + 白色脉冲波形（心电图折线）。
 * 零依赖：手写 PNG 编码（zlib deflate + CRC32）。
 * 想换图标形状/配色：改下方波形点集与颜色后重跑 `npm run icon`。
 */
import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath as furl } from 'node:url'

const SIZE = 256
const R = 56 // 圆角半径
const BG = [59, 130, 246, 255] // blue-500（品牌蓝）
const FG = [240, 244, 250, 255] // 波形白

// 脉冲波形点集（TitleBar Logo 的 20x20 viewBox 坐标）
const WAVE_20 = [
  [1, 10.5],
  [4.2, 10.5],
  [6.2, 4.3],
  [9.4, 16.3],
  [11.8, 8.3],
  [13.4, 11.7],
  [18.4, 11.7]
]

const px = Buffer.alloc(SIZE * SIZE * 4)

function blend(x, y, [r, g, b, a]) {
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

// 1) 圆角方块底
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const cx = Math.min(Math.max(x, R), SIZE - 1 - R)
    const cy = Math.min(Math.max(y, R), SIZE - 1 - R)
    const dx = x - cx, dy = y - cy
    if (dx * dx + dy * dy <= R * R) blend(x, y, BG)
  }
}

// 2) 波形映射到 256 画布（水平留边距，纵向居中）
const PAD = 44
const scale = (SIZE - PAD * 2) / 19.4 // 20 系宽约 19.4
const rawPts = WAVE_20.map(([x, y]) => [PAD + (x - 1) * scale, y * scale])
const yMin = Math.min(...rawPts.map((p) => p[1]))
const yMax = Math.max(...rawPts.map((p) => p[1]))
const yShift = SIZE / 2 - (yMin + yMax) / 2
const pts2 = rawPts.map(([x, y]) => [Math.round(x), Math.round(y + yShift)])

// 3) 粗折线：逐段生成带宽度四边形 + 圆头端点
const LW = 19 // 线宽
for (let i = 0; i + 1 < pts2.length; i++) {
  const [x1, y1] = pts2[i]
  const [x2, y2] = pts2[i + 1]
  const dx = x2 - x1, dy = y2 - y1
  const len = Math.hypot(dx, dy) || 1
  const nx = (-dy / len) * (LW / 2), ny = (dx / len) * (LW / 2)
  const quad = [
    [x1 + nx, y1 + ny], [x2 + nx, y2 + ny],
    [x2 - nx, y2 - ny], [x1 - nx, y1 - ny]
  ]
  fillQuad(quad)
  // 端点圆头
  fillDisc(x1, y1, LW / 2)
  if (i === pts2.length - 2) fillDisc(x2, y2, LW / 2)
}

function fillQuad(q) {
  const xs = q.map((p) => p[0]), ys = q.map((p) => p[1])
  const minX = Math.floor(Math.min(...xs)) - 1, maxX = Math.ceil(Math.max(...xs)) + 1
  const minY = Math.floor(Math.min(...ys)) - 1, maxY = Math.ceil(Math.max(...ys)) + 1
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) continue
      if (pointInQuad(x + 0.5, y + 0.5, q)) blend(x, y, FG)
    }
  }
}

function pointInQuad(px_, py_, q) {
  let inside = false
  for (let i = 0, j = 3; i < 4; j = i++) {
    const [xi, yi] = q[i], [xj, yj] = q[j]
    if (yi > py_ !== yj > py_ && px_ < ((xj - xi) * (py_ - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

function fillDisc(cx, cy, r) {
  for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
    for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
      if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) continue
      if ((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 <= r * r) blend(x, y, FG)
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
ihdr[8] = 8
ihdr[9] = 6
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

const out = resolve(dirname(furl(import.meta.url)), 'icon.png')
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, png)
console.log(`icon written: ${out} (${png.length} bytes) — 蓝底白色脉冲波形`)
