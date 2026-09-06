import { nativeImage, type NativeImage } from 'electron'
import { TRAY_PNG_16, TRAY_PNG_20, TRAY_PNG_24, TRAY_PNG_32 } from './trayIconAssets'

/**
 * 托盘图标：定稿素材（build/icon.ico 内嵌的独立渲染帧，16/20/24/32 原样字节）。
 * 按显示器缩放挂多分辨率表示（1.0/1.25/1.5/2.0），Electron 自行挑帧，
 * 任何 DPI 下都不发生位图缩放。素材更新流程：替换 icon.ico 后重新提取 trayIconAssets.ts。
 */
export function createTrayIcon(): NativeImage {
  const decode = (b64: string, size: number): NativeImage => {
    const img = nativeImage.createFromBuffer(Buffer.from(b64, 'base64'))
    return img.getSize().width === size ? img : nativeImage.createEmpty()
  }
  const base = decode(TRAY_PNG_16, 16)
  for (const [b64, factor, size] of [
    [TRAY_PNG_20, 1.25, 20],
    [TRAY_PNG_24, 1.5, 24],
    [TRAY_PNG_32, 2.0, 32]
  ] as const) {
    const rep = decode(b64, size)
    if (!rep.isEmpty()) base.addRepresentation({ scaleFactor: factor, buffer: rep.toPNG(), width: size, height: size })
  }
  return base
}
