import { app, BrowserWindow, ipcMain, Menu, Tray } from 'electron'
import { join } from 'node:path'
import { createAppIcon } from './trayIcon'
import { bindTray, updateTrayNow } from './trayUpdater'
import { bootstrap, compactTokens } from './bootstrap'

// 全局引用防止被 GC（Electron 常见坑：局部变量托盘会消失）
let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
// 托盘常驻语义：关窗=隐藏；只有托盘"退出"才真正退出
let isQuitting = false

function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 900,
    minHeight: 620,
    show: false,
    autoHideMenuBar: true,
    title: 'AgentMeter',
    // 无边框：自定义标题栏由渲染端 TitleBar 提供（品牌 + 拖拽区 + 窗口控制）
    frame: false,
    backgroundColor: '#0a0a0f',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js')
    }
  })

  win.on('ready-to-show', () => win.show())

  win.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault()
      win.hide()
    }
  })

  win.on('closed', () => {
    mainWindow = null
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return win
}

function showMainWindow(): void {
  if (!mainWindow) {
    mainWindow = createMainWindow()
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function createTray(): Tray {
  const t = new Tray(createAppIcon(16))
  t.setToolTip('AgentMeter')
  t.setContextMenu(
    Menu.buildFromTemplate([
      { label: '打开仪表盘', click: () => showMainWindow() },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          isQuitting = true
          app.quit()
        }
      }
    ])
  )
  // Windows 惯例：双击托盘打开主窗口
  t.on('double-click', () => showMainWindow())
  return t
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  // 无边框窗口控制（TitleBar 按钮 → IPC）
  ipcMain.on('win:minimize', () => mainWindow?.minimize())
  ipcMain.on('win:hide', () => mainWindow?.hide())

  app.on('second-instance', () => showMainWindow())

  void app.whenReady().then(() => {
    bootstrap()

    mainWindow = createMainWindow()
    tray = createTray()
    bindTray(tray)
    // 启动后 3 秒给首轮回填一点时间，再刷一次托盘
    setTimeout(() => updateTrayNow(() => trayFallbackText()), 3000)

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) mainWindow = createMainWindow()
    })
  })

  // 托盘常驻：所有窗口关闭后不退出进程
  app.on('window-all-closed', () => {})
}

function trayFallbackText(): { label: string; tooltip: string } {
  return {
    label: compactTokens(0),
    tooltip: 'AgentMeter 正在回填历史数据…'
  }
}

function getMainWindow(): BrowserWindow | null {
  return mainWindow
}

export { showMainWindow, getMainWindow }
