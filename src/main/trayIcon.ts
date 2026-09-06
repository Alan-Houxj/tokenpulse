import { nativeImage, screen, type NativeImage } from 'electron'
import { TRAY_PNG_16, TRAY_PNG_20, TRAY_PNG_24, TRAY_PNG_32 } from './trayIconAssets'

/**
 * 托盘图标：定稿素材（build/icon.ico 内嵌的独立渲染帧，16/20/24/32 原样字节）。
 * Windows 托盘槽位 = 16 逻辑 px × 显示器缩放，故按主显示器缩放取**对应物理尺寸**的帧：
 * 150% 缩放下若走多分辨率表示，Electron 可能仍取 1x 基准帧交由系统拉伸（发糊），
 * 直接选帧可保证任何缩放下都是 1:1 无缩放显示。
 * 素材更新流程：替换 build/icon.ico 后重新提取 trayIconAssets.ts。
 */
const FRAMES: Record<number, string> = {
  16: TRAY_PNG_16,
  20: TRAY_PNG_20,
  24: TRAY_PNG_24,
  32: TRAY_PNG_32
}

export function createTrayIcon(): NativeImage {
  const scale = screen.getPrimaryDisplay().scaleFactor ?? 1
  const wanted = Math.round(16 * scale)
  const sizes = Object.keys(FRAMES).map(Number).sort((a, b) => a - b)
  // 精确匹配优先；否则取最近的更大帧（系统轻度下采样远好于上采样）
  const size =
    sizes.find((s) => s === wanted) ??
    sizes.find((s) => s >= wanted) ??
    sizes[sizes.length - 1]!
  return nativeImage.createFromBuffer(Buffer.from(FRAMES[size]!, 'base64'))
}
