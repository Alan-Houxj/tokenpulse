import { nativeImage, type NativeImage } from 'electron'

/**
 * 托盘图标生成器。
 * 不带任何图像依赖：直接在 RGBA 缓冲区上绘制（圆角底 + 5x7 位图字体数字），
 * 由 nativeImage.createFromBuffer 转 Electron 图标。M4 会用它画"今日 token 档位"。
 */

interface Rgba {
  r: number
  g: number
  b: number
  a?: number
}

const BG: Rgba = { r: 59, g: 130, b: 246 } // blue-500（应用强调色）
const BG_DARK: Rgba = { r: 37, g: 99, b: 235 } // blue-600
const FG: Rgba = { r: 238, g: 242, b: 247 } // 亮字（暗底蓝上对比更好）

// 5x7 位图字体，行用 5 位二进制表示（MSB 在左）
const FONT_5X7: Record<string, number[]> = {
  '0': [0b01110, 0b10001, 0b10011, 0b10101, 0b11001, 0b10001, 0b01110],
  '1': [0b00100, 0b01100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110],
  '2': [0b01110, 0b10001, 0b00001, 0b00010, 0b00100, 0b01000, 0b11111],
  '3': [0b11110, 0b00001, 0b00001, 0b01110, 0b00001, 0b00001, 0b11110],
  '4': [0b00010, 0b00110, 0b01010, 0b10010, 0b11111, 0b00010, 0b00010],
  '5': [0b11111, 0b10000, 0b11110, 0b00001, 0b00001, 0b10001, 0b01110],
  '6': [0b00110, 0b01000, 0b10000, 0b11110, 0b10001, 0b10001, 0b01110],
  '7': [0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b01000, 0b01000],
  '8': [0b01110, 0b10001, 0b10001, 0b01110, 0b10001, 0b10001, 0b01110],
  '9': [0b01110, 0b10001, 0b10001, 0b01111, 0b00001, 0b00010, 0b01100],
  k: [0b10001, 0b10010, 0b10100, 0b11000, 0b10100, 0b10010, 0b10001],
  M: [0b10001, 0b11011, 0b10101, 0b10101, 0b10001, 0b10001, 0b10001],
  '+': [0b00000, 0b00100, 0b00100, 0b11111, 0b00100, 0b00100, 0b00000],
  ' ': [0, 0, 0, 0, 0, 0, 0]
}

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
  fillRounded(color: Rgba, radius: number): void {
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        // 距圆角中心的距离判定
        const cx = Math.min(Math.max(x, radius), this.width - 1 - radius)
        const cy = Math.min(Math.max(y, radius), this.height - 1 - radius)
        const dx = x - cx
        const dy = y - cy
        if (dx * dx + dy * dy <= radius * radius) this.set(x, y, color)
      }
    }
  }
  drawText(text: string, color: Rgba, scale: number, offsetX: number, offsetY: number): void {
    let cx = offsetX
    for (const ch of text) {
      const glyph = FONT_5X7[ch] ?? FONT_5X7[' ']!
      for (let gy = 0; gy < 7; gy++) {
        for (let gx = 0; gx < 5; gx++) {
          if (glyph[gy]! & (1 << (4 - gx))) {
            for (let sy = 0; sy < scale; sy++) {
              for (let sx = 0; sx < scale; sx++) {
                this.set(cx + gx * scale + sx, offsetY + gy * scale + sy, color)
              }
            }
          }
        }
      }
      cx += (5 + 1) * scale
    }
  }
  toNativeImage(): NativeImage {
    return nativeImage.createFromBuffer(this.data, { width: this.width, height: this.height })
  }
}

/** 静态应用图标（M0 占位，M4 换成带数字的动态图标） */
export function createAppIcon(size = 16): NativeImage {
  const buf = new PixelBuffer(size, size)
  buf.fillRounded(BG, Math.max(2, Math.floor(size / 5)))
  // 左上到右下的斜杠纹理，让图标在浅色/深色任务栏都可辨
  const dark = BG_DARK
  for (let i = 0; i < size; i++) {
    const d = (i * 2) % size
    buf.set(d, i, dark)
  }
  return buf.toNativeImage()
}

/**
 * 带文本的托盘图标（M4 用于显示今日 token 档位，如 "12M"）。
 * text 建议不超过 3 字符。
 */
export function createTrayLabelIcon(text: string, size = 16): NativeImage {
  const buf = new PixelBuffer(size, size)
  buf.fillRounded(BG, Math.max(2, Math.floor(size / 5)))
  const scale = text.length >= 3 ? 1 : text.length === 2 ? 2 : 2
  const textW = text.length * 6 * scale - scale
  const offX = Math.floor((size - textW) / 2)
  const offY = Math.floor((size - 7 * scale) / 2)
  buf.drawText(text, FG, scale, offX, offY)
  return buf.toNativeImage()
}
