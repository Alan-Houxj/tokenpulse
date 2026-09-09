/** 多 Agent 协同 IM：类型契约（core 层，零 Electron 依赖） */

import type { AgentId } from '../model/types'

/** 房间参与者：一个绑定了可执行命令的 Agent 席位 */
export interface Participant {
  id: string
  name: string
  /** 用于成本回查的监控源（'codex' 等）；自定义命令无对应监控源用 'custom' */
  agentKind: AgentId | 'custom'
  /** 气泡/名字颜色（CSS 色值） */
  color: string
  /**
   * 执行命令模板。含 {prompt} 占位符时把完整输入文本替换进去（用户自担引号转义）；
   * 不含占位符时输入文本通过 stdin 管入（默认、推荐，规避跨 shell 转义）。
   */
  command: string
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
  /** 本次运行的 token / 成本（来自监控库按时间窗回查，custom 无） */
  tokens?: number
  costEstUSD?: number
  error?: string
}

export interface CollabRoom {
  id: string
  name: string
  /** Agent 的执行工作目录 */
  workspace: string
  participants: Participant[]
  /** @ 触发时附带最近 N 条消息作为上下文 */
  contextMessages: number
  /** 单次运行超时（毫秒） */
  timeoutMs: number
  createdAt: number
}

export interface RunResult {
  stdout: string
  stderr: string
  code: number | null
  timedOut: boolean
}

/** 参与者颜色板（与趋势图分类色同族） */
export const PARTICIPANT_COLORS = [
  '#60a5fa',
  '#34d399',
  '#a78bfa',
  '#fbbf24',
  '#22d3ee',
  '#f472b6'
]

/** 内置参与者预设（按本机 CLI 实测的 headless 调用方式） */
export const PARTICIPANT_PRESETS: Participant[] = [
  {
    id: 'preset-codex',
    name: 'Codex',
    agentKind: 'codex',
    color: '#60a5fa',
    // stdin 模式：- 读 stdin；workspace-write 允许写工作区；exec 本身非交互
    command: 'codex exec -s workspace-write --skip-git-repo-check -'
  },
  {
    id: 'preset-claude',
    name: 'Claude Code',
    agentKind: 'claude-code',
    color: '#f472b6',
    command: 'claude -p'
  },
  {
    id: 'preset-gemini',
    name: 'Gemini CLI',
    agentKind: 'gemini-cli',
    color: '#34d399',
    command: 'gemini --prompt "$(cat)"'
  }
]
