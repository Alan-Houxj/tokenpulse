/** Codex local rollout logs: plain JSONL and Zstandard-compressed JSONL share accounting IDs. */
import { closeSync, openSync, readSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentId, DiscoveredFile, ProbeResult, ReadResult, SourceAdapter, UsageEvent } from '../model/types'
import { dirExists, homePath, normalizePathKey, parseJsonLine, readLinesIncremental, walkFiles } from './util'
import { scanCodexLog } from './codex-log'
import { probeRecordedUsage } from './probe-util'

interface CodexUsage {
  input_tokens?: number
  cached_input_tokens?: number
  cache_write_input_tokens?: number
  output_tokens?: number
  reasoning_output_tokens?: number
}

interface CodexPayload {
  type?: string
  id?: string
  session_id?: string
  response_id?: string
  usage?: CodexUsage
  model?: string
  cwd?: string
  info?: {
    total_token_usage?: CodexUsage
    last_token_usage?: CodexUsage
  }
}

interface CodexLine {
  timestamp?: string
  type?: string
  payload?: CodexPayload
}

interface ParserState {
  model?: string
  cwd?: string
  sessionId?: string
}

interface CompressedCursor {
  version: 1
  offset: number
  fingerprint: string
  identity: string
}

interface CodexState extends ParserState {
  compressed?: CompressedCursor
}

export interface CodexLogTail {
  lines: string[]
  sessionId?: string
  model?: string
  cwd?: string
}

const TAIL_BYTES = 64 * 1024
const TAIL_CACHE_LIMIT = 12
const tailCache = new Map<string, { signature: string; tail: CodexLogTail }>()

function defaultRoots(): string[] {
  return [process.env.CODEX_HOME?.trim() || homePath('.codex')]
}

export function discoverCodexLogs(roots: string[] = defaultRoots()): DiscoveredFile[] {
  const files = new Map<string, DiscoveredFile>()
  for (const root of roots) {
    const sessions = dirExists(join(root, 'sessions')) ? join(root, 'sessions') : root
    for (const file of walkFiles(sessions, (name) => name.startsWith('rollout-') &&
      (name.endsWith('.jsonl') || name.endsWith('.jsonl.zst')))) {
      files.set(file.path, file)
    }
  }
  return [...files.values()]
}

function compressed(path: string): boolean {
  return path.endsWith('.jsonl.zst')
}

function signature(path: string): string {
  const st = statSync(path)
  return `${st.dev}:${st.ino}:${st.birthtimeMs}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`
}

function cacheTail(path: string, version: string, tail: CodexLogTail): void {
  const key = normalizePathKey(path)
  tailCache.delete(key)
  tailCache.set(key, { signature: version, tail })
  if (tailCache.size > TAIL_CACHE_LIMIT) tailCache.delete(tailCache.keys().next().value!)
}

function stateOf(value: unknown): CodexState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const raw = value as Partial<CodexState>
  return {
    model: typeof raw.model === 'string' ? raw.model : undefined,
    cwd: typeof raw.cwd === 'string' ? raw.cwd : undefined,
    sessionId: typeof raw.sessionId === 'string' ? raw.sessionId : undefined,
    compressed: raw.compressed
  }
}

function contextOf(raw: CodexLine, state: ParserState): void {
  const payload = raw.payload
  if (!payload) return
  if (raw.type === 'turn_context') {
    if (typeof payload.model === 'string' && payload.model) state.model = payload.model
    if (typeof payload.cwd === 'string' && payload.cwd) state.cwd = payload.cwd
  } else if (raw.type === 'session_meta') {
    // session_id is the historical accounting identity; payload.id can identify a different thread.
    if (typeof payload.session_id === 'string' && payload.session_id) state.sessionId = payload.session_id
    if (typeof payload.cwd === 'string' && payload.cwd) state.cwd = payload.cwd
  }
}

function parseUsage(raw: CodexLine, state: ParserState): UsageEvent | undefined {
  const payload = raw.payload
  if (!payload) return undefined
  const ts = raw.timestamp ? Date.parse(raw.timestamp) : 0
  if (raw.type === 'token_usage_record') {
    const usage = payload.usage
    if (!usage || !payload.response_id) return undefined
    const sid = payload.session_id ?? state.sessionId ?? 'unknown-session'
    const cached = Math.max(0, usage.cached_input_tokens ?? 0)
    const reasoning = Math.max(0, usage.reasoning_output_tokens ?? 0)
    return {
      id: `codex:${sid}:${payload.response_id}`,
      ts, agent: 'codex', sessionId: sid, model: state.model ?? 'unknown',
      tokens: {
        input: Math.max(0, (usage.input_tokens ?? 0) - cached),
        output: Math.max(0, (usage.output_tokens ?? 0) - reasoning),
        reasoning,
        cacheRead: cached,
        cacheWrite: Math.max(0, usage.cache_write_input_tokens ?? 0)
      },
      costUSD: undefined, costEstUSD: 0, projectPath: state.cwd
    }
  }
  if (raw.type === 'event_msg' && payload.type === 'token_count') {
    const last = payload.info?.last_token_usage
    const total = payload.info?.total_token_usage
    if (!last || !total) return undefined
    const sid = state.sessionId ?? 'unknown-session'
    const cached = Math.max(0, last.cached_input_tokens ?? 0)
    const reasoning = Math.max(0, last.reasoning_output_tokens ?? 0)
    return {
      // Preserve prior cumulative-fingerprint keys when a plain log becomes compressed.
      id: `codex:${sid}:tc:${total.input_tokens ?? 0}-${total.output_tokens ?? 0}`,
      ts, agent: 'codex', sessionId: sid, model: state.model ?? 'unknown',
      tokens: {
        input: Math.max(0, (last.input_tokens ?? 0) - cached),
        output: Math.max(0, (last.output_tokens ?? 0) - reasoning),
        reasoning,
        cacheRead: cached,
        cacheWrite: Math.max(0, last.cache_write_input_tokens ?? 0)
      },
      costUSD: undefined, costEstUSD: 0, projectPath: state.cwd
    }
  }
  return undefined
}

function isRecognized(raw: CodexLine): boolean {
  return !!raw.payload && ['session_meta', 'turn_context', 'token_usage_record', 'event_msg', 'response_item'].includes(raw.type ?? '')
}

function tailMetadata(lines: string[], initial: ParserState = {}): ParserState {
  const state = { ...initial }
  for (const line of lines) {
    const raw = parseJsonLine<CodexLine>(line)
    if (!raw) continue
    contextOf(raw, state)
    if (raw.type === 'session_meta' && !state.sessionId && typeof raw.payload?.id === 'string') {
      state.sessionId = raw.payload.id
    }
  }
  return state
}

/** Cache only a bounded decoded tail; immutable archives need not be decompressed on every live poll. */
export async function readCodexLogTail(file: DiscoveredFile): Promise<CodexLogTail> {
  const version = signature(file.path)
  const key = normalizePathKey(file.path)
  const cached = tailCache.get(key)
  if (cached?.signature === version) return cached.tail
  if (!compressed(file.path)) {
    const size = statSync(file.path).size
    const fd = openSync(file.path, 'r')
    let prefix: string[]
    try {
      const bytes = Buffer.alloc(Math.min(size, TAIL_BYTES))
      const n = readSync(fd, bytes, 0, bytes.length, 0)
      const end = bytes.subarray(0, n).lastIndexOf(10)
      prefix = end < 0 ? [] : bytes.subarray(0, end).toString('utf8').split('\n')
    } finally { closeSync(fd) }
    const { lines } = readLinesIncremental(file.path, Math.max(0, size - TAIL_BYTES))
    const state = tailMetadata(lines, tailMetadata(prefix))
    if (signature(file.path) !== version) throw new Error('Codex 日志正在变化，请稍后重试')
    const tail = { lines, ...state }
    cacheTail(file.path, version, tail)
    return tail
  }
  const context: ParserState = {}
  let nativeId: string | undefined
  const result = await scanCodexLog(file, (line) => {
    const raw = parseJsonLine<CodexLine>(line)
    if (!raw) return
    contextOf(raw, context)
    if (raw.type === 'session_meta' && typeof raw.payload?.id === 'string') nativeId = raw.payload.id
  })
  const tail = { lines: result.tailLines, ...context, sessionId: context.sessionId ?? nativeId }
  cacheTail(file.path, version, tail)
  return tail
}

export class CodexAdapter implements SourceAdapter {
  readonly id: AgentId = 'codex'
  readonly displayName = 'Codex'
  private readonly rootCandidates: string[]

  constructor(opts: { roots?: string[] | string } = {}) {
    const roots = typeof opts.roots === 'string' ? [opts.roots] : opts.roots
    this.rootCandidates = roots?.length ? [...roots] : defaultRoots()
  }

  defaultRoots(): string[] { return [...this.rootCandidates] }
  discover(): DiscoveredFile[] { return discoverCodexLogs(this.rootCandidates) }

  probe(): Promise<ProbeResult> {
    return probeRecordedUsage(this, {
      coverage: '支持 Codex 普通 JSONL 与 Zstandard 压缩记录',
      emptyDetail: '未发现 Codex rollout 用量记录（支持 .jsonl / .jsonl.zst）',
      noUsageDetail: '已识别 Codex 记录，目前尚无可统计的用量事件'
    })
  }

  async readIncremental(file: DiscoveredFile, fromOffset: number, saved?: unknown): Promise<ReadResult> {
    if (!compressed(file.path)) {
      const size = statSync(file.path).size
      const reset = size < fromOffset
      const state: ParserState = reset ? {} : stateOf(saved)
      const { lines, endOffset } = readLinesIncremental(file.path, reset ? 0 : fromOffset)
      const events: UsageEvent[] = []
      let recognized = false
      for (const line of lines) {
        const raw = parseJsonLine<CodexLine>(line)
        if (!raw) continue
        recognized ||= isRecognized(raw)
        contextOf(raw, state)
        const event = parseUsage(raw, state)
        if (event) events.push(event)
      }
      return {
        events, endOffset, recognized,
        state: { model: state.model ?? 'unknown', cwd: state.cwd, sessionId: state.sessionId }
      }
    }

    const version = signature(file.path)
    const previous = stateOf(saved).compressed
    const verify = previous?.version === 1 && previous.offset === fromOffset &&
      Number.isSafeInteger(fromOffset) && fromOffset >= 0 ? fromOffset : undefined
    const context: ParserState = {}
    let nativeId: string | undefined
    let recognized = false
    const collected: { event: UsageEvent; end: number }[] = []
    const result = await scanCodexLog(file, (line, end) => {
      const raw = parseJsonLine<CodexLine>(line)
      if (!raw) return
      recognized ||= isRecognized(raw)
      contextOf(raw, context)
      if (raw.type === 'session_meta' && typeof raw.payload?.id === 'string') nativeId = raw.payload.id
      const event = parseUsage(raw, context)
      if (event) collected.push({ event, end })
    }, verify)
    const canResume = verify !== undefined && result.previousFingerprint === previous?.fingerprint &&
      result.identity === previous?.identity
    const events = collected.filter((item) => !canResume || item.end > fromOffset).map((item) => item.event)
    cacheTail(file.path, version, {
      lines: result.tailLines, ...context, sessionId: context.sessionId ?? nativeId
    })
    return {
      events, endOffset: result.endOffset, recognized,
      state: {
        model: context.model ?? 'unknown', cwd: context.cwd, sessionId: context.sessionId,
        compressed: {
          version: 1, offset: result.endOffset, fingerprint: result.fingerprint, identity: result.identity
        } satisfies CompressedCursor
      } satisfies CodexState
    }
  }
}
