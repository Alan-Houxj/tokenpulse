/**
 * Codex CLI/桌面版 适配器。
 * 数据：~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl
 *
 * 社区坑（已处理，共识见 cc-switch#3011 / ccusage#884）：
 * - token_usage_record.payload.usage 是「本响应」的用量 —— 唯一可信的增量来源
 * - event_msg(token_count) 的 total_token_usage 是累计值且非单调，绝不对它求和
 * - 模型名在 turn_context 行里，需要按序扫描文件维护当前模型状态
 */
import type { AgentId, DiscoveredFile, ReadResult, SourceAdapter, UsageEvent } from '../model/types'
import { dirExists, homePath, parseJsonLine, readLinesIncremental, walkFiles } from './util'

interface CodexUsage {
  input_tokens?: number
  cached_input_tokens?: number
  cache_write_input_tokens?: number
  output_tokens?: number
  reasoning_output_tokens?: number
}

interface CodexPayload {
  type?: string
  session_id?: string
  response_id?: string
  usage?: CodexUsage
  model?: string
  cwd?: string
}

interface CodexLine {
  timestamp?: string
  type?: string
  payload?: CodexPayload
}

export class CodexAdapter implements SourceAdapter {
  readonly id: AgentId = 'codex'
  readonly displayName = 'Codex'
  private readonly rootCandidates: string[]

  constructor(opts: { roots?: string[] | string } = {}) {
    // 防御：误传单个字符串时包裹成数组（字符串有 length，直接用会被逐字符迭代）
    const roots = typeof opts.roots === 'string' ? [opts.roots] : opts.roots
    this.rootCandidates = roots?.length ? roots : [homePath('.codex')]
  }

  defaultRoots(): string[] {
    return this.rootCandidates
  }

  discover(): DiscoveredFile[] {
    const files: DiscoveredFile[] = []
    for (const root of this.rootCandidates) {
      const sessionsDir = dirExists(joinDir(root, 'sessions')) ? joinDir(root, 'sessions') : root
      files.push(...walkFiles(sessionsDir, (n) => n.startsWith('rollout-') && n.endsWith('.jsonl')))
    }
    const seen = new Map<string, DiscoveredFile>()
    for (const f of files) seen.set(f.path, f)
    return [...seen.values()]
  }

  async readIncremental(file: DiscoveredFile, fromOffset: number, state?: unknown): Promise<ReadResult> {
    const { lines, endOffset } = readLinesIncremental(file.path, fromOffset)
    const events: UsageEvent[] = []
    // 恢复上次读取结束时的行内状态（模型名只写在文件头的 turn_context 里，
    // 跨增量段必须持久化，否则新段里的用量记录会丢模型回退成 unknown）
    const st = (state ?? {}) as { model?: string; cwd?: string; sessionId?: string }
    let currentModel = st.model ?? 'unknown'
    let currentCwd = st.cwd
    let sessionId = st.sessionId

    for (const line of lines) {
      const raw = parseJsonLine<CodexLine>(line)
      if (!raw?.type || !raw.payload) continue

      const ts = raw.timestamp ? Date.parse(raw.timestamp) : 0

      if (raw.type === 'turn_context') {
        if (raw.payload.model) currentModel = raw.payload.model
        if (raw.payload.cwd) currentCwd = raw.payload.cwd
      } else if (raw.type === 'session_meta') {
        sessionId = raw.payload.session_id ?? sessionId
        if (raw.payload.cwd) currentCwd = raw.payload.cwd
      } else if (raw.type === 'token_usage_record') {
        const u = raw.payload.usage
        if (!u || !raw.payload.response_id) continue
        const sid = raw.payload.session_id ?? sessionId ?? 'unknown-session'
        // OpenAI 口径：input_tokens 含 cached；output_tokens 含 reasoning → 归一化拆开
        const cached = Math.max(0, u.cached_input_tokens ?? 0)
        const input = Math.max(0, (u.input_tokens ?? 0) - cached)
        const reasoning = Math.max(0, u.reasoning_output_tokens ?? 0)
        const output = Math.max(0, (u.output_tokens ?? 0) - reasoning)
        events.push({
          id: `codex:${sid}:${raw.payload.response_id}`,
          ts,
          agent: 'codex',
          sessionId: sid,
          model: currentModel,
          tokens: {
            input,
            output,
            reasoning,
            cacheRead: cached,
            cacheWrite: Math.max(0, u.cache_write_input_tokens ?? 0)
          },
          costUSD: undefined,
          costEstUSD: 0,
          projectPath: currentCwd
        })
      }
      // event_msg(token_count)：仅 UI 刷新用途，累计值不可信，跳过（V1.1 的 rate_limits 另取）
    }

    return {
      events,
      endOffset,
      state: { model: currentModel, cwd: currentCwd, sessionId }
    }
  }
}

function joinDir(a: string, b: string): string {
  return `${a.replace(/[\\/]+$/, '')}/${b}`
}
