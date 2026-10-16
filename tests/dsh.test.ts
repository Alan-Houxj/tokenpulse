import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appendFileSync, closeSync, existsSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { constants, zstdCompressSync } from 'node:zlib'
import { DshAdapter } from '../src/core/adapters/dsh'
import { decodeDshFrames, MAX_DSH_SOURCE_BYTES } from '../src/core/adapters/zstd-reader'
import { appDataPath } from '../src/core/adapters/paths'
import { normalizePathKey } from '../src/core/adapters/util'

let dir: string
const time = 1_790_000_000_000
const usage = { inputTokens: 100, outputTokens: 30, reasoningTokens: 10, cacheReadTokens: 200, cacheWriteTokens: 50, totalTokens: 380 }

function header(overrides: Record<string, unknown> = {}) {
  return { type: 'session', version: 4, id: 'session-example', createdAt: time, cwd: 'C:/example', isSeeded: false, delegationDepth: 0, ...overrides }
}
function event(type: string, seq: number, data: Record<string, unknown>) {
  return { type, seq, time: time + seq, data }
}
function stream(sample: unknown) {
  return [{ type: 'chunk', time, chunk: { type: 'usage', usage: sample } }]
}
function message(seq: number, id = `message-${seq}`, sample: unknown = usage) {
  return {
    ...event('assistant/message', seq, {
      turn: 0, step: 0,
      message: { id, role: 'assistant', source: { kind: 'model', provider: 'example', model: 'example-model' }, content: [] },
      usage: sample,
      stream: stream(sample)
    }),
    surfaceOp: 'append'
  }
}
function attempt(seq: number, sample: unknown = usage) {
  return event('assistant/attempt', seq, { turn: 0, step: 0, stream: stream(sample) })
}
function route(seq: number, model = 'routed-model') {
  return event('request/header', seq, { header: { config: { provider: 'example', model } } })
}
function raw(records: unknown[]): Buffer {
  return Buffer.from(records.map(r => JSON.stringify(r)).join('\n') + '\n')
}
function frame(records: unknown[]): Buffer {
  return zstdCompressSync(raw(records), { params: { [constants.ZSTD_c_checksumFlag]: 1 } })
}
function log(bytes: Buffer | string, name = 'session.v4.jsonl', root = dir, session = 'session-example'): string {
  const target = join(root, 'sessions', '--example--', session, name)
  mkdirSync(join(target, '..'), { recursive: true })
  writeFileSync(target, bytes)
  return target
}
function adapter(root: string | string[] = dir) {
  return new DshAdapter({ roots: root })
}
async function read(a = adapter(), offset = 0, state?: unknown) {
  const file = a.discover()[0]
  expect(file).toBeDefined()
  return a.readIncremental(file!, offset, state)
}

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'tokenpulse-dsh-')) })
afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(dir, { recursive: true, force: true })
})

describe('DSH roots and discovery', () => {
  it('replaces defaults with string, array, or empty roots and supports sessions roots', () => {
    const path = log(raw([header()]))
    expect(adapter().defaultRoots()).toEqual([dir])
    expect(adapter([]).discover()).toEqual([])
    expect(adapter([dir, join(dir, 'sessions')]).discover()).toHaveLength(1)
    expect(adapter(join(dir, 'sessions')).discover()[0]!.path).toBe(normalizePathKey(realpathSync(path)))
    expect(() => adapter('')).toThrow(/nonempty/)
    expect(() => adapter(Array(17).fill(dir))).toThrow(/16/)
  })

  it('uses DSH_HOME plus supported desktop home without reading config', () => {
    const custom = join(dir, 'custom-home')
    vi.stubEnv('DSH_HOME', custom)
    const roots = new DshAdapter().defaultRoots()
    expect(roots).toContain(custom)
    if (process.platform === 'win32' || process.platform === 'darwin') {
      expect(roots).toContain(join(appDataPath('dsh-desktop'), 'harness'))
    } else expect(roots).toEqual([custom])
    vi.stubEnv('DSH_HOME', '   ')
    expect(new DshAdapter().defaultRoots()).toContain(join(homedir(), '.dsh'))
    vi.stubEnv('DSH_HOME', '~/custom-dsh')
    expect(new DshAdapter().defaultRoots()).toContain(join(homedir(), 'custom-dsh'))
  })

  it('selects only the highest canonical generation and ignores caches and temporary files', async () => {
    log(raw([header(), message(0)]), 'session.v4.jsonl')
    log(raw([header({ version: 3 })]), 'session.v3.jsonl')
    log('{}', 'session.v04.jsonl')
    log('{}', 'session.migration.part.tmp')
    log('{}', 'SESSION.V99.JSONL')
    log('{}', 'session.v0.jsonl')
    mkdirSync(join(dir, 'storages', 'session_projcache'), { recursive: true })
    writeFileSync(join(dir, 'storages', 'session_projcache', 'session.json'), '{}')
    const a = adapter()
    expect(a.discover()).toHaveLength(1)
    expect((await read(a)).events).toHaveLength(1)
    log(raw([header({ version: 5 }), message(0)]), 'session.v5.jsonl')
    expect(a.discover()[0]!.path).toContain('session.v5.jsonl')
    expect(await read(a)).toMatchObject({ events: [], recognized: false, endOffset: 0 })
  })

  it('refuses ambiguous raw and compressed copies and unsupported physical headers', async () => {
    log(raw([header(), message(0)]))
    const compressed = log(Buffer.concat([frame([header()]), frame([message(0)])]), 'session.v4.jsonl.zstd')
    expect((await read()).recognized).toBe(false)
    rmSync(compressed)
    log(raw([header({ version: 3 }), message(0)]))
    expect((await read()).recognized).toBe(false)
  })
})

describe('DSH probing', () => {
  it('distinguishes absent, empty, unsupported metadata and verified usage from offset zero', async () => {
    expect((await adapter(join(dir, 'missing')).probe()).status).toBe('absent')
    expect((await adapter().probe()).status).toBe('empty')
    log(frame([header()]), 'session.v4.jsonl.zstd')
    expect((await adapter().probe()).status).toBe('unsupported')
    log(Buffer.concat([frame([header()]), frame([message(0)])]), 'session.v4.jsonl.zstd')
    const result = await adapter().probe()
    expect(result.status).toBe('ok')
    expect(result.detail).toContain('DSH v4 本地用量记录')
    expect(result.sessionCount).toBe(1)
  })
})

describe('DSH recorded token usage', () => {
  it('maps final usage once, preserves billed output including reasoning and omits costs', async () => {
    log(raw([header(), message(0)]))
    const result = await read()
    expect(result.recognized).toBe(true)
    expect(result.events).toHaveLength(1)
    expect(result.events[0]).toMatchObject({
      id: 'dsh:session-example:message:message-0', agent: 'dsh', sessionId: 'session-example',
      model: 'example-model', ts: time, projectPath: 'C:/example', costEstUSD: 0,
      tokens: { input: 100, output: 30, reasoning: 0, cacheRead: 200, cacheWrite: 50 }
    })
    expect(result.events[0]).not.toHaveProperty('costUSD')
  })

  it('takes the last stream usage, prefers final usage, and does not sum cumulative samples', async () => {
    const first = message(0)
    delete first.data.usage
    first.data.stream = [...stream({ inputTokens: 1, outputTokens: 1 }), ...stream(usage)]
    const second = message(1)
    second.data.stream = stream({ inputTokens: 9_999, outputTokens: 9_999 })
    log(raw([header(), first, second]))
    const result = await read()
    expect(result.events).toHaveLength(2)
    expect(result.events.map(e => e.tokens.input)).toEqual([100, 100])
  })

  it('skips missing, malformed, unsafe, contradictory and nonpositive usage', async () => {
    const samples: unknown[] = [undefined, {}, { inputTokens: '1', outputTokens: 2 },
      { inputTokens: 1 }, { inputTokens: 1, outputTokens: -1 },
      { inputTokens: 1, outputTokens: 1.5 }, { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 1 },
      { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      { inputTokens: 1, outputTokens: 2, reasoningTokens: 3 },
      { inputTokens: 1, outputTokens: 2, cacheReadTokens: null },
      { inputTokens: 1, outputTokens: 2, totalTokens: 5 }]
    const absent = message(0)
    delete absent.data.usage
    absent.data.stream = []
    log(raw([header(), absent, ...samples.slice(1).map((u, i) => message(i + 1, `m-${i + 1}`, u))]))
    expect((await read()).events).toEqual([])
  })

  it('accepts numeric input/output without fabricated cache or reasoning counts', async () => {
    log(raw([header(), message(0, 'simple', { inputTokens: 4, outputTokens: 3 })]))
    expect((await read()).events[0]!.tokens).toEqual({ input: 4, output: 3, reasoning: 0, cacheRead: 0, cacheWrite: 0 })
  })

  it('counts positive failed attempts separately across retries, with request-header route state', async () => {
    const path = log(raw([header(), route(0), event('step/start', 1, { turn: 0, step: 0 }), attempt(2)]))
    const first = await read()
    expect(first.events[0]).toMatchObject({ id: 'dsh:session-example:v4:attempt:2', model: 'routed-model' })
    appendFileSync(path, raw([
      event('llm/retry', 3, { turn: 0, step: 0, retry: 1 }),
      event('llm/retry-started', 4, { turn: 0, step: 0, retry: 1 }),
      attempt(5), attempt(6, { inputTokens: 0, outputTokens: 0, totalTokens: 0 }), message(7)
    ]))
    const next = await read(adapter(), first.endOffset, JSON.parse(JSON.stringify(first.state)))
    expect(next.events).toHaveLength(2)
    expect(new Set([...first.events, ...next.events].map(e => e.id)).size).toBe(3)
    expect(next.events[0]).toMatchObject({ model: 'routed-model', id: 'dsh:session-example:v4:attempt:5' })
    log(raw([header(), attempt(0)]))
    expect((await read()).events).toEqual([])
  })

  it('ingests actual compaction usage only, not caps, shadows, titles, search or context estimates', async () => {
    log(raw([header(), event('compaction/summary', 0, {
      compactionId: 'compact-example', provider: 'example', model: 'compact-model', llmStreamCall: true,
      usage, maxTokens: 999999, shadowedTokenCount: 999999
    }), event('compaction/summary', 1, { compactionId: 'not-llm', model: 'm', usage }),
    event('session/title-llm-request', 2, { maxTokens: 999999, usage }),
    event('web/deepseek-search-llm-request', 3, { maxTokens: 999999, usage }),
    event('request/context', 4, { contextWindow: 999999, usage }),
    event('user/message', 5, { usage })]))
    expect((await read()).events).toMatchObject([{ id: 'dsh:session-example:compaction:compact-example', model: 'compact-model' }])
  })

  it('deduplicates IDs across rereads, appended duplicate records and duplicate roots', async () => {
    const path = log(raw([header(), message(0, 'same'), message(1, 'same')]))
    const a = adapter([dir, dir, join(dir, 'sessions')])
    expect(a.discover()).toHaveLength(1)
    const first = await read(a)
    expect(first.events).toHaveLength(1)
    expect((await read(a)).events.map(e => e.id)).toEqual(first.events.map(e => e.id))
    appendFileSync(path, raw([message(2, 'same'), message(3, 'new')]))
    expect((await read(a, first.endOffset, first.state)).events.map(e => e.id)).toEqual(['dsh:session-example:message:new'])
  })
})

describe('DSH incremental boundaries and rewrites', () => {
  it('preserves a partial raw line and resumes without storing transcript content', async () => {
    const prefix = raw([header(), message(0)])
    const next = raw([message(1)])
    const path = log(Buffer.concat([prefix, next.subarray(0, next.length - 5)]))
    const first = await read()
    expect(first.events).toHaveLength(1)
    expect(first.endOffset).toBe(prefix.length)
    expect(Object.keys(first.state as object).sort()).toEqual(['identity', 'offset', 'prefixHash', 'version'])
    appendFileSync(path, next.subarray(next.length - 5))
    const result = await read(adapter(), first.endOffset, first.state)
    expect(result.events).toHaveLength(1)
    expect(result.endOffset).toBe(statSync(path).size)
    expect((await read(adapter(), result.endOffset, result.state)).events).toEqual([])
    expect((await read(adapter(), 0, result.state)).events).toHaveLength(2)
  })

  it('resets header and routing on truncation and same-size or larger in-place rewrites', async () => {
    const old = raw([header({ id: 'session-old' }), route(0, 'old-model'), attempt(1)])
    const path = log(old)
    const first = await read()
    const sameSize = raw([header({ id: 'session-new' }), route(0, 'new-model'), attempt(1)])
    expect(sameSize.length).toBe(old.length)
    const st = statSync(path)
    writeFileSync(path, sameSize)
    utimesSync(path, st.atime, st.mtime)
    const second = await read(adapter(), first.endOffset, first.state)
    expect(second.events[0]).toMatchObject({ sessionId: 'session-new', model: 'new-model' })
    writeFileSync(path, raw([header({ id: 'session-big' }), route(0, 'big-model'), attempt(1), message(2)]))
    expect((await read(adapter(), second.endOffset, second.state)).events).toHaveLength(2)
    writeFileSync(path, raw([header({ id: 'short' }), attempt(0)]))
    const truncated = await read(adapter(), second.endOffset, second.state)
    expect(truncated.events).toEqual([])
    expect(truncated.endOffset).toBe(statSync(path).size)
  })

  it('does not commit invalid complete JSON, UTF-8 or sequence envelopes', async () => {
    const good = raw([header(), message(0)])
    log(Buffer.concat([good, Buffer.from('{broken\n')]))
    await expect(read()).rejects.toThrow(/valid UTF-8 JSON/)
    log(Buffer.concat([good, Buffer.from([0xff, 10])]))
    await expect(read()).rejects.toThrow(/valid UTF-8 JSON/)
    log(raw([header(), message(2)]))
    await expect(read()).rejects.toThrow(/noncontiguous/)
  })

  it('enforces source, decoded-frame and raw-line bounds without altering files', async () => {
    const path = log('')
    const fd = openSync(path, 'r+')
    try { ftruncateSync(fd, MAX_DSH_SOURCE_BYTES + 1) } finally { closeSync(fd) }
    await expect(read()).rejects.toThrow(/32 MiB/)
    expect(statSync(path).size).toBe(MAX_DSH_SOURCE_BYTES + 1)
    log(Buffer.concat([raw([header()]), Buffer.alloc(4 * 1024 * 1024 + 1, 32)]))
    await expect(read()).rejects.toThrow(/4 MiB/)
    const compressed = zstdCompressSync(Buffer.alloc(16 * 1024 * 1024 + 1, 32))
    expect(() => [...decodeDshFrames(compressed)]).toThrow(/decoded-size/)
    expect(existsSync(path)).toBe(true)
  })
})

describe('DSH fork inheritance', () => {
  it('uses the last marked inherited boundary and does not mistake resume markers for forks', async () => {
    log(raw([
      header({ id: 'child', isSeeded: true, parentSession: 'parent' }),
      message(0, 'parent-first'), event('session/end-seed', 1, { inherited: true }),
      message(2, 'parent-second'), event('session/end-seed', 3, { inherited: true }),
      message(4, 'child-own'), event('session/end-seed', 5, {}), message(6, 'after-resume')
    ]))
    expect((await read()).events.map(e => e.id)).toEqual(['dsh:child:message:child-own', 'dsh:child:message:after-resume'])
    log(raw([header(), message(0), event('session/end-seed', 1, {}), message(2)]))
    expect((await read()).events).toHaveLength(2)
  })

  it('waits for a seeded cutoff even when copied positive usage is already committed', async () => {
    const path = log(Buffer.concat([frame([header({ isSeeded: true })]), frame([route(0), attempt(1), message(2)])]), 'session.v4.jsonl.zstd')
    const first = await read()
    expect(first).toMatchObject({ events: [], endOffset: 0, recognized: true })
    appendFileSync(path, frame([event('session/end-seed', 3, { inherited: true }), attempt(4), message(5)]))
    const next = await read(adapter(), first.endOffset, first.state)
    expect(next.events).toHaveLength(2)
    expect(next.events[0]).toMatchObject({ model: 'routed-model', id: 'dsh:session-example:v4:attempt:4' })
  })

  it('does not accept an ancestor cutoff from an incomplete initial fork snapshot', async () => {
    const prefix = Buffer.concat([frame([header({ isSeeded: true })]), frame([
      message(0, 'ancestor'), event('session/end-seed', 1, { inherited: true }), message(2, 'parent')
    ])])
    const final = frame([event('session/end-seed', 3, { inherited: true }), message(4, 'own')])
    const path = log(Buffer.concat([prefix, final.subarray(0, -3)]), 'session.v4.jsonl.zstd')
    expect(await read()).toMatchObject({ events: [], endOffset: 0 })
    appendFileSync(path, final.subarray(-3))
    expect((await read()).events.map(e => e.id)).toEqual(['dsh:session-example:message:own'])
  })

  it('does not treat inherited marker data on an unseeded header as valid history', async () => {
    log(raw([header(), message(0), event('session/end-seed', 1, { inherited: true })]))
    await expect(read()).rejects.toThrow(/unseeded/)
  })
})

describe('DSH Zstandard framing', () => {
  it('decodes every independent frame and advances physical rather than decoded offsets', async () => {
    const bytes = Buffer.concat([frame([header()]), frame([message(0)]), frame([message(1), message(2)])])
    const path = log(bytes, 'session.v4.jsonl.zstd')
    const first = await read()
    expect(first.events).toHaveLength(3)
    expect(first.endOffset).toBe(bytes.length)
    appendFileSync(path, frame([message(3)]))
    expect((await read(adapter(), first.endOffset, first.state)).events.map(e => e.id)).toEqual(['dsh:session-example:message:message-3'])
  })

  it('does not decode or consume any possible incomplete next-frame prefix', () => {
    const complete = frame([header()])
    const next = frame([message(0)])
    for (let cut = 1; cut < next.length; cut++) {
      const decoded = [...decodeDshFrames(Buffer.concat([complete, next.subarray(0, cut)]))]
      expect(decoded).toHaveLength(1)
      expect(decoded[0]!.end).toBe(complete.length)
    }
  })

  it('holds a missing checksum trailer for the next poll and never modifies the source', async () => {
    const committed = Buffer.concat([frame([header()]), frame([message(0)])])
    const next = frame([message(1)])
    const bytes = Buffer.concat([committed, next.subarray(0, -3)])
    const path = log(bytes, 'session.v4.jsonl.zstd')
    const first = await read()
    expect(first.events).toHaveLength(1)
    expect(first.endOffset).toBe(committed.length)
    expect(readFileSync(path)).toEqual(bytes)
    appendFileSync(path, next.subarray(-3))
    const second = await read(adapter(), first.endOffset, first.state)
    expect(second.events).toHaveLength(1)
    expect(second.endOffset).toBe(committed.length + next.length)
  })

  it('rejects checksum corruption without skipping to later frames', async () => {
    const bad = frame([message(1)])
    bad[bad.length - 1] = bad[bad.length - 1]! ^ 1
    const bytes = Buffer.concat([frame([header()]), frame([message(0)]), bad, frame([message(2)])])
    const path = log(bytes, 'session.v4.jsonl.zstd')
    await expect(read()).rejects.toThrow(/integrity/)
    expect(readFileSync(path)).toEqual(bytes)
  })

  it('rejects malformed frame structure, header frame shape and complete-frame partial lines', async () => {
    const good = frame([header()])
    const magic = Buffer.from(good)
    magic[0] = 0
    expect(() => [...decodeDshFrames(magic)]).toThrow(/magic/)
    const reserved = Buffer.from(good)
    reserved[4] = reserved[4]! | 0x08
    expect(() => [...decodeDshFrames(reserved)]).toThrow(/reserved header/)
    const reservedBlock = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x20, 0, 7, 0, 0])
    expect(() => [...decodeDshFrames(reservedBlock)]).toThrow(/reserved block/)
    const oversizedWindow = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0, 255, 1, 0, 0])
    expect(() => [...decodeDshFrames(oversizedWindow)]).toThrow(/memory limit/)
    log(frame([header(), message(0)]), 'session.v4.jsonl.zstd')
    await expect(read()).rejects.toThrow(/only its session header/)
    const partialLine = zstdCompressSync(Buffer.from('{"type":"assistant/message"}'))
    log(Buffer.concat([good, partialLine]), 'session.v4.jsonl.zstd')
    await expect(read()).rejects.toThrow(/incomplete JSONL/)
    log(good.subarray(0, -1), 'session.v4.jsonl.zstd')
    expect(await read()).toMatchObject({ events: [], endOffset: 0, recognized: false })
  })
})
