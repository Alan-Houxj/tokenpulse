import { nativeImage, type NativeImage } from 'electron'

/**
 * 托盘图标：透明底 + 蓝色心电脉冲细线（#5E9BFA）。
 * 几何与桌面图标矢量源 build/icon.svg 同一套 48 坐标系点集（改形状两边同步），
 * 解析几何 + 超采样光栅化，按目标尺寸独立渲染（绝无位图缩放）。
 * 小尺寸做笔画光学补偿（16px 下线宽 1.5px），保证线条清晰不断。
 */

interface Rgba {
  r: number
  g: number
  b: number
  a?: number
}

const WAVE: Rgba = { r: 94, g: 155, b: 250 } // #5E9BFA（定稿，勿改）
const VB = 48 // 与 icon.svg 相同的 viewBox

// 平线 → 主峰(最高) → 深谷(低于基线) → 小次峰 → 平线，水平居中
const PTS: [number, number][] = [
  [7, 24],
  [15, 24],
  [19.5, 11.5],
  [23.5, 36.5],
  [27.5, 18],
  [30.5, 24],
  [41, 24]
]

class PixelBuffer {
  readonly data: Buffer
  constructor(readonly width: number, readonly height: number) {
    this.data = Buffer.alloc(width * height * 4)
  }
  set(x: number, y: number, c: Rgba): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return
    const i = (y * this.width + x) * 4
    const a = c.a ?? 255
    // 简单 alpha 合成
    const oldA = this.data[i + 3]!
    if (oldA === 0 || a === 255) {
      this.data[i] = c.r
      this.data[i + 1] = c.g
      this.data[i + 2] = c.b
      this.data[i + 3] = a
    } else {
      const na = a + (oldA * (255 - a)) / 255
      this.data[i] = Math.round((c.r * a + this.data[i]! * oldA * (1 - a / 255)) / na)
      this.data[i + 1] = Math.round((c.g * a + this.data[i + 1]! * oldA * (1 - a / 255)) / na)
      this.data[i + 2] = Math.round((c.b * a + this.data[i + 2]! * oldA * (1 - a / 255)) / na)
      this.data[i + 3] = Math.round(na)
    }
  }
  strokeQuad(q: [number, number][], color: Rgba): void {
    const xs = q.map((p) => p[0])
    const ys = q.map((p) => p[1])
    const minX = Math.floor(Math.min(...xs)) - 1
    const maxX = Math.ceil(Math.max(...xs)) + 1
    const minY = Math.floor(Math.min(...ys)) - 1
    const maxY = Math.ceil(Math.max(...ys)) + 1
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        if (x < 0 || y < 0 || x >= this.width || y >= this.height) continue
        if (pointInQuad(x + 0.5, y + 0.5, q)) this.set(x, y, color)
      }
    }
  }
  disc(cx: number, cy: number, r: number, color: Rgba): void {
    for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
      for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
        if (x < 0 || y < 0 || x >= this.width || y >= this.height) continue
        if ((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 <= r * r) this.set(x, y, color)
      }
    }
  }
  toNativeImage(): NativeImage {
    // Electron 期望预乘 alpha（Windows/Linux 字节序为 BGRA，macOS 为 RGBA）；
    // 内部按直通 RGBA 绘制，输出前先预乘再按平台换序，否则半透明边缘会发白
    const out = Buffer.from(this.data)
    for (let i = 0; i < out.length; i += 4) {
      const a = out[i + 3]!
      if (a !== 255) {
        out[i] = Math.round((out[i]! * a) / 255)
        out[i + 1] = Math.round((out[i + 1]! * a) / 255)
        out[i + 2] = Math.round((out[i + 2]! * a) / 255)
      }
      if (process.platform !== 'darwin') {
        const r = out[i]!
        out[i] = out[i + 2]!
        out[i + 2] = r
      }
    }
    return nativeImage.createFromBuffer(out, { width: this.width, height: this.height })
  }
}

function pointInQuad(px: number, py: number, q: [number, number][]): boolean {
  let inside = false
  for (let i = 0, j = 3; i < 4; j = i++) {
    const [xi, yi] = q[i]!
    const [xj, yj] = q[j]!
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

/** 托盘图标。size 为最终逻辑尺寸（Windows 托盘为 16），SS 倍超采样抗锯齿。 */
export function createTrayIcon(size = 16): NativeImage {
  const SS = 4
  const big = size * SS
  const buf = new PixelBuffer(big, big)

  const scale = (size / VB) * SS
  const pts = PTS.map(([x, y]) => [x * scale, y * scale] as [number, number])
  const lw = 1.5 * SS // 16px 光学补偿线宽；与 icon.ico 的 16px 条目一致
  for (let i = 0; i + 1 < pts.length; i++) {
    const [x1, y1] = pts[i]!
    const [x2, y2] = pts[i + 1]!
    const dx = x2 - x1
    const dy = y2 - y1
    const len = Math.hypot(dx, dy) || 1
    const nx = (-dy / len) * (lw / 2)
    const ny = (dx / len) * (lw / 2)
    buf.strokeQuad(
      [
        [x1 + nx, y1 + ny],
        [x2 + nx, y2 + ny],
        [x2 - nx, y2 - ny],
        [x1 - nx, y1 - ny]
      ],
      WAVE
    )
    buf.disc(x1, y1, lw / 2, WAVE)
    if (i === pts.length - 2) buf.disc(x2, y2, lw / 2, WAVE)
  }

  // SS×SS 块平均降采样（含 alpha 加权）
  const out = new PixelBuffer(size, size)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const i = ((y * SS + sy) * big + (x * SS + sx)) * 4
          const pa = buf.data[i + 3]! / 255
          r += buf.data[i]! * pa
          g += buf.data[i + 1]! * pa
          b += buf.data[i + 2]! * pa
          a += pa
        }
      }
      if (a > 0) {
        out.data.set(
          [Math.round(r / a), Math.round(g / a), Math.round(b / a), Math.round((a / (SS * SS)) * 255)],
          (y * size + x) * 4
        )
      }
    }
  }
  return out.toNativeImage()
}
