import { nativeImage, type NativeImage } from 'electron'

/**
 * 托盘图标：透明底 + 蓝色脉冲折线（与顶栏 Logo 同一组 WAVE_20 点集）。
 * 不带图像依赖：直接在 RGBA 缓冲区上绘制，4 倍超采样后降采样抗锯齿。
 * 16px 下实底方块会糊成一团，去底只留线条在浅色/深色任务栏上都更清晰；
 * 应用图标（exe/窗口）仍保留蓝底方块，两者刻意不同。
 */

interface Rgba {
  r: number
  g: number
  b: number
  a?: number
}

const WAVE: Rgba = { r: 59, g: 130, b: 246 } // blue-500（品牌蓝）

// 脉冲波形点集（TitleBar Logo 的 20x20 viewBox 坐标）
const WAVE_20 = [
  [1, 10.5],
  [4.2, 10.5],
  [6.2, 4.3],
  [9.4, 16.3],
  [11.8, 8.3],
  [13.4, 11.7],
  [18.4, 11.7]
] as const

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
    // Electron 在 Windows/Linux 期望 BGRA 字节序，macOS 为 RGBA；内部按 RGBA 绘制，输出前转换
    if (process.platform === 'darwin') {
      return nativeImage.createFromBuffer(this.data, { width: this.width, height: this.height })
    }
    const bgra = Buffer.from(this.data)
    for (let i = 0; i < bgra.length; i += 4) {
      const r = bgra[i]!
      bgra[i] = bgra[i + 2]!
      bgra[i + 2] = r
    }
    return nativeImage.createFromBuffer(bgra, { width: this.width, height: this.height })
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

/**
 * 托盘脉冲波形图标。size 为最终逻辑尺寸（Windows 托盘为 16），
 * 内部以 SS 倍超采样绘制再平均降采样，避免小尺寸锯齿。
 */
export function createTrayIcon(size = 16): NativeImage {
  const SS = 4
  const big = size * SS
  const buf = new PixelBuffer(big, big)

  // 波形映射：水平留 1px 边距，纵向居中（与 gen-icon.mjs 同法）
  const pad = SS
  const scale = (big - pad * 2) / 19.4
  const raw: [number, number][] = WAVE_20.map(([x, y]) => [pad + (x - 1) * scale, y * scale])
  const yMin = Math.min(...raw.map((p) => p[1]))
  const yMax = Math.max(...raw.map((p) => p[1]))
  const yShift = big / 2 - (yMin + yMax) / 2
  const pts = raw.map(([x, y]) => [x, y + yShift] as [number, number])
  const lw = Math.max(2, Math.round(size / 8)) * SS // 16px 下线宽 2px，无底色故稍细
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
