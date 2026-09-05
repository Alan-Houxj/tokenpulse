import { contextBridge, ipcRenderer } from 'electron'
import type {
  ActiveSessionRow,
  AgentId,
  LiveAgentCard,
  LiveTimelineItem,
  OverviewSummary,
  ProbeResult,
  SessionRow,
  TrendPoint,
  TrendPointByModel
} from '@core/model/types'
import type { TokenPulseConfig } from '@core/config'
import type { TickSummary } from '@core/engine/scheduler'
import type { PriceOverrides } from '@core/engine/cost'

/**
 * 渲染端可用的唯一 API 面。查询走 invoke（带参数校验的薄封装），
 * 订阅返回取消函数防止 React 反复挂载造成监听器泄漏。
 */
const api = {
  getVersion: (): Promise<string> => ipcRenderer.invoke('app:version'),
  getPlatform: (): Promise<string> => ipcRenderer.invoke('app:platform'),
  getUserDataDir: (): Promise<string> => ipcRenderer.invoke('app:userDataDir'),

  probeAll: (): Promise<ProbeResult[]> => ipcRenderer.invoke('probe:all'),
  validateRoot: (agent: AgentId, path: string): Promise<ProbeResult> =>
    ipcRenderer.invoke('root:validate', { agent, path }),

  getOverview: (from: number, to: number): Promise<OverviewSummary> =>
    ipcRenderer.invoke('data:overview', { from, to }),
  getTrend: (from: number, to: number, bucket: 'hour' | 'day'): Promise<TrendPoint[]> =>
    ipcRenderer.invoke('data:trend', { from, to, bucket }),
  getTrendByModel: (from: number, to: number, bucket: 'hour' | 'day'): Promise<TrendPointByModel[]> =>
    ipcRenderer.invoke('data:trend', { from, to, bucket, byModel: true }),
  getSessions: (
    limit = 200,
    offset = 0,
    range?: { from: number; to: number },
    filters?: { agent?: string; model?: string }
  ): Promise<SessionRow[]> =>
    ipcRenderer.invoke('data:sessions', {
      limit,
      offset,
      from: range?.from,
      to: range?.to,
      agent: filters?.agent,
      model: filters?.model
    }),
  getModels: (): Promise<string[]> => ipcRenderer.invoke('data:models'),
  getActiveSessions: (): Promise<ActiveSessionRow[]> => ipcRenderer.invoke('data:active'),
  getStats: (): Promise<{ eventCount: number; firstTs?: number; lastTs?: number }> =>
    ipcRenderer.invoke('data:stats'),

  getConfig: (): Promise<TokenPulseConfig> => ipcRenderer.invoke('config:get'),
  setConfig: (patch: {
    pollIntervalMs?: number
    priceOverrides?: PriceOverrides
    roots?: TokenPulseConfig['roots']
    onboarded?: boolean
  }): Promise<TokenPulseConfig> => ipcRenderer.invoke('config:set', patch),
  getBuiltinPrices: (): Promise<Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }>> =>
    ipcRenderer.invoke('prices:builtin'),
  completeOnboarding: (): Promise<boolean> => ipcRenderer.invoke('onboarding:complete'),
  openPath: (path: string): Promise<boolean> => ipcRenderer.invoke('shell:openPath', { path }),

  onTick: (callback: (summary: TickSummary) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, summary: TickSummary): void => callback(summary)
    ipcRenderer.on('usage:tick', listener)
    return () => ipcRenderer.removeListener('usage:tick', listener)
  },

  minimizeWindow: (): void => ipcRenderer.send('win:minimize'),
  hideWindow: (): void => ipcRenderer.send('win:hide'),

  getLiveAgents: (): Promise<LiveAgentCard[]> => ipcRenderer.invoke('live:agents'),
  getLiveTimeline: (agent: string, sessionId: string): Promise<LiveTimelineItem[]> =>
    ipcRenderer.invoke('live:timeline', { agent, sessionId }),
  showLogInFolder: (path: string): Promise<boolean> =>
    ipcRenderer.invoke('live:showLog', { path }),
  copyText: (text: string): Promise<boolean> => ipcRenderer.invoke('live:copy', { text })
}

export type TokenPulseApi = typeof api
contextBridge.exposeInMainWorld('api', api)
