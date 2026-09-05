/**
 * 适配器注册表：新增 Agent 只需要实现 SourceAdapter 并在这里注册一行。
 */
import type { AgentId, SourceAdapter } from '../model/types'
import { ClaudeCodeAdapter } from './claude-code'
import { CodexAdapter } from './codex'
import { createGeminiAdapter, createQwenAdapter } from './gemini-like'
import { ZCodeAdapter } from './zcode'

export interface AdapterOverrides {
  /** 用户自定义数据根（设置页"自定义路径"），追加到默认根之后 */
  roots?: Partial<Record<AgentId, string[]>>
}

export function buildAdapters(overrides: AdapterOverrides = {}): SourceAdapter[] {
  return [
    new ClaudeCodeAdapter({ roots: overrides.roots?.['claude-code'] }),
    new CodexAdapter({ roots: overrides.roots?.codex }),
    createGeminiAdapter(overrides.roots?.['gemini-cli']),
    createQwenAdapter(overrides.roots?.qwen),
    new ZCodeAdapter()
  ]
}
