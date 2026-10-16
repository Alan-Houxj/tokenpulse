/** 适配器注册表：采集与自定义路径校验共用同一组工厂。 */
import type { AgentId, SourceAdapter } from '../model/types'
import { ClaudeCodeAdapter } from './claude-code'
import { CodexAdapter } from './codex'
import { createGeminiAdapter, createQwenAdapter } from './gemini-like'
import { ZCodeAdapter } from './zcode'
import { DshAdapter } from './dsh'
import { ClaudeDesktopAdapter } from './claude-desktop'
import { KimiCodeAdapter, KimiDesktopAdapter } from './kimi'

export interface AdapterOverrides {
  /** 非空自定义数据根替代该 Agent 的默认根。 */
  roots?: Partial<Record<AgentId, string[]>>
}

export function buildAdapter(agent: AgentId, roots?: string[]): SourceAdapter {
  switch (agent) {
    case 'claude-code': return new ClaudeCodeAdapter({ roots })
    case 'codex': return new CodexAdapter({ roots })
    case 'gemini-cli': return createGeminiAdapter(roots)
    case 'qwen': return createQwenAdapter(roots)
    case 'zcode': return new ZCodeAdapter()
    case 'dsh': return new DshAdapter({ roots })
    case 'claude-desktop': return new ClaudeDesktopAdapter({ roots })
    case 'kimi-desktop': return new KimiDesktopAdapter({ roots })
    case 'kimi-code': return new KimiCodeAdapter({ roots })
    default: throw new Error(`不支持的数据源：${String(agent)}`)
  }
}

export function buildAdapters(overrides: AdapterOverrides = {}): SourceAdapter[] {
  // Desktop-owned transcripts take precedence if an explicit CLI root also contains a mirror.
  const agents: AgentId[] = [
    'claude-desktop', 'claude-code', 'codex', 'gemini-cli', 'qwen', 'zcode',
    'dsh', 'kimi-desktop', 'kimi-code'
  ]
  return agents.map((agent) => buildAdapter(agent, overrides.roots?.[agent]))
}
