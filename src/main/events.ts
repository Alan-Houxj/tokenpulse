import { BrowserWindow } from 'electron'

/**
 * 主进程 → 渲染端的统一广播入口（实时刷新走这里，M5 接入）。
 * 发送前检查窗口存在且未销毁，隐藏窗口也能收到（托盘 tooltip 数据同步依赖这点）。
 */
export function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, payload)
    }
  }
}
