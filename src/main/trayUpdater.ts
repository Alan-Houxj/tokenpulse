/**
 * 托盘动态更新：图标画今日总量档位、tooltip 分 Agent 小结。
 * 相同文本不重复 setImage（避免每 5 秒无谓刷新）。
 */
import { Tray } from 'electron'
import { createTrayLabelIcon } from './trayIcon'

let trayRef: Tray | null = null
let lastLabel = ''

export function bindTray(tray: Tray): void {
  trayRef = tray
}

export function updateTrayNow(getText: () => { label: string; tooltip: string }): void {
  if (!trayRef) return
  try {
    const { label, tooltip } = getText()
    trayRef.setToolTip(tooltip)
    // 托盘图标空间有限，最多 3 字符（"9M" / "12M" / "980k"→截断）
    const short = label.length > 3 ? label.replace('.0', '').slice(0, 3) : label
    if (short !== lastLabel) {
      lastLabel = short
      trayRef.setImage(createTrayLabelIcon(short, 16))
    }
  } catch {
    /* 托盘更新失败不影响采集 */
  }
}
