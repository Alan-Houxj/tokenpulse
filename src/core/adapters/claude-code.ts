/**
 * Claude Code 适配器（Qwen Code 复用同款解析器，仅换数据根）。
 * 数据：~/.claude/projects/<编码后的项目路径>/<sessionId>.jsonl
 * 每行一个事件；只有 type=assistant 且 message.usage 存在的行携带用量。
 *
 * 社区坑（已处理）：
 * - 同一 usage 会随重试/SSE 分片出现在多行 → 以 requestId（缺省 message.id）为幂等键
 * - 部分行 output_tokens 是占位小值 → 去重后影响可控，照常入库
 */
import type { DiscoveredFile, ReadResult, SourceAdapter, UsageEvent, AgentId } from '../model/types'
import {
  dirExists,
  homePath,
  normalizePathKey,
  parseJsonLine,
  readLinesIncremental,
  walkFiles
} from './util'

interface ClaudeUsage {
  input_tokens?: number
  output_tokens?: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
}

interface ClaudeLine {
  type?: string
  timestamp?: string
  sessionId?: string
  requestId?: string
  cwd?: string
  costUSD?: number
  durationMs?: number
  message?: {
    id?: string
    model?: string
    usage?: ClaudeUsage
  }
}

function parseClaudeLine(agent: AgentId, line: string, fallbackCwd?: string): UsageEvent | undefined {
  const raw = parseJsonLine<ClaudeLine>(line)
  if (!raw || raw.type !== 'assistant' || !raw.message?.usage) return undefined

  const sessionId = raw.sessionId ?? 'unknown-session'
  const requestId = raw.requestId ?? raw.message.id
  if (!requestId) return undefined // 没有任何稳定键，无法幂等

  const u = raw.message.usage
  // Anthropic 口径：input_tokens 不含 cache 部分，与我们的归一化口径一致
  const tokens = {
    input: Math.max(0, u.input_tokens ?? 0),
    output: Math.max(0, u.output_tokens ?? 0),
    reasoning: 0,
    cacheRead: Math.max(0, u.cache_read_input_tokens ?? 0),
    cacheWrite: Math.max(0, u.cache_creation_input_tokens ?? 0)
  }

  return {
    id: `${agent}:${sessionId}:${requestId}`,
    ts: raw.timestamp ? Date.parse(raw.timestamp) : 0,
    agent,
    sessionId,
    model: raw.message.model ?? 'unknown',
    tokens,
    costUSD: typeof raw.costUSD === 'number' ? raw.costUSD : undefined,
    costEstUSD: 0, // 由成本引擎回填
    durationMs: raw.durationMs,
    projectPath: raw.cwd ?? fallbackCwd
  }
}

export class ClaudeCodeAdapter implements SourceAdapter {
  readonly id: AgentId
  readonly displayName: string
  private readonly rootCandidates: string[]

  constructor(opts: { id?: AgentId; displayName?: string; roots?: string[] | string } = {}) {
    this.id = opts.id ?? 'claude-code'
    this.displayName = opts.displayName ?? 'Claude Code'
    // 防御：误传单个字符串时包裹成数组（字符串有 length，直接用会被逐字符迭代）
    const roots = typeof opts.roots === 'string' ? [opts.roots] : opts.roots
    this.rootCandidates = roots?.length ? roots : [homePath('.claude')]
  }

  defaultRoots(): string[] {
    return this.rootCandidates
  }

  discover(): DiscoveredFile[] {
    const files: DiscoveredFile[] = []
    for (const root of this.rootCandidates) {
      // 会话在 <root>/projects 下；兼容直接把根指到 projects 本身的情况
      const projectsDir = dirExists(joinSafe(root, 'projects')) ? joinSafe(root, 'projects') : root
      files.push(...walkFiles(projectsDir, (n) => n.endsWith('.jsonl')))
    }
    // 同一文件可能被多个根重复发现，按键去重
    const seen = new Map<string, DiscoveredFile>()
    for (const f of files) seen.set(normalizePathKey(f.path), f)
    return [...seen.values()]
  }

  async readIncremental(file: DiscoveredFile, fromOffset: number): Promise<ReadResult> {
    const { lines, endOffset } = readLinesIncremental(file.path, fromOffset)
    const events: UsageEvent[] = []
    for (const line of lines) {
      const e = parseClaudeLine(this.id, line)
      if (e) events.push(e)
    }
    return { events, endOffset }
  }
}

function joinSafe(a: string, b: string): string {
  return normalizePathKey(`${a.replace(/[\\/]+$/, '')}/${b}`)
}
