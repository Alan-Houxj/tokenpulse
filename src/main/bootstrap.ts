/**
 * 应用装配中枢：存储 + 配置 + 适配器 + 调度器 + IPC 数据通道。
 * 只在主进程运行；core 层保持零 Electron 依赖。
 */
import { app, clipboard, ipcMain, shell } from 'electron'
import {
  Store,
  defaultDbPath,
  buildAdapters,
  UsageScheduler,
  probeAll,
  probeRoot,
  loadConfig,
  saveConfig,
  effectivePriceTable,
  collectLiveAgents,
  BUILTIN_PRICES,
  PRICES_VERSION
} from '@core/index'
import type { PriceOverrides } from '@core/engine/cost'
import { ClaudeCodeAdapter } from '@core/adapters/claude-code'
import { CodexAdapter } from '@core/adapters/codex'
import { createGeminiAdapter, createQwenAdapter } from '@core/adapters/gemini-like'
import { ZCodeAdapter } from '@core/adapters/zcode'
import type { AgentId, AgentMeterConfig, ProbeResult, SourceAdapter } from '@core/index'
import { broadcast } from './events'
import { updateTrayNow } from './trayUpdater'

let store: Store
let config: AgentMeterConfig
let scheduler: UsageScheduler
let firstTickLogged = false

export function bootstrap(): void {
  const userDataDir = app.getPath('userData')
  store = Store.open(defaultDbPath(userDataDir))
  config = loadConfig(userDataDir)
  const adapters = buildAdapters({ roots: config.roots })

  // 价格表版本变化 → 自动重算全部历史事件的估算成本（保证口径一致）
  if (store.getMeta('prices_version') !== String(PRICES_VERSION)) {
    const n = store.recomputeCosts(effectivePriceTable(config.priceOverrides))
    store.setMeta('prices_version', String(PRICES_VERSION))
    if (n > 0) console.log(`[agentmeter] 价格表更新，已重算 ${n} 条历史事件的估算成本`)
  }

  // 数据口径修正 v2：ZCode input 含缓存读的历史事件拆分 + 成本重算
  if (store.getMeta('data_version') !== '2' && store.getMeta('data_version') !== '3') {
    const n = store.migrateZcodeInputV2()
    store.recomputeCosts(effectivePriceTable(config.priceOverrides))
    if (n > 0) console.log(`[agentmeter] 已修正 ${n} 条 ZCode 历史事件的输入口径（缓存双计）`)
  }

  // 迁移 v3：清除 unknown 模型事件（增量状态丢失 bug 的存量），重置位点重新回填
  if (store.getMeta('data_version') !== '3') {
    const { removedEvents } = store.migrateUnknownModelsV3()
    store.setMeta('data_version', '3')
    if (removedEvents > 0) console.log(`[agentmeter] 已清理 ${removedEvents} 条 unknown 模型事件，将重新回填`)
  }

  // 迁移 v4：ZCode 项目路径 JOIN 列名修复，重采带回 project_path
  if (store.getMeta('data_version') !== '4' && store.getMeta('data_version') !== '5') {
    const n = store.migrateZcodePathsV4()
    if (n > 0) console.log(`[agentmeter] 已重置 ${n} 条 ZCode 事件以回填项目路径`)
  }

  // 迁移 v5：Codex 旧格式（token_count）解析已支持 + ZCode WAL 签名修复，
  // 重置 codex 位点重新全量扫描（幂等键保护不重复入库）
  if (store.getMeta('data_version') !== '5') {
    store.resetCodexPositionsV5()
    store.setMeta('data_version', '5')
    console.log('[agentmeter] 已重置 Codex 位点（旧格式重扫 + WAL 签名修复）')
  }

  scheduler = new UsageScheduler({
    adapters,
    store,
    intervalMs: Math.max(1000, config.pollIntervalMs),
    prices: config.priceOverrides,
    onTick: (summary) => {
      broadcast('usage:tick', summary)
      updateTrayNow(() => trayText())
      const inserted = summary.agents.reduce((s, a) => s + a.inserted, 0)
      if (inserted > 0 || !firstTickLogged) {
        firstTickLogged = true
        console.log(
          `[agentmeter] tick ${summary.durationMs}ms: ` +
            summary.agents
              .map((a) => `${a.displayName} +${a.inserted}/${a.files}files${a.errors.length ? ` err=${a.errors.length}` : ''}`)
              .join(' · ')
        )
      }
    }
  })
  scheduler.start()
  console.log(`[agentmeter] 启动完成：db=${defaultDbPath(userDataDir)} 轮询=${Math.max(1000, config.pollIntervalMs)}ms`)

  registerDataIpc(userDataDir)
}

/** 为"自定义路径校验"按 Agent 造一次性适配器 */
function buildSingleAdapter(agent: AgentId, roots: string[]): SourceAdapter {
  switch (agent) {
    case 'claude-code':
      return new ClaudeCodeAdapter({ roots })
    case 'codex':
      return new CodexAdapter({ roots })
    case 'gemini-cli':
      return createGeminiAdapter(roots)
    case 'qwen':
      return createQwenAdapter(roots)
    case 'zcode':
      return new ZCodeAdapter({ dbPath: roots[0] ?? '' })
  }
}

function registerDataIpc(userDataDir: string): void {
  ipcMain.handle('app:version', () => app.getVersion())
  ipcMain.handle('app:platform', () => process.platform)
  ipcMain.handle('app:userDataDir', () => userDataDir)

  ipcMain.handle('probe:all', () => probeAll(buildAdapters({ roots: config.roots })))

  ipcMain.handle('data:overview', (_e, p: { from: number; to: number }) =>
    store.overview({ from: Number(p.from), to: Number(p.to) })
  )

  ipcMain.handle(
    'data:trend',
    (_e, p: { from: number; to: number; bucket: 'hour' | 'day'; byModel?: boolean }) => {
      const range = { from: Number(p.from), to: Number(p.to) }
      const bucket = p.bucket === 'hour' ? 'hour' : 'day'
      return p.byModel ? store.trendByModel(range, bucket) : store.trend(range, bucket)
    }
  )

  ipcMain.handle(
    'data:sessions',
    (_e, p: { limit?: number; offset?: number; from?: number; to?: number; agent?: string; model?: string }) =>
      store.sessions(
        Math.min(500, Number(p.limit) || 200),
        Number(p.offset) || 0,
        p.from != null && p.to != null ? { from: Number(p.from), to: Number(p.to) } : undefined,
        p.agent || p.model ? { agent: p.agent, model: p.model } : undefined
      )
  )

  ipcMain.handle('data:models', () => store.distinctModels())

  ipcMain.handle('data:active', () => store.activeSessions(60 * 60_000))

  ipcMain.handle('data:stats', () => ({
    eventCount: store.eventCount(),
    firstTs: store.firstTs(),
    lastTs: store.lastTs()
  }))

  ipcMain.handle('config:get', () => config)

  ipcMain.handle(
    'config:set',
    (
      _e,
      patch: {
        pollIntervalMs?: number
        priceOverrides?: PriceOverrides
        roots?: AgentMeterConfig['roots']
        onboarded?: boolean
      }
    ) => {
      if (typeof patch.pollIntervalMs === 'number') {
        config.pollIntervalMs = Math.max(1000, patch.pollIntervalMs)
      }
      if (patch.priceOverrides) {
        config.priceOverrides = patch.priceOverrides
        // 用户覆盖价格 → 立即重算历史，所见即所得
        const n = store.recomputeCosts(effectivePriceTable(config.priceOverrides))
        broadcast('usage:tick', { startedAt: Date.now(), durationMs: 0, agents: [], freshEvents: [] })
        console.log(`[agentmeter] 价格覆盖已保存，重算 ${n} 条事件`)
      }
      if (patch.roots) config.roots = patch.roots
      if (typeof patch.onboarded === 'boolean') config.onboarded = patch.onboarded
      saveConfig(userDataDir, config)
      return config
    }
  )

  ipcMain.handle('onboarding:complete', () => {
    config.onboarded = true
    saveConfig(userDataDir, config)
    return true
  })

  ipcMain.handle('root:validate', (_e, p: { agent: AgentId; path: string }): Promise<ProbeResult> =>
    probeRoot((root) => buildSingleAdapter(p.agent, [root]), String(p.path))
  )

  ipcMain.handle('prices:builtin', () => BUILTIN_PRICES)

  ipcMain.handle('shell:openPath', (_e, p: { path: string }) => {
    void shell.openPath(String(p.path))
    return true
  })

  // ---------- 活动看板 ----------
  ipcMain.handle('live:agents', () => collectLiveAgents(store))
  ipcMain.handle(
    'live:timeline',
    (_e, p: { agent: string; sessionId: string }) => store.sessionTimeline(p.agent, p.sessionId)
  )
  ipcMain.handle('live:showLog', (_e, p: { path: string }) => {
    void shell.showItemInFolder(String(p.path))
    return true
  })
  ipcMain.handle('live:copy', (_e, p: { text: string }) => {
    clipboard.writeText(String(p.text))
    return true
  })
}

/** 托盘文案：今日 token 总量（紧凑格式）+ 分 Agent tooltip */
function trayText(): { label: string; tooltip: string } {
  const now = new Date()
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const ov = store.overview({ from: todayStart, to: now.getTime() + 60_000 })
  const label = compactTokens(ov.totals.total)
  const lines = ov.byAgent
    .filter((a) => a.totals.total > 0)
    .map((a) => `${a.displayName}: ${compactTokens(a.totals.total)} tok · ≈$${a.totals.costEstUSD.toFixed(2)}`)
  const active = store.activeSessions(5 * 60_000, Date.now()).length
  const tooltip =
    `AgentMeter 今日 ${compactTokens(ov.totals.total)} tok · ≈$${ov.totals.costEstUSD.toFixed(2)}\n` +
    (lines.length > 0 ? `${lines.join('\n')}\n` : '') +
    (active > 0 ? `⚡ ${active} 个活动会话` : '空闲')
  return { label, tooltip }
}

export function compactTokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}G`
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`
  return `${n}`
}
