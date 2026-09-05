/**
 * 托盘更新：图标固定为脉冲波形 Logo（createTrayIcon），仅动态刷新 tooltip（分 Agent 小结）。
 */
import { Tray } from 'electron'

let trayRef: Tray | null = null

export function bindTray(tray: Tray): void {
  trayRef = tray
}

export function updateTrayNow(getText: () => { label: string; tooltip: string }): void {
  if (!trayRef) return
  try {
    const { tooltip } = getText()
    trayRef.setToolTip(tooltip)
  } catch {
    /* 托盘更新失败不影响采集 */
  }
}
