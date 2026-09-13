/** 多 Agent 协同 IM：类型契约（core 层，零 Electron 依赖） */

import type { AgentId } from '../model/types'

/** 推理强度档位（各 Agent 支持子集不同，'default' 表示用 Agent 默认） */
export type ReasoningLevel = 'default' | 'low' | 'medium' | 'high' | 'max'

/** 可参与协同的 Agent 信息（就绪探测结果，UI 用） */
export interface CollabAgentInfo {
  agentKind: AgentId
  name: string
  color: string
  ready: boolean
  reason?: string
}

/** 房间参与者：绑定一个受支持的 Agent（不可自定义命令） */
export interface Participant {
  id: string
  /** Agent 种类，同时也是监控源标识 */
  agentKind: AgentId
  /** 显示名（即 @ 名） */
  name: string
  color: string
  /** 覆盖模型（空 = Agent 默认模型） */
  model?: string
  /** 推理强度（default = 不传，用 Agent 默认） */
  reasoning?: ReasoningLevel
}

export type MessageStatus = 'running' | 'done' | 'error' | 'timeout'

export interface CollabMessage {
  id: string
  roomId: string
  ts: number
  /** 'user' 或 participant.id */
  author: string
  text: string
  /** 仅 Agent 消息有状态；用户消息恒视为完成 */
  status?: MessageStatus
  durationMs?: number
  /** 本次运行的 token / 成本（来自监控库按时间窗回查） */
  tokens?: number
  costEstUSD?: number
  /** 注入 prompt 的规模估算（tokens） */
  promptEst?: number
  error?: string
}

export interface CollabRoom {
  id: string
  name: string
  /** Agent 的执行工作目录 */
  workspace: string
  participants: Participant[]
  /** 单次运行超时（毫秒） */
  timeoutMs: number
  createdAt: number
}

export interface RunResult {
  stdout: string
  stderr: string
  code: number | null
  timedOut: boolean
  /** 从输出中捕获的原生 session id（可恢复） */
  sessionId?: string
}

/** 参与者颜色板（与趋势图分类色同族），按 AgentId 固定分配 */
export const AGENT_COLORS: Record<AgentId, string> = {
  'claude-code': '#f472b6',
  codex: '#60a5fa',
  'gemini-cli': '#34d399',
  'qwen': '#fbbf24',
  zcode: '#a78bfa'
}

export const AGENT_NAMES: Record<AgentId, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  'gemini-cli': 'Gemini CLI',
  'qwen': 'Qwen Code',
  zcode: 'ZCode'
}

/** 各 Agent 驱动能力（UI 提示用）：模型/推理强度是否支持 CLI 覆盖 */
export const AGENT_CAPS: Record<AgentId, { model: boolean; reasoning: boolean; note?: string }> = {
  codex: { model: true, reasoning: true },
  'claude-code': { model: true, reasoning: false },
  'gemini-cli': { model: true, reasoning: false },
  'qwen': { model: true, reasoning: false },
  zcode: {
    model: false,
    reasoning: false,
    note: 'ZCode headless 暂不支持命令行覆盖模型，使用其默认模型'
  }
}
