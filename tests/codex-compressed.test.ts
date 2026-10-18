import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { constants, zstdCompressSync } from 'node:zlib'
import { CodexAdapter } from '@core/adapters/codex'
import { probeAdapter } from '@core/engine/detect'
import { UsageScheduler } from '@core/engine/scheduler'
import { Store } from '@core/store/sqlite'
import type { DiscoveredFile } from '@core/model/types'

let root: string
const ts = '2026-10-01T10:00:00.000Z'
const meta = (sessionId = 'sample-session') => JSON.stringify({
  timestamp: ts, type: 'session_meta', payload: { id: 'thread-id', session_id: sessionId, cwd: '/example/project' }
}) + '\n'
const context = (model = 'gpt-5.6-sol') => JSON.stringify({
  timestamp: ts, type: 'turn_context', payload: { model, cwd: '/example/project' }
}) + '\n'
const record = (responseId = 'r1', sessionId = 'sample-session') => JSON.stringify({
  timestamp: ts, type: 'token_usage_record',
  payload: { session_id: sessionId, response_id: responseId, usage: {
    input_tokens: 1200, output_tokens: 80, reasoning_output_tokens: 20, cached_input_tokens: 1000, cache_write_input_tokens: 0
  } }
}) + '\n'
const legacy = (input = 1200, output = 80) => JSON.stringify({
  timestamp: ts, type: 'event_msg', payload: { type: 'token_count', info: {
    last_token_usage: { input_tokens: 100, output_tokens: 20, cached_input_tokens: 80, reasoning_output_tokens: 5 },
    total_token_usage: { input_tokens: input, output_tokens: output }
  } }
}) + '\n'
const zstd = (content: string | Buffer) => zstdCompressSync(content, { params: { [constants.ZSTD_c_checksumFlag]: 1 } })
const snapshot = (path: string): DiscoveredFile => {
  const st = statSync(path)
  return { path, size: st.size, mtimeMs: st.mtimeMs }
}
function make(content: string | Buffer, name = 'rollout-test.jsonl.zst'): string {
  const path = join(root, 'sessions', name)
  mkdirSync(join(root, 'sessions'), { recursive: true })
  writeFileSync(path, content)
  return path
}

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'tp-codex-compressed-')) })
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

describe('Codex compressed compatibility', () => {
  it('discovers compressed-only sessions and reports recorded usage rather than an empty directory', async () => {
    make(zstd(meta() + context() + record()))
    make('not a rollout', 'other.jsonl.zst')
    const adapter = new CodexAdapter({ roots: [root] })
    expect(adapter.discover()).toHaveLength(1)
    const result = await probeAdapter(adapter)
    expect(result).toMatchObject({ status: 'ok', fileCount: 1, sessionCount: 1 })
    expect(result.detail).toContain('Zstandard')
  })

  it('preserves exact legacy and response IDs, model and token values across compression', async () => {
    const content = meta() + context() + legacy() + record()
    const plain = make(content, 'rollout-plain.jsonl')
    const packed = make(zstd(content), 'rollout-packed.jsonl.zst')
    const adapter = new CodexAdapter({ roots: root })
    const a = await adapter.readIncremental(snapshot(plain), 0)
    const b = await adapter.readIncremental(snapshot(packed), 0)
    expect(b.events).toEqual(a.events)
    expect(b.events.map(event => event.id)).toEqual(['codex:sample-session:tc:1200-80', 'codex:sample-session:r1'])
    expect(b.events[1]!.tokens).toEqual({ input: 200, output: 60, reasoning: 20, cacheRead: 1000, cacheWrite: 0 })
    expect(b.endOffset).toBe(Buffer.byteLength(content))
    expect(b.recognized).toBe(true)
  })

  it('reconstructs header context for large logs and does not use a compressed byte tail as JSONL', async () => {
    const content = meta() + context() + (JSON.stringify({ type: 'world_state', payload: { text: 'x'.repeat(1024) } }) + '\n').repeat(400) + record()
    const path = make(zstd(content))
    const result = await new CodexAdapter({ roots: root }).readIncremental(snapshot(path), 0)
    expect(result.events[0]).toMatchObject({ model: 'gpt-5.6-sol', projectPath: '/example/project' })
    expect(result.endOffset).toBeGreaterThan(statSync(path).size)
  })

  it('persists a decoded cursor and only emits appended frames across adapter restarts', async () => {
    const path = make(zstd(meta() + context() + record()))
    const initial = await new CodexAdapter({ roots: root }).readIncremental(snapshot(path), 0)
    const state = JSON.parse(JSON.stringify(initial.state))
    const unchanged = await new CodexAdapter({ roots: root }).readIncremental(snapshot(path), initial.endOffset, state)
    expect(unchanged.events).toEqual([])
    expect(unchanged.endOffset).toBe(initial.endOffset)
    appendFileSync(path, zstd(record('r2')))
    const appended = await new CodexAdapter({ roots: root }).readIncremental(snapshot(path), initial.endOffset, state)
    expect(appended.events.map(event => event.id)).toEqual(['codex:sample-session:r2'])
    expect(appended.events[0]!.model).toBe('gpt-5.6-sol')
    expect(JSON.stringify(appended.state)).not.toContain('world_state')
  })

  it('does not skip new records when a whole archive is recompressed smaller', async () => {
    const path = make(zstd(meta() + context() + record()))
    const adapter = new CodexAdapter({ roots: root })
    const first = await adapter.readIncremental(snapshot(path), 0)
    writeFileSync(path, zstd(meta() + context() + record() + record('r2')))
    const next = await adapter.readIncremental(snapshot(path), first.endOffset, first.state)
    expect(next.events.map(event => event.id)).toEqual(['codex:sample-session:r2'])
  })

  it('replays safely on changed prefix, truncation, replacement or a lost cursor state', async () => {
    const path = make(zstd(meta() + context() + record()))
    const adapter = new CodexAdapter({ roots: root })
    const first = await adapter.readIncremental(snapshot(path), 0)
    writeFileSync(path, zstd(meta() + context('example-other') + record('other')))
    const rewritten = await adapter.readIncremental(snapshot(path), first.endOffset, first.state)
    expect(rewritten.events[0]).toMatchObject({ id: 'codex:sample-session:other', model: 'example-other' })
    renameSync(path, path + '.old')
    writeFileSync(path, zstd(meta() + context() + record()))
    expect((await adapter.readIncremental(snapshot(path), first.endOffset, first.state)).events).toHaveLength(1)
    expect((await adapter.readIncremental(snapshot(path), first.endOffset)).events).toHaveLength(1)
    writeFileSync(path, zstd(meta()))
    const truncated = await adapter.readIncremental(snapshot(path), first.endOffset, first.state)
    expect(truncated.events).toEqual([])
    expect(truncated.endOffset).toBe(Buffer.byteLength(meta()))
  })

  it('keeps incomplete frames and UTF-8 lines pending until fully committed', async () => {
    const prefix = meta() + context()
    const row = record('unicode-记录')
    const bytes = Buffer.from(row)
    const split = bytes.indexOf(Buffer.from('记录')) + 1
    const last = zstd(bytes.subarray(split))
    const path = make(Buffer.concat([zstd(prefix), zstd(bytes.subarray(0, split)), last.subarray(0, -2)]))
    const adapter = new CodexAdapter({ roots: root })
    const first = await adapter.readIncremental(snapshot(path), 0)
    expect(first.events).toHaveLength(0)
    expect(first.endOffset).toBe(Buffer.byteLength(prefix))
    appendFileSync(path, last.subarray(-2))
    const next = await adapter.readIncremental(snapshot(path), first.endOffset, first.state)
    expect(next.events[0]!.id).toBe('codex:sample-session:unicode-记录')
  })

  it('reports unreadable compressed data as unrecognized rather than empty', async () => {
    make(Buffer.from('bad Zstandard data'))
    const result = await probeAdapter(new CodexAdapter({ roots: root }))
    expect(result).toMatchObject({ status: 'unrecognized', fileCount: 1 })
  })

  it('does not count mirrored plain/packed logs twice or lose old indexed events', async () => {
    const content = meta() + context() + record()
    const plain = make(content, 'rollout-mirror.jsonl')
    const store = Store.open(join(root, 'test.db'))
    const scheduler = new UsageScheduler({ store, adapters: [new CodexAdapter({ roots: root })] })
    try {
      expect((await scheduler.tick()).agents[0]!.inserted).toBe(1)
      const baseline = store.overview({ from: 0, to: 8e15 }).totals
      const packed = make(zstd(content), 'rollout-mirror.jsonl.zst')
      expect((await scheduler.tick()).agents[0]!.inserted).toBe(0)
      rmSync(plain)
      expect((await scheduler.tick()).agents[0]!.inserted).toBe(0)
      expect(store.overview({ from: 0, to: 8e15 }).totals).toEqual(baseline)
      appendFileSync(packed, zstd(record('new-request')))
      expect((await scheduler.tick()).agents[0]!.inserted).toBe(1)
      expect(store.eventCount()).toBe(2)
      expect((await scheduler.tick()).agents[0]!.inserted).toBe(0)
    } finally { store.close() }
  })

  it('keeps the first legacy accounting record when a later snapshot repeats its key with zero usage', async () => {
    const original = legacy()
    const repeated = JSON.parse(original)
    repeated.payload.info.last_token_usage = {
      input_tokens: 0, output_tokens: 0, cached_input_tokens: 0, reasoning_output_tokens: 0
    }
    const path = make(zstd(meta() + context() + original + JSON.stringify(repeated) + '\n'))
    const store = Store.open(join(root, 'test.db'))
    try {
      const adapter = new CodexAdapter({ roots: root })
      const result = await adapter.readIncremental(snapshot(path), 0)
      expect(result.events).toHaveLength(2)
      expect(result.events[0]!.id).toBe(result.events[1]!.id)
      expect(store.insertEvents(result.events)).toEqual({ inserted: 1, skipped: 1 })
      const totals = store.overview({ from: 0, to: 8e15 }).totals
      expect(totals.total).toBe(120)
      expect(totals.cacheRead).toBe(80)
      const reread = await adapter.readIncremental(snapshot(path), result.endOffset, result.state)
      expect(reread.events).toEqual([])
    } finally { store.close() }
  })

  it('preserves the saved cursor when a later compressed frame is corrupt', async () => {
    const path = make(zstd(meta() + context() + record()))
    const store = Store.open(join(root, 'test.db'))
    const adapter = new CodexAdapter({ roots: root })
    const scheduler = new UsageScheduler({ adapters: [adapter], store })
    try {
      await scheduler.tick()
      const file = adapter.discover()[0]!
      const offset = store.getFileOffset('codex', file.path)
      const before = readFileSync(path)
      const bad = zstd(record('bad'))
      bad[bad.length - 1] = bad[bad.length - 1]! ^ 1
      appendFileSync(path, bad)
      const result = await scheduler.tick()
      expect(result.agents[0]!.errors).toHaveLength(1)
      expect(store.eventCount()).toBe(1)
      expect(store.getFileOffset('codex', file.path)).toBe(offset)
      expect(readFileSync(path)).toEqual(Buffer.concat([before, bad]))
    } finally { store.close() }
  })
})
