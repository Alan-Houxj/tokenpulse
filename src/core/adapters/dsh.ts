import { createHash } from 'node:crypto'
import { closeSync, fstatSync, openSync, opendirSync, readSync, realpathSync, statSync, type Dirent } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { TextDecoder } from 'node:util'
import type { DiscoveredFile, ProbeResult, ReadResult, SourceAdapter, TokenBreakdown, UsageEvent } from '../model/types'
import { appDataPath } from './paths'
import { probeRecordedUsage } from './probe-util'
import { normalizePathKey } from './util'
import { decodeDshFrames, MAX_DSH_SOURCE_BYTES } from './zstd-reader'

const MAX_ROOTS = 16
const MAX_DISCOVERY_ENTRIES = 50_000
const MAX_RECORDS = 100_000
const MAX_LINE_BYTES = 4 * 1024 * 1024
const decoder = new TextDecoder('utf-8', { fatal: true })
const COVERAGE = '统计 DSH v4 本地用量记录，含可读取的压缩日志；不含未上报的标题/搜索用量。单会话读取上限：源文件 32 MiB / 解压后 64 MiB。'

type Json = Record<string, unknown>
interface Header {
  id: string
  createdAt: number
  isSeeded: boolean
  cwd?: string
}
interface CursorState {
  version: 1
  offset: number
  prefixHash: string
  identity: string
}
interface Candidate {
  name: string
  version: number
  compressed: boolean
}
interface Row {
  value: Json
  end: number
}

function object(value: unknown): Json | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Json : undefined
}
function count(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}
function label(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 4096
}
function generation(name: string): Candidate | undefined {
  const match = /^session(?:\.v([1-9]\d*))?\.jsonl(\.zstd)?$/.exec(name)
  if (!match) return undefined
  const version = match[1] === undefined ? 0 : Number(match[1])
  return Number.isSafeInteger(version) ? { name, version, compressed: match[2] !== undefined } : undefined
}
function entries(path: string, budget: { remaining: number }): Dirent[] {
  let dir
  try { dir = opendirSync(path) } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return []
    throw new Error('DSH session directory is not readable')
  }
  const result: Dirent[] = []
  try {
    for (;;) {
      const entry = dir.readSync()
      if (!entry) break
      if (--budget.remaining < 0) throw new Error('DSH discovery exceeds the directory-entry limit')
      result.push(entry)
    }
  } finally { dir.closeSync() }
  return result
}
function chooseGeneration(dir: string, budget: { remaining: number }): { selected?: Candidate; ambiguous: boolean } {
  const candidates = entries(dir, budget).filter(e => e.isFile()).flatMap(e => {
    const parsed = generation(e.name)
    return parsed ? [parsed] : []
  }).sort((a, b) => b.version - a.version || a.name.localeCompare(b.name))
  return { selected: candidates[0], ambiguous: new Set(candidates.map(c => c.compressed)).size > 1 }
}
function directory(path: string): boolean {
  try { return statSync(path).isDirectory() } catch { return false }
}
function fingerprint(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}
function snapshot(path: string): { bytes: Buffer; identity: string } {
  const fd = openSync(path, 'r')
  try {
    const before = fstatSync(fd)
    if (!before.isFile() || before.size > MAX_DSH_SOURCE_BYTES) {
      throw new Error('DSH source is not a regular file within the 32 MiB read limit')
    }
    const bytes = Buffer.alloc(before.size)
    let offset = 0
    while (offset < bytes.length) {
      const n = readSync(fd, bytes, offset, bytes.length - offset, offset)
      if (n === 0) throw new Error('DSH log changed during snapshot; retry on the next poll')
      offset += n
    }
    const after = fstatSync(fd)
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw new Error('DSH log changed during snapshot; retry on the next poll')
    }
    return { bytes, identity: `${before.dev}:${before.ino}:${before.birthtimeMs}` }
  } finally { closeSync(fd) }
}
function parseLine(bytes: Buffer): Json {
  if (bytes.length > MAX_LINE_BYTES) throw new Error('DSH record exceeds the 4 MiB line limit')
  let value: unknown
  try { value = JSON.parse(decoder.decode(bytes)) } catch {
    throw new Error('DSH committed record is not valid UTF-8 JSON')
  }
  const row = object(value)
  if (!row) throw new Error('DSH committed record must be an object')
  return row
}
function* rows(bytes: Buffer, compressed: boolean): Generator<Row> {
  let records = 0
  if (compressed) {
    let first = true
    for (const frame of decodeDshFrames(bytes)) {
      if (frame.data.length === 0 || frame.data.at(-1) !== 10) throw new Error('DSH complete frame contains an incomplete JSONL record')
      if (first && frame.data.indexOf(10) !== frame.data.length - 1) throw new Error('DSH first frame must contain only its session header')
      first = false
      let start = 0
      for (let end = frame.data.indexOf(10); end !== -1; end = frame.data.indexOf(10, start)) {
        if (++records > MAX_RECORDS) throw new Error('DSH log exceeds the record-count limit')
        yield { value: parseLine(frame.data.subarray(start, end)), end: frame.end }
        start = end + 1
      }
    }
    return
  }
  let start = 0
  for (let end = bytes.indexOf(10); end !== -1; end = bytes.indexOf(10, start)) {
    if (++records > MAX_RECORDS) throw new Error('DSH log exceeds the record-count limit')
    yield { value: parseLine(bytes.subarray(start, end)), end: end + 1 }
    start = end + 1
  }
  if (bytes.length - start > MAX_LINE_BYTES) throw new Error('DSH partial record exceeds the 4 MiB line limit')
}
function readHeader(row: Json): Header | undefined {
  if (row.type !== 'session' || row.version !== 4 || !label(row.id) || !count(row.createdAt)
    || typeof row.isSeeded !== 'boolean' || !count(row.delegationDepth)
    || (row.cwd !== undefined && !label(row.cwd))) return undefined
  return { id: row.id, createdAt: row.createdAt, isSeeded: row.isSeeded, ...(row.cwd === undefined ? {} : { cwd: row.cwd as string }) }
}
function usageInStream(value: unknown): unknown {
  if (!Array.isArray(value)) return undefined
  for (let i = value.length - 1; i >= 0; i--) {
    const item = object(value[i])
    const chunk = object(item?.chunk)
    if (item?.type === 'chunk' && chunk?.type === 'usage') return chunk.usage
  }
  return undefined
}
function tokens(value: unknown): TokenBreakdown | undefined {
  const usage = object(value)
  if (!usage || !count(usage.inputTokens) || !count(usage.outputTokens)) return undefined
  for (const key of ['cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens', 'totalTokens']) {
    if (usage[key] !== undefined && !count(usage[key])) return undefined
  }
  const input = usage.inputTokens
  const output = usage.outputTokens
  const cacheRead = (usage.cacheReadTokens as number | undefined) ?? 0
  const cacheWrite = (usage.cacheWriteTokens as number | undefined) ?? 0
  const reasoning = (usage.reasoningTokens as number | undefined) ?? 0
  const total = input + output + cacheRead + cacheWrite
  if (!count(total) || total === 0 || reasoning > output) return undefined
  // An unexplained exact-total residual cannot safely be assigned to a missing bucket.
  if (usage.totalTokens !== undefined && usage.totalTokens !== total) return undefined
  // Keep DSH's billed output total intact; optional reasoning is included, not counted again.
  return { input, output, reasoning: 0, cacheRead, cacheWrite }
}
function eventUsage(row: Json, header: Header, route: string | undefined): UsageEvent | undefined {
  const data = object(row.data)
  if (!data) return undefined
  let model: string | undefined
  let requestId: string
  let usage: unknown
  if (row.type === 'assistant/message') {
    const message = object(data.message)
    const source = object(message?.source)
    if (row.surfaceOp !== 'append' || source?.kind !== 'model' || !label(source.model) || !label(message?.id)
      || !count(data.turn) || !count(data.step)) return undefined
    model = source.model
    requestId = `message:${encodeURIComponent(message.id)}`
    usage = data.usage ?? usageInStream(data.stream)
  } else if (row.type === 'assistant/attempt') {
    if (!count(data.turn) || !count(data.step)) return undefined
    model = route
    requestId = `v4:attempt:${row.seq}`
    usage = usageInStream(data.stream)
  } else if (row.type === 'compaction/summary') {
    if (data.llmStreamCall !== true || !label(data.compactionId) || !label(data.model)) return undefined
    model = data.model
    requestId = `compaction:${encodeURIComponent(data.compactionId)}`
    usage = data.usage
  } else return undefined
  const breakdown = tokens(usage)
  if (!model || !breakdown) return undefined
  return {
    id: `dsh:${encodeURIComponent(header.id)}:${requestId}`,
    ts: row.time as number,
    agent: 'dsh',
    sessionId: header.id,
    model,
    tokens: breakdown,
    costEstUSD: 0,
    ...(header.cwd === undefined ? {} : { projectPath: header.cwd })
  }
}

export class DshAdapter implements SourceAdapter {
  readonly id = 'dsh' as const
  readonly displayName = 'DSH'
  private readonly roots?: string[]

  constructor(opts: { roots?: string[] | string } = {}) {
    this.roots = opts.roots === undefined ? undefined : typeof opts.roots === 'string' ? [opts.roots] : [...opts.roots]
    if (this.roots && (this.roots.length > MAX_ROOTS || this.roots.some(root => !root.trim()))) {
      throw new Error('DSH roots must contain at most 16 nonempty paths')
    }
  }

  defaultRoots(): string[] {
    if (this.roots !== undefined) return [...this.roots]
    const home = homedir()
    const configured = process.env.DSH_HOME?.trim()
    const harness = configured ? (configured === '~' ? home : /^~[/\\]/.test(configured) ? join(home, configured.slice(2)) : resolve(configured)) : join(home, '.dsh')
    const desktop = process.platform === 'win32' || process.platform === 'darwin'
      ? [join(appDataPath('dsh-desktop'), 'harness')] : []
    return [...new Set([...desktop, harness])]
  }

  discover(): DiscoveredFile[] {
    const budget = { remaining: MAX_DISCOVERY_ENTRIES }
    const found = new Map<string, DiscoveredFile>()
    const visited = new Set<string>()
    for (const configured of this.defaultRoots()) {
      const nested = join(configured, 'sessions')
      const root = directory(nested) ? nested : configured
      if (!directory(root)) continue
      const canonical = normalizePathKey(realpathSync(root))
      if (visited.has(canonical)) continue
      visited.add(canonical)
      for (const workspace of entries(root, budget).filter(e => e.isDirectory())) {
        const project = join(root, workspace.name)
        for (const session of entries(project, budget).filter(e => e.isDirectory())) {
          const dir = join(project, session.name)
          const { selected } = chooseGeneration(dir, budget)
          if (!selected) continue
          const path = normalizePathKey(realpathSync(join(dir, selected.name)))
          const st = statSync(path)
          found.set(path, { path, size: st.size, mtimeMs: st.mtimeMs })
        }
      }
    }
    return [...found.values()].sort((a, b) => a.path.localeCompare(b.path))
  }

  probe(): Promise<ProbeResult> {
    return probeRecordedUsage(this, {
      coverage: COVERAGE,
      noUsageDetail: '已识别 DSH 会话记录，但在有限抽样中未发现受支持的正数 token 用量；不计为零消耗。'
    })
  }

  async readIncremental(file: DiscoveredFile, fromOffset: number, previous?: unknown): Promise<ReadResult> {
    const format = generation(basename(file.path))
    if (!format || format.version !== 4) return { events: [], endOffset: 0, recognized: false }
    const selection = chooseGeneration(dirname(file.path), { remaining: MAX_DISCOVERY_ENTRIES })
    if (selection.ambiguous || selection.selected?.name !== basename(file.path)) {
      return { events: [], endOffset: 0, recognized: false }
    }
    const { bytes, identity } = snapshot(file.path)
    const prior = object(previous)
    const reusable = fromOffset > 0 && count(fromOffset) && fromOffset <= bytes.length && prior?.version === 1
      && prior.offset === fromOffset && prior.identity === identity && typeof prior.prefixHash === 'string'
      && prior.prefixHash === fingerprint(bytes.subarray(0, fromOffset))
    const startOffset = reusable ? fromOffset : 0
    let header: Header | undefined
    let route: string | undefined
    let lastSeq = -1
    let inheritedCut: number | undefined
    let endOffset = 0
    const collected: { event: UsageEvent; seq: number; end: number }[] = []
    // Full bounded replay recovers request routing and the LAST inherited marker without persisting content.
    for (const record of rows(bytes, format.compressed)) {
      if (!header) {
        header = readHeader(record.value)
        if (!header) return { events: [], endOffset: 0, recognized: false }
        endOffset = record.end
        continue
      }
      const row = record.value
      if (!label(row.type) || !count(row.seq) || row.seq !== lastSeq + 1 || !count(row.time) || !object(row.data)) {
        throw new Error('DSH committed event has an invalid envelope or noncontiguous sequence')
      }
      lastSeq = row.seq
      endOffset = record.end
      const data = row.data as Json
      if (row.type === 'session/end-seed' && data.inherited === true) inheritedCut = row.seq
      if (row.type === 'request/header') {
        const config = object(object(data.header)?.config)
        route = label(config?.model) && label(config?.provider) ? config.model : undefined
      }
      const event = eventUsage(row, header, route)
      if (event) collected.push({ event, seq: row.seq, end: record.end })
    }
    if (!header) return { events: [], endOffset: 0, recognized: false }
    if (!header.isSeeded && inheritedCut !== undefined) throw new Error('DSH unseeded session contains an inherited-history marker')
    // A torn initial fork snapshot may contain an ancestor's marker before its own final cutoff.
    if (header.isSeeded && (inheritedCut === undefined || (!reusable && endOffset < bytes.length))) {
      return { events: [], endOffset: 0, recognized: true }
    }
    const seen = new Set<string>()
    const events: UsageEvent[] = []
    for (const item of collected) {
      if (item.seq < (inheritedCut ?? 0) || seen.has(item.event.id)) continue
      seen.add(item.event.id)
      if (item.end > startOffset) events.push(item.event)
    }
    const state: CursorState = { version: 1, offset: endOffset, prefixHash: fingerprint(bytes.subarray(0, endOffset)), identity }
    return { events, endOffset, state, recognized: true }
  }
}
