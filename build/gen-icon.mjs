/**
 * 图标生成管线（桌面 exe 图标 / 快捷方式 / 开始菜单）。
 * 矢量源 build/icon.svg 是唯一几何来源；每个目标尺寸独立矢量渲染
 * （解析几何 + 超采样光栅化，绝无位图缩放），小尺寸做笔画光学补偿。
 * 产物：
 *   build/icon.svg          矢量源（48 viewBox，线宽 1.75）
 *   build/icon.ico          多尺寸 16/24/32/48/64/128/256（逐尺寸真实渲染）
 *   build/icon.png          256 PNG（electron-builder 回退 / 预览）
 *   build/icon-src/*.png    各尺寸 PNG（供检查）
 * 形态：平线 → 主峰 → 深谷 → 小次峰 → 平线；透明底、仅一条蓝色 #5E9BFA 细线。
 * 注意：托盘图标（src/main/trayIcon.ts）与界面 Logo 不走本管线，几何需人工同步。
 */
import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath as furl } from 'node:url'

const COLOR = [94, 155, 250] // #5E9BFA（定稿，勿改）
const VB = 48 // viewBox 尺寸

// 48 坐标系下的波形点：平线→主峰(最高)→深谷(低于基线24)→小次峰→平线，水平居中
const PTS = [
  [7, 24],
  [15, 24],
  [19.5, 11.5],
  [23.5, 36.5],
  [27.5, 18],
  [30.5, 24],
  [41, 24]
]

// 各尺寸线宽（绝对像素）：48 为基准 1.75（细线）；16-32 光学补偿相对加粗；大尺寸按比例微收
const STROKE = { 16: 1.5, 24: 1.6, 32: 1.7, 48: 1.75, 64: 2, 128: 4, 256: 8 }
const SIZES = [16, 24, 32, 48, 64, 128, 256]

// ---------- 1) SVG 矢量源 ----------
const d = `M${PTS.map(([x, y]) => `${x} ${y}`).join(' L')}`
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VB} ${VB}" fill="none">
  <path d="${d}" stroke="#5E9BFA" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/>
</svg>
`

// ---------- 2) 矢量光栅化（超采样 + 块平均，直出 straight alpha） ----------
function renderPng(size) {
  const ss = size <= 64 ? 8 : 4
  const big = size * ss
  const px = new Float64Array(big * big * 4) // 直通 alpha 累加用
  const scale = size / VB
  const lw = STROKE[size] * ss
  const pts = PTS.map(([x, y]) => [x * scale * ss, y * scale * ss])

  const put = (x, y, a) => {
    if (x < 0 || y < 0 || x >= big || y >= big) return
    const i = (y * big + x) * 4
    px[i] = COLOR[0]
    px[i + 1] = COLOR[1]
    px[i + 2] = COLOR[2]
    px[i + 3] = Math.max(px[i + 3], a) // 同像素多次覆盖取最大覆盖度，避免叠加深边
  }
  const disc = (cx, cy, r) => {
    for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++)
      for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
        const dx = x + 0.5 - cx, dy = y + 0.5 - cy
        const dist = Math.hypot(dx, dy)
        if (dist <= r - 0.707) put(x, y, 1)
        else if (dist <= r + 0.707) put(x, y, Math.min(1, r + 0.707 - dist))
      }
  }
  const inQuad = (qx, qy, q) => {
    let inside = false
    for (let i = 0, j = 3; i < 4; j = i++) {
      const [xi, yi] = q[i], [xj, yj] = q[j]
      if (yi > qy !== yj > qy && qx < ((xj - xi) * (qy - yi)) / (yj - yi) + xi) inside = !inside
    }
    return inside
  }
  const seg = (a, b) => {
    const [x1, y1] = a, [x2, y2] = b
    const dx = x2 - x1, dy = y2 - y1
    const len = Math.hypot(dx, dy) || 1
    const nx = (-dy / len) * (lw / 2), ny = (dx / len) * (lw / 2)
    const q = [
      [x1 + nx, y1 + ny], [x2 + nx, y2 + ny], [x2 - nx, y2 - ny], [x1 - nx, y1 - ny]
    ]
    const xs = q.map((p) => p[0]), ys = q.map((p) => p[1])
    const minX = Math.floor(Math.min(...xs)) - 1, maxX = Math.ceil(Math.max(...xs)) + 1
    const minY = Math.floor(Math.min(...ys)) - 1, maxY = Math.ceil(Math.max(...ys)) + 1
    // 覆盖度采样：2x2 子采样点的落点比例（够用的抗锯齿，无杂边）
    for (let y = minY; y <= maxY; y++)
      for (let x = minX; x <= maxX; x++) {
        if (x < 0 || y < 0 || x >= big || y >= big) continue
        let hit = 0
        for (const [ox, oy] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]])
          if (inQuad(x + ox, y + oy, q)) hit++
        if (hit > 0) put(x, y, hit / 4)
      }
  }

  for (let i = 0; i + 1 < pts.length; i++) seg(pts[i], pts[i + 1])
  for (const p of pts) disc(p[0], p[1], lw / 2) // 圆角端点 + 圆角转折

  // SS×SS 块平均降采样（alpha 加权，straight alpha 输出）
  const out = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0
      for (let sy = 0; sy < ss; sy++)
        for (let sx = 0; sx < ss; sx++) {
          const i = ((y * ss + sy) * big + (x * ss + sx)) * 4
          const pa = px[i + 3]
          if (pa > 0) { r += px[i] * pa; g += px[i + 1] * pa; b += px[i + 2] * pa; a += pa }
        }
      const n = ss * ss
      const i = (y * size + x) * 4
      if (a > 0) {
        out[i] = Math.round(r / a)
        out[i + 1] = Math.round(g / a)
        out[i + 2] = Math.round(b / a)
        out[i + 3] = Math.round((a / n) * 255)
      }
    }
  return encodePng(size, size, out)
}

function encodePng(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h)
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4)
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type), data])
    let c = 0xffffffff
    for (const b of body) { c ^= b; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1 }
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE((c ^ 0xffffffff) >>> 0)
    return Buffer.concat([len, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 6 // RGBA 直出
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

// ---------- 3) 多尺寸 ICO（每个尺寸一张独立渲染的 PNG 条目） ----------
function buildIco(pngs) {
  const count = pngs.length
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2) // icon
  header.writeUInt16LE(count, 4)
  let offset = 6 + 16 * count
  const entries = []
  const blobs = []
  pngs.forEach(([size, png]) => {
    const e = Buffer.alloc(16)
    e[0] = size >= 256 ? 0 : size
    e[1] = size >= 256 ? 0 : size
    e[2] = 0 // palette
    e[3] = 0
    e.writeUInt16LE(1, 4) // planes
    e.writeUInt16LE(32, 6) // bpp
    e.writeUInt32LE(png.length, 8)
    e.writeUInt32LE(offset, 12)
    offset += png.length
    entries.push(e)
    blobs.push(png)
  })
  return Buffer.concat([header, ...entries, ...blobs])
}

// ---------- 执行 ----------
const here = dirname(furl(import.meta.url))
mkdirSync(join(here, 'icon-src'), { recursive: true })
writeFileSync(join(here, 'icon.svg'), svg)

const pngs = SIZES.map((s) => [s, renderPng(s)])
for (const [s, png] of pngs) writeFileSync(join(here, 'icon-src', `icon-${s}.png`), png)
writeFileSync(join(here, 'icon.png'), pngs.find(([s]) => s === 256)[1])
writeFileSync(join(here, 'icon.ico'), buildIco(pngs))
console.log(
  `icon written: build/icon.svg + icon.ico(${SIZES.join('/')} 独立渲染) + icon-src/*.png (${COLOR.join(',')} 透明底细线波形)`
)
