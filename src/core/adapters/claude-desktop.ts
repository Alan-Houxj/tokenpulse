import { createHash } from 'node:crypto'
import { closeSync, fstatSync, lstatSync, openSync, readdirSync, readSync, realpathSync, type Stats } from 'node:fs'
import { basename, join } from 'node:path'
import type { DiscoveredFile, ReadResult, SourceAdapter, UsageEvent } from '../model/types'
import { appDataPath, effectiveRoots } from './paths'
import { probeRecordedUsage } from './probe-util'
import { homePath, normalizePathKey, parseJsonLine } from './util'

const SURFACE_DIRS = ['local-agent-mode-sessions', 'claude-code-sessions']
const SESSION_DIR = /^(?:[a-f0-9-]{8,64}|local_[a-z0-9_-]{1,128})$/i
const MAX_SESSION_DEPTH = 5
const TRANSCRIPT_TYPES = new Set([
  'assistant', 'user', 'system', 'progress', 'queue-operation', 'file-history-snapshot', 'summary', 'last-prompt'
])

type JsonObject = Record<string, unknown>

function object(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : undefined
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function nonnegative(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

const FINGERPRINT_BYTES = 4096

interface TranscriptState {
  version: 1
  path: string
  generation: string
  offset: number
  size: number
  mtimeMs: number
  ctimeMs: number
  prefix: string
  boundary: string
  recognized: boolean
}

function generation(stat: Stats): string {
  return `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`
}

function readState(value: unknown): TranscriptState | undefined {
  const state = object(value)
  if (!state || state['version'] !== 1 || !text(state['path']) || !text(state['generation'])) return undefined
  if (count(state['offset']) === undefined || count(state['size']) === undefined) return undefined
  if ((state['offset'] as number) > (state['size'] as number)) return undefined
  if (nonnegative(state['mtimeMs']) === undefined || nonnegative(state['ctimeMs']) === undefined) return undefined
  if (!['prefix', 'boundary'].every((key) => typeof state[key] === 'string' && /^[a-f0-9]{64}$/.test(state[key] as string))) {
    return undefined
  }
  if (typeof state['recognized'] !== 'boolean') return undefined
  return state as unknown as TranscriptState
}

function readBytes(fd: number, position: number, length: number): Buffer {
  const buffer = Buffer.alloc(length)
  let consumed = 0
  while (consumed < length) {
    const read = readSync(fd, buffer, consumed, length - consumed, position + consumed)
    if (read === 0) throw new Error('Claude transcript changed or ended during read; retry without advancing the offset')
    consumed += read
  }
  return buffer
}

function fingerprint(fd: number, position: number, length: number): string {
  return createHash('sha256').update(readBytes(fd, position, length)).digest('hex')
}

function readTranscript(file: DiscoveredFile, fromOffset: number, saved?: unknown) {
  if (count(fromOffset) === undefined) throw new Error('Invalid Claude transcript offset')
  const path = normalizePathKey(file.path)
  const previous = readState(saved)
  const fd = openSync(file.path, 'r')
  try {
    const before = fstatSync(fd)
    if (!before.isFile()) throw new Error('Claude transcript is not a regular file')
    const identity = generation(before)
    let start = fromOffset
    let continued = fromOffset > 0
    // Old offsets without fingerprints get one safe replay, retaining the same event IDs.
    if (continued && (!previous || previous.path !== path || previous.offset !== fromOffset ||
        previous.generation !== identity || before.size < previous.size || before.size < fromOffset)) {
      start = 0
      continued = false
    }
    if (continued && previous) {
      const prefixLength = Math.min(FINGERPRINT_BYTES, fromOffset)
      const boundaryStart = Math.max(0, fromOffset - FINGERPRINT_BYTES)
      const metadataChanged = before.mtimeMs !== previous.mtimeMs || before.ctimeMs !== previous.ctimeMs
      if ((before.size === previous.size && metadataChanged) ||
          fingerprint(fd, 0, prefixLength) !== previous.prefix ||
          fingerprint(fd, boundaryStart, fromOffset - boundaryStart) !== previous.boundary) {
        start = 0
        continued = false
      }
    }

    const buffer = readBytes(fd, start, before.size - start)
    // Locate LF in raw bytes before decoding, so an incomplete UTF-8 tail never shifts the offset.
    const newline = buffer.lastIndexOf(0x0a)
    const endOffset = newline < 0 ? start : start + newline + 1
    const lines = newline < 0 ? [] : buffer.subarray(0, newline).toString('utf8').split('\n').map((line) => line.replace(/\r$/, ''))
    const boundaryStart = Math.max(0, endOffset - FINGERPRINT_BYTES)
    const state: TranscriptState = {
      version: 1,
      path,
      generation: identity,
      offset: endOffset,
      size: before.size,
      mtimeMs: before.mtimeMs,
      ctimeMs: before.ctimeMs,
      prefix: fingerprint(fd, 0, Math.min(FINGERPRINT_BYTES, endOffset)),
      boundary: fingerprint(fd, boundaryStart, endOffset - boundaryStart),
      recognized: continued && previous?.recognized === true
    }
    const after = fstatSync(fd)
    const current = lstatSync(file.path)
    if (!current.isFile() || current.isSymbolicLink() || generation(current) !== identity ||
        [after, current].some((stat) => stat.size !== before.size || stat.mtimeMs !== before.mtimeMs || stat.ctimeMs !== before.ctimeMs)) {
      throw new Error('Claude transcript changed during read; retry without advancing the offset')
    }
    return { lines, endOffset, state }
  } finally {
    closeSync(fd)
  }
}

function directory(path: string): boolean {
  try {
    const stat = lstatSync(path)
    return stat.isDirectory() && !stat.isSymbolicLink()
  } catch {
    return false
  }
}

function entries(path: string) {
  try {
    return readdirSync(path, { withFileTypes: true })
  } catch {
    return []
  }
}

function defaultDesktopRoots(): string[] {
  const roots = [appDataPath('Claude'), appDataPath('Claude-3p')]
  if (process.env['CLAUDE_USER_DATA_DIR']) roots.unshift(process.env['CLAUDE_USER_DATA_DIR'])
  if (process.platform !== 'win32') return roots

  const local = process.env['LOCALAPPDATA'] || homePath('AppData', 'Local')
  roots.unshift(join(local, 'Claude-3p'), join(local, 'Claude'))
  const packages = join(local, 'Packages')
  for (const entry of entries(packages)) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !/^Claude_/i.test(entry.name)) continue
    const cache = join(packages, entry.name, 'LocalCache')
    roots.push(
      join(cache, 'Roaming', 'Claude'),
      join(cache, 'Local', 'Claude'),
      join(cache, 'Local', 'Claude-3p'),
      join(cache, 'Roaming', 'Claude-3p')
    )
  }
  return roots
}

function collectProjects(root: string, files: Map<string, DiscoveredFile>): void {
  if (!directory(root)) return
  const addFiles = (path: string): void => {
    for (const entry of entries(path)) {
      if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith('.jsonl')) continue
      try {
        const full = join(path, entry.name)
        const stat = lstatSync(full)
        if (!stat.isFile() || stat.isSymbolicLink()) continue
        const canonical = normalizePathKey(realpathSync(full))
        const key = process.platform === 'win32' ? canonical.toLowerCase() : canonical
        files.set(key, { path: canonical, size: stat.size, mtimeMs: stat.mtimeMs })
      } catch {
        // A session can disappear while the desktop application archives it.
      }
    }
  }

  for (const project of entries(root)) {
    if (!project.isDirectory() || project.isSymbolicLink()) continue
    const projectPath = join(root, project.name)
    addFiles(projectPath)
    for (const session of entries(projectPath)) {
      if (!session.isDirectory() || session.isSymbolicLink() || !SESSION_DIR.test(session.name)) continue
      const subagents = join(projectPath, session.name, 'subagents')
      if (directory(subagents)) addFiles(subagents)
    }
  }
}

function collectSurface(root: string, files: Map<string, DiscoveredFile>, depth = 0): void {
  if (depth > MAX_SESSION_DEPTH || !directory(root)) return
  for (const entry of entries(root)) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue
    const child = join(root, entry.name)
    if (entry.name === '.claude') {
      collectProjects(join(child, 'projects'), files)
    } else if (SESSION_DIR.test(entry.name)) {
      collectSurface(child, files, depth + 1)
    }
  }
}

function usageEvent(raw: JsonObject): UsageEvent | undefined {
  const message = object(raw['message'])
  const usage = object(message?.['usage'])
  if (raw['type'] !== 'assistant' || !message || !usage) return undefined
  if (raw['isApiErrorMessage'] === true || raw['is_api_error_message'] === true || raw['isReplay'] === true) {
    return undefined
  }
  if (raw['error'] || message['model'] === '<synthetic>' || !text(message['stop_reason'])) return undefined

  const sessionId = text(raw['sessionId'])
  const requestId = text(raw['requestId']) ?? text(message['id'])
  const model = text(message['model'])
  const timestamp = text(raw['timestamp'])
  if (!sessionId || !requestId || !model || !timestamp) return undefined
  const ts = Date.parse(timestamp)
  if (!Number.isFinite(ts)) return undefined

  // Observed canonical records report all four fields. Missing counters are unknown, not zero.
  const input = count(usage['input_tokens'])
  const output = count(usage['output_tokens'])
  const cacheRead = count(usage['cache_read_input_tokens'])
  const cacheWrite = count(usage['cache_creation_input_tokens'])
  if (input === undefined || output === undefined || cacheRead === undefined || cacheWrite === undefined) {
    return undefined
  }

  return {
    // Shared with the CLI adapter: copied/imported messages must not acquire a second identity.
    id: `claude-code:${sessionId}:${requestId}`,
    agent: 'claude-desktop',
    sessionId,
    ts,
    model,
    // Anthropic input excludes cache; output already includes thinking tokens.
    tokens: { input, output, reasoning: 0, cacheRead, cacheWrite },
    costUSD: nonnegative(raw['costUSD']),
    costEstUSD: 0,
    durationMs: nonnegative(raw['durationMs']),
    projectPath: text(raw['cwd'])
  }
}

export class ClaudeDesktopAdapter implements SourceAdapter {
  readonly id = 'claude-desktop' as const
  readonly displayName = 'Claude Desktop'
  private readonly rootCandidates: string[]

  constructor(opts: { roots?: string[] | string } = {}) {
    const configured = effectiveRoots(opts.roots, [])
    this.rootCandidates = configured.length ? configured : effectiveRoots(undefined, defaultDesktopRoots())
  }

  defaultRoots(): string[] {
    return [...this.rootCandidates]
  }

  discover(): DiscoveredFile[] {
    const files = new Map<string, DiscoveredFile>()
    for (const root of this.rootCandidates) {
      if (!directory(root)) continue
      if (SURFACE_DIRS.includes(basename(root))) {
        collectSurface(root, files)
      } else {
        // Never traverse a whole profile, audit logs, browser stores, or the user's ~/.claude.
        for (const surface of SURFACE_DIRS) collectSurface(join(root, surface), files)
      }
    }
    return [...files.values()]
  }

  probe() {
    return probeRecordedUsage(this, {
      coverage: '仅统计本地 Code/Cowork 已结束消息的真实用量；不含普通 Desktop 聊天或仅远程会话',
      emptyDetail: '已检测到 Claude 数据目录，但没有可读取的 Code/Cowork 用量记录；普通聊天用量不可用，不计为零',
      noUsageDetail: '已识别 Code/Cowork 记录，但没有完整的已结束消息数值用量；缺失、估算和错误占位不计为零',
      unavailableWithoutFiles: true
    })
  }

  async readIncremental(file: DiscoveredFile, fromOffset: number, saved?: unknown): Promise<ReadResult> {
    const { lines, endOffset, state } = readTranscript(file, fromOffset, saved)
    const events = new Map<string, UsageEvent>()
    let recognized = state.recognized
    for (const line of lines) {
      const raw = object(parseJsonLine<unknown>(line))
      if (!raw || typeof raw['type'] !== 'string' || !TRANSCRIPT_TYPES.has(raw['type'])) continue
      recognized = true
      const event = usageEvent(raw)
      if (event && !events.has(event.id)) events.set(event.id, event)
    }
    return { events: [...events.values()], endOffset, state: { ...state, recognized }, recognized }
  }
}
