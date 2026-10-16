import { createHash } from 'node:crypto'
import { closeSync, fstatSync, openSync, readFileSync, readdirSync, readSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import type { DiscoveredFile, ProbeResult, ReadResult, SourceAdapter, TokenBreakdown, UsageEvent } from '../model/types'
import { appDataPath } from './paths'
import { probeRecordedUsage } from './probe-util'
import { dirExists, normalizePathKey, statFile } from './util'

type KimiId = 'kimi-code' | 'kimi-desktop'
type JsonObject = Record<string, unknown>
interface KimiOptions { roots?: string[] | string }
interface RequestContext {
  model?: string
  alias?: string
  provider?: string
  kind?: string
  time?: number
  turnStep?: string
  attempt?: string
}
interface AgentContext {
  step?: string
  request?: RequestContext
  cwd?: string
}
interface Cursor {
  version: 1
  offset: number
  fileId: string
  size: number
  mtimeMs: number
  prefix: string
  boundary: string
  headerSeen: boolean
  protocol?: '1.4' | '1.5'
  invalid: boolean
  createdAt?: number
  forkSeen: boolean
  agents: Record<string, AgentContext>
}
interface SessionInfo {
  sessionId: string
  agentId: string
  owner?: KimiId
  projectPath?: string
  forkedFrom?: string
}

const GUARD_BYTES = 4096
const READ_BYTES = 64 * 1024
const MAX_LINE_BYTES = 4 * 1024 * 1024
const READ_FAILURE = '暂时无法读取 Kimi 记录，将重试'
const LINE_TOO_LARGE = 'Kimi 记录单行过大，已暂停读取'

function object(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : undefined
}
function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}
function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}
function digest(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}
function parse(line: string): JsonObject | undefined {
  try { return object(JSON.parse(line)) } catch { return undefined }
}
function directories(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => join(path, entry.name))
  } catch { return [] }
}
function sessionInfo(path: string): SessionInfo | undefined {
  const agentDir = dirname(path)
  const agentsDir = dirname(agentDir)
  const sessionDir = dirname(agentsDir)
  const sessionsDir = dirname(dirname(sessionDir))
  if (basename(path) !== 'wire.jsonl' || basename(agentsDir) !== 'agents' || basename(sessionsDir) !== 'sessions') return undefined
  let state: JsonObject | undefined
  try { state = parse(readFileSync(join(sessionDir, 'state.json'), 'utf8')) } catch { /* Metadata is optional. */ }
  const custom = object(state?.custom)
  const home = dirname(sessionsDir).replace(/\\/g, '/')
  const desktop = custom?.owner === 'daimon' || custom?.createdBy === 'daimon-kernel-adapter' ||
    /\/kimi-desktop\/daimon-share\/daimon\/runtime\/kimi-code\/home$/i.test(home)
  const code = basename(home) === '.kimi-code' || object(custom?.vscode_legacy_approval) !== undefined
  return {
    sessionId: basename(sessionDir),
    agentId: basename(agentDir),
    owner: desktop ? 'kimi-desktop' : code ? 'kimi-code' : undefined,
    projectPath: text(custom?.workspacePath) ?? text(state?.cwd) ?? text(state?.workDir),
    forkedFrom: text(state?.forkedFrom)
  }
}
function requestContext(record: JsonObject): RequestContext {
  return {
    model: text(record.model), alias: text(record.modelAlias), provider: text(record.provider),
    kind: text(record.kind), time: count(record.time), turnStep: text(record.turnStep), attempt: text(record.attempt)
  }
}
function tokens(value: unknown): TokenBreakdown | undefined {
  const usage = object(value)
  if (!usage) return undefined
  const input = count(usage.inputOther)
  const output = count(usage.output)
  const cacheRead = count(usage.inputCacheRead)
  const cacheWrite = count(usage.inputCacheCreation)
  if (input === undefined || output === undefined || cacheRead === undefined || cacheWrite === undefined) return undefined
  // v1.5 substitutes emptyUsage() when a provider supplies no accounting.
  if (input === 0 && output === 0 && cacheRead === 0 && cacheWrite === 0) return undefined
  return { input, output, reasoning: 0, cacheRead, cacheWrite }
}
function freshCursor(): Cursor {
  return {
    version: 1, offset: 0, fileId: '', size: 0, mtimeMs: 0, prefix: '', boundary: '',
    headerSeen: false, invalid: false, forkSeen: false, agents: Object.create(null) as Record<string, AgentContext>
  }
}
function restoreCursor(value: unknown): Cursor | undefined {
  const raw = object(value)
  if (raw?.version !== 1 || count(raw.offset) === undefined || typeof raw.fileId !== 'string' ||
      count(raw.size) === undefined || typeof raw.mtimeMs !== 'number' || typeof raw.prefix !== 'string' ||
      typeof raw.boundary !== 'string' || typeof raw.headerSeen !== 'boolean' || typeof raw.invalid !== 'boolean') return undefined
  const state = freshCursor()
  Object.assign(state, {
    offset: raw.offset, fileId: raw.fileId, size: raw.size, mtimeMs: raw.mtimeMs,
    prefix: raw.prefix, boundary: raw.boundary, headerSeen: raw.headerSeen, invalid: raw.invalid,
    protocol: raw.protocol === '1.4' || raw.protocol === '1.5' ? raw.protocol : undefined,
    createdAt: count(raw.createdAt), forkSeen: raw.forkSeen === true
  })
  for (const [id, value] of Object.entries(object(raw.agents) ?? {})) {
    const entry = object(value)
    if (!entry) continue
    const request = object(entry.request)
    state.agents[id] = {
      step: text(entry.step), cwd: text(entry.cwd),
      request: request ? {
        model: text(request.model), alias: text(request.alias), provider: text(request.provider),
        kind: text(request.kind), time: count(request.time), turnStep: text(request.turnStep), attempt: text(request.attempt)
      } : undefined
    }
  }
  return state
}
function readRange(fd: number, offset: number, length: number): Buffer {
  const buffer = Buffer.alloc(length)
  let read = 0
  while (read < length) {
    const n = readSync(fd, buffer, read, length - read, offset + read)
    if (n === 0) break
    read += n
  }
  return buffer.subarray(0, read)
}
function guards(fd: number, offset: number): { prefix: string; boundary: string } {
  const length = Math.min(offset, GUARD_BYTES)
  return { prefix: digest(readRange(fd, 0, length)), boundary: digest(readRange(fd, offset - length, length)) }
}

abstract class KimiAdapter implements SourceAdapter {
  abstract readonly id: KimiId
  abstract readonly displayName: string
  private readonly roots: string[]

  constructor(opts: KimiOptions, defaults: string[]) {
    const roots = typeof opts.roots === 'string' ? [opts.roots] : opts.roots
    this.roots = roots?.length ? [...roots] : defaults
  }

  defaultRoots(): string[] { return [...this.roots] }

  discover(): DiscoveredFile[] {
    const found = new Map<string, DiscoveredFile>()
    for (const root of this.roots) {
      const sessions = basename(root) === 'sessions' ? root : join(root, 'sessions')
      // Only the verified layout is searched; no caches, telemetry, or credential trees.
      for (const workspace of directories(sessions)) {
        for (const session of directories(workspace)) {
          for (const agent of directories(join(session, 'agents'))) {
            const path = join(agent, 'wire.jsonl')
            const info = sessionInfo(path)
            if (!info || (info.owner && info.owner !== this.id)) continue
            const file = statFile(path)
            if (!file) continue
            try {
              const canonical = normalizePathKey(realpathSync(path))
              const key = process.platform === 'win32' ? canonical.toLowerCase() : canonical
              found.set(key, { ...file, path: canonical })
            } catch { /* A session can disappear during discovery. */ }
          }
        }
      }
    }
    return [...found.values()]
  }

  probe(): Promise<ProbeResult> {
    return probeRecordedUsage(this, {
      coverage: this.id === 'kimi-desktop'
        ? '仅统计本地任务，不含云端聊天'
        : '统计 Kimi Code 已记录用量，多个编辑器共享记录时只计一次',
      emptyDetail: this.id === 'kimi-desktop' ? '尚无本地任务用量，云端聊天暂不支持' : '尚未发现 Kimi 用量记录',
      noUsageDetail: '已识别 Kimi 记录，但没有可用用量，不计为零消耗',
      unavailableWithoutFiles: this.id === 'kimi-desktop'
    })
  }

  async readIncremental(file: DiscoveredFile, fromOffset: number, saved?: unknown): Promise<ReadResult> {
    const info = sessionInfo(file.path)
    if (!info) return { events: [], endOffset: fromOffset, recognized: false }
    let fd: number
    try { fd = openSync(file.path, 'r') } catch { throw new Error(READ_FAILURE) }
    try {
      const before = fstatSync(fd)
      if (!before.isFile()) throw new Error(READ_FAILURE)
      const fileId = `${before.dev}:${before.ino}:${before.birthtimeMs}`
      const initialPrefixLength = Math.min(before.size, GUARD_BYTES)
      const initialPrefix = digest(readRange(fd, 0, initialPrefixLength))
      const previous = restoreCursor(saved)
      const offset = count(fromOffset) ?? 0
      const fingerprint = offset <= before.size ? guards(fd, offset) : undefined
      const resume = offset > 0 && previous?.offset === offset && previous.fileId === fileId &&
        fingerprint?.prefix === previous.prefix && fingerprint?.boundary === previous.boundary &&
        !(before.size <= previous.size && before.mtimeMs !== previous.mtimeMs)
      const state = resume ? previous : freshCursor()
      let position = resume ? offset : 0
      // A lost cursor can be rebuilt from the prefix without emitting old accounting again.
      const recoverPrefix = saved === undefined && offset > 0 && offset <= before.size && readRange(fd, offset - 1, 1)[0] === 10
      const emitAfter = resume || recoverPrefix ? offset : 0
      const events: UsageEvent[] = []
      let carry = Buffer.alloc(0)
      let committed = position
      const allowed = !info.owner || info.owner === this.id

      const consume = (line: string, lineEnd: number): void => {
        if (!line.trim()) return
        const record = parse(line)
        if (!state.headerSeen) {
          state.headerSeen = true
          if (record?.type !== 'metadata' || (record.protocol_version !== '1.4' && record.protocol_version !== '1.5')) {
            state.invalid = true
            return
          }
          state.protocol = record.protocol_version
          state.createdAt = count(record.created_at)
          return
        }
        if (state.invalid || !record) return
        if (record.type === 'metadata') {
          // A concatenated or upgraded journal must be replayed as a coherent file.
          if (record.protocol_version !== state.protocol) state.invalid = true
          return
        }
        if (record.type === 'forked') {
          state.forkSeen = true
          state.agents = Object.create(null) as Record<string, AgentContext>
          return
        }
        const actor = text(record.agentId) ?? info.agentId
        const context = state.agents[actor] ??= {}
        if (record.type === 'llm.request') {
          context.request = requestContext(record)
          return
        }
        if (record.type === 'config.update' || record.type === 'profile.bind') {
          const cwd = text(record.cwd) ?? text(object(record.environmentDisclosure)?.cwd)
          if (cwd) context.cwd = cwd
          return
        }
        if (record.type === 'agent.turn.started' || record.type === 'turn.prompt') {
          context.step = undefined
          context.request = undefined
          return
        }
        if (record.type === 'context.append_loop_event') {
          const event = object(record.event)
          if (event?.type === 'step.begin') {
            context.step = text(event.uuid)
            context.request = undefined
          } else if (event?.type === 'step.end' && !context.step) context.step = text(event.uuid)
          return
        }
        if (record.type !== 'usage.record' || !allowed || lineEnd <= emitAfter) return
        const usage = tokens(record.usage)
        const ts = count(record.time)
        const alias = text(record.model)
        if (!usage || ts === undefined || !alias) return
        if (record.usageScope !== undefined && record.usageScope !== 'turn' && record.usageScope !== 'session') return
        const scope = record.usageScope ?? 'session'
        const request = context.request?.alias === alias ? context.request : undefined
        const model = request?.model ?? alias
        const step = scope === 'turn' ? context.step : undefined
        // No path, adapter id, or destination session id: forks and copied roots share accounting.
        // The accounting timestamp/counters distinguish repeated calls within one step or retry.
        const identity = [
          step ?? [state.createdAt ?? null, actor], ts, alias, scope,
          usage.input, usage.output, usage.cacheRead, usage.cacheWrite,
          request ? [request.time, request.kind, request.turnStep, request.attempt] : null
        ]
        events.push({
          id: `kimi:${digest(JSON.stringify(identity))}`,
          ts, agent: this.id,
          sessionId: info.forkedFrom && !state.forkSeen ? info.forkedFrom : info.sessionId,
          model, tokens: usage, costEstUSD: 0,
          projectPath: info.projectPath ?? context.cwd
        })
      }

      while (position < before.size) {
        const chunk = readRange(fd, position, Math.min(READ_BYTES, before.size - position))
        if (chunk.length === 0) break
        const base = position - carry.length
        const buffer = carry.length ? Buffer.concat([carry, chunk]) : chunk
        position += chunk.length
        let start = 0
        let newline = buffer.indexOf(10, start)
        while (newline !== -1) {
          if (newline - start > MAX_LINE_BYTES) throw new Error(LINE_TOO_LARGE)
          committed = base + newline + 1
          consume(buffer.subarray(start, newline).toString('utf8'), committed)
          start = newline + 1
          newline = buffer.indexOf(10, start)
        }
        if (buffer.length - start > MAX_LINE_BYTES) throw new Error(LINE_TOO_LARGE)
        carry = Buffer.from(buffer.subarray(start))
      }
      const after = fstatSync(fd)
      if (after.size < before.size || (after.mtimeMs !== before.mtimeMs && after.size <= before.size) ||
          digest(readRange(fd, 0, initialPrefixLength)) !== initialPrefix) {
        // Throw so the scheduler retains its previous cursor and retries the changed file.
        throw new Error(READ_FAILURE)
      }
      Object.assign(state, {
        offset: committed, fileId, size: before.size, mtimeMs: before.mtimeMs, ...guards(fd, committed)
      })
      return {
        events: state.invalid ? [] : events,
        endOffset: committed,
        recognized: state.protocol !== undefined && !state.invalid,
        state
      }
    } catch (error) {
      // Do not expose filesystem paths, original error messages, or journal contents.
      throw new Error(error instanceof Error && error.message === LINE_TOO_LARGE ? LINE_TOO_LARGE : READ_FAILURE)
    } finally {
      try { closeSync(fd) } catch { throw new Error(READ_FAILURE) }
    }
  }
}

export class KimiCodeAdapter extends KimiAdapter {
  readonly id = 'kimi-code' as const
  readonly displayName = 'Kimi Code'
  constructor(opts: KimiOptions = {}) {
    super(opts, [process.env.KIMI_CODE_HOME || join(homedir(), '.kimi-code')])
  }
}

export class KimiDesktopAdapter extends KimiAdapter {
  readonly id = 'kimi-desktop' as const
  readonly displayName = 'Kimi Desktop'
  private readonly defaultProfile?: string

  constructor(opts: KimiOptions = {}) {
    const profile = appDataPath('kimi-desktop')
    super(opts, [join(profile, 'daimon-share', 'daimon', 'runtime', 'kimi-code', 'home')])
    const roots = typeof opts.roots === 'string' ? [opts.roots] : opts.roots
    if (!roots?.length) this.defaultProfile = profile
  }

  override async probe(): Promise<ProbeResult> {
    const result = await super.probe()
    if (result.status === 'absent' && this.defaultProfile && dirExists(this.defaultProfile)) {
      return {
        ...result, status: 'unsupported', root: this.defaultProfile, fileCount: 0,
        detail: '已检测到 Kimi Desktop，尚无本地任务用量；云端聊天暂不支持'
      }
    }
    return result
  }
}
