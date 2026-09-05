import { app, BrowserWindow, ipcMain, Menu, Tray } from 'electron'
import { join } from 'node:path'
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { createAppIcon } from './trayIcon'
import { bindTray, updateTrayNow } from './trayUpdater'
import { bootstrap, compactTokens } from './bootstrap'

/**
 * 品牌迁移：productName 由 AgentMeter 改为 TokenPulse 后，Electron 的 userData
 * 目录随之改变（%APPDATA%\TokenPulse）。首次运行新版本时把旧目录
 * %APPDATA%\AgentMeter 里的数据库与配置复制过来（旧目录保留不动，安全回退）。
 */
function migrateOldUserData(): void {
  const newData = app.getPath('userData')
  const oldData = join(app.getPath('appData'), 'AgentMeter') // 旧品牌目录名（迁移源，勿随品牌替换）
  const hasOwnData = existsSync(join(newData, 'agentmeter.db')) || existsSync(join(newData, 'config.json'))
  if (hasOwnData || !existsSync(oldData)) return
  try {
    mkdirSync(newData, { recursive: true })
    for (const f of ['agentmeter.db', 'agentmeter.db-wal', 'agentmeter.db-shm', 'config.json']) {
      const src = join(oldData, f)
      if (existsSync(src)) copyFileSync(src, join(newData, f))
    }
    console.log('[tokenpulse] 已从旧版 AgentMeter 目录迁移历史数据')
  } catch (e) {
    console.warn('[tokenpulse] 旧数据迁移失败（将以全新状态启动）:', e)
  }
}

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
    title: 'TokenPulse',
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
  t.setToolTip('TokenPulse')
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
    migrateOldUserData()
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
    tooltip: 'TokenPulse 正在回填历史数据…'
  }
}

function getMainWindow(): BrowserWindow | null {
  return mainWindow
}

export { showMainWindow, getMainWindow }
