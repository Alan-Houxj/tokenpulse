import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import * as codex from '@core/adapters/codex'
import { scanCodexLog } from '@core/adapters/codex-log'
import { normalizePathKey } from '@core/adapters/util'
import { collectLiveAgents, __internals } from '@core/engine/live'
import type { Store } from '@core/store/sqlite'

vi.mock('@core/adapters/codex-log', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@core/adapters/codex-log')>()
  return { ...actual, scanCodexLog: vi.fn(actual.scanCodexLog) }
})
vi.mock('node:sqlite', () => ({
  DatabaseSync: class {
    constructor() { throw new Error('Live tests must not open a real database') }
  }
}))

const now = Date.UTC(2026, 9, 18, 12)
const hour = 60 * 60_000
let dir: string
let root: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tp-codex-live-'))
  root = join(dir, 'codex')
  vi.stubEnv('CODEX_HOME', root)
})
afterEach(() => {
  vi.clearAllMocks()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  rmSync(dir, { recursive: true, force: true })
})

function record(ts: number, type: string, payload: Record<string, unknown>) {
  return { timestamp: new Date(ts).toISOString(), type, payload }
}

function activity(sessionId = 'session-test') {
  return [
    record(now - 90_000, 'session_meta', { session_id: sessionId, id: 'native-thread', cwd: 'C:/work/project' }),
    record(now - 80_000, 'turn_context', { model: 'gpt-5.6-sol', cwd: 'C:/work/project' }),
    record(now - 60_000, 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Fix the login page' }] }),
    record(now - 20_000, 'token_usage_record', {
      response_id: 'response-test', usage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 10 }
    }),
    record(now - 5_000, 'response_item', { type: 'custom_tool_call', name: 'read_file' })
  ]
}

function log(name: string, records: unknown[], mtimeMs = now - 5_000, sourceRoot = root): string {
  const path = join(sourceRoot, 'sessions', name)
  const bytes = Buffer.from(records.map((value) => JSON.stringify(value)).join('\n') + '\n')
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, name.endsWith('.zst') ? zstdCompressSync(bytes) : bytes)
  utimesSync(path, new Date(mtimeMs), new Date(mtimeMs))
  return normalizePathKey(path)
}

function onlyFile() {
  const files = codex.discoverCodexLogs([root])
  expect(files).toHaveLength(1)
  return files[0]!
}

describe('Codex live compressed transport', () => {
  it('produces equivalent plain and compressed cards using injected roots', async () => {
    const plainRoot = join(dir, 'plain')
    const compressedRoot = join(dir, 'compressed')
    const plain = log('rollout-test.jsonl', activity(), now - 5_000, plainRoot)
    const compressed = log('rollout-test.jsonl.zst', activity(), now - 5_000, compressedRoot)
    const plainCards = await __internals.codexLive(now, [plainRoot])
    const compressedCards = await __internals.codexLive(now, [compressedRoot])
    expect(plainCards).toHaveLength(1)
    expect(compressedCards).toHaveLength(1)
    expect(compressedCards[0]).toEqual({ ...plainCards[0], logFilePath: compressed })
    expect(plainCards[0]).toMatchObject({
      sessionId: 'session-test', projectName: 'project', projectPath: 'C:/work/project',
      model: 'gpt-5.6-sol', status: 'tool', taskStartTs: now - 60_000,
      lastActivityTs: now - 5_000, taskTokens: 130, rateTokensPerSec: 0, logFilePath: plain
    })
  })

  it('reuses an unchanged compressed tail but recomputes time-dependent card state', async () => {
    log('rollout-cached.jsonl.zst', activity())
    const first = await __internals.codexLive(now, [root])
    const file = onlyFile()
    const tail = await codex.readCodexLogTail(file)
    const second = await __internals.codexLive(now + 30_000, [root])
    const third = await __internals.codexLive(now + 60_000, [root])
    expect(scanCodexLog).toHaveBeenCalledTimes(1)
    expect(await codex.readCodexLogTail(file)).toBe(tail)
    expect(first[0]?.status).toBe('tool')
    expect(second[0]).toMatchObject({ status: 'idle', polledAt: now + 30_000 })
    expect(third[0]).toMatchObject({ status: 'idle', polledAt: now + 60_000 })
  })

  it('reuses the compressed tail already populated by adapter ingestion', async () => {
    log('rollout-ingested.jsonl.zst', activity())
    const adapter = new codex.CodexAdapter({ roots: [root] })
    await adapter.readIncremental(onlyFile(), 0)
    expect(scanCodexLog).toHaveBeenCalledTimes(1)
    const cards = await __internals.codexLive(now, [root])
    expect(cards[0]).toMatchObject({ sessionId: 'session-test', status: 'tool' })
    expect(scanCodexLog).toHaveBeenCalledTimes(1)
  })

  it('refreshes a cached compressed tail when its file changes', async () => {
    log('rollout-changing.jsonl.zst', activity())
    await __internals.codexLive(now, [root])
    log('rollout-changing.jsonl.zst', [
      ...activity(), record(now + 1_000, 'event_msg', { type: 'error', message: 'connection reset' })
    ], now + 1_000)
    const cards = await __internals.codexLive(now + 2_000, [root])
    expect(scanCodexLog).toHaveBeenCalledTimes(2)
    expect(cards[0]).toMatchObject({ status: 'error', lastActivityTs: now + 1_000 })
    expect(cards[0]?.anomaly).toContain('connection reset')
  })

  it('filters by mtime, sorts and caps at six files before reading any tail', async () => {
    const paths: string[] = []
    for (let i = 7; i >= 0; i--) {
      paths[i] = log(`rollout-${i}.jsonl.zst`, activity(`session-${i}`), now - i * 1_000)
    }
    log('rollout-exact-hour.jsonl.zst', activity('excluded'), now - hour)
    const readTail = vi.spyOn(codex, 'readCodexLogTail')
    const cards = await __internals.codexLive(now, [root])
    expect(cards.map((card) => card.sessionId)).toEqual([
      'session-0', 'session-1', 'session-2', 'session-3', 'session-4', 'session-5'
    ])
    expect(readTail.mock.calls.map(([file]) => file.path)).toEqual(paths.slice(0, 6))
    expect(scanCodexLog).toHaveBeenCalledTimes(6)
  })

  it.each([hour, hour + 1, 24 * hour])('excludes recompressed history with records %i ms old', async (age) => {
    log('rollout-history.jsonl.zst', [record(now - age, 'event_msg', { type: 'task_complete' })], now)
    expect(await __internals.codexLive(now, [root])).toEqual([])
  })

  it('uses the record timestamp for compressed activity inside the one-hour window', async () => {
    const lastTs = now - hour + 1
    log('rollout-near-hour.jsonl.zst', [record(lastTs, 'event_msg', { type: 'task_complete' })], now)
    const cards = await __internals.codexLive(now, [root])
    expect(cards).toHaveLength(1)
    expect(cards[0]).toMatchObject({ status: 'idle', lastActivityTs: lastTs })
  })

  it('retains plain-log mtime admission and activity semantics', async () => {
    log('rollout-plain-history.jsonl', [record(now - 2 * hour, 'event_msg', { type: 'task_complete' })], now)
    const cards = await __internals.codexLive(now, [root])
    expect(cards).toHaveLength(1)
    expect(cards[0]).toMatchObject({ status: 'idle', lastActivityTs: now - 1_000 })
  })

  it('skips a broken compressed file without hiding a healthy session', async () => {
    const broken = log('rollout-broken.jsonl.zst', [], now)
    writeFileSync(broken, Buffer.from('not a zstandard frame'))
    utimesSync(broken, new Date(now), new Date(now))
    const healthy = log('rollout-healthy.jsonl.zst', activity('healthy'), now - 1_000)
    const cards = await __internals.codexLive(now, [root])
    expect(cards).toHaveLength(1)
    expect(cards[0]).toMatchObject({ sessionId: 'healthy', logFilePath: healthy, status: 'tool' })
  })

  it.each(['.jsonl', '.jsonl.zst'])('uses cached header metadata without replaying activity outside the %s tail', async (extension) => {
    log(`rollout-long${extension}`, [
      record(now - 3 * hour, 'session_meta', { id: 'header-id', cwd: 'C:/work/header-project' }),
      record(now - 3 * hour, 'turn_context', { model: 'gpt-5.6-sol' }),
      record(now - 180_000, 'response_item', { type: 'message', role: 'user', content: [{ text: 'Previous task' }] }),
      record(now - 150_000, 'token_usage_record', { usage: { input_tokens: 999 } }),
      record(now - 120_000, 'event_msg', { type: 'error', message: 'Previous error' }),
      record(now - 90_000, 'response_item', { type: 'message', role: 'assistant', content: [{ text: 'x'.repeat(70 * 1024) }] }),
      record(now - 60_000, 'event_msg', { type: 'task_complete' })
    ], now - 60_000)
    const cards = await __internals.codexLive(now, [root])
    expect(cards).toHaveLength(1)
    expect(cards[0]).toMatchObject({
      sessionId: 'header-id', model: 'gpt-5.6-sol', projectName: 'header-project',
      status: 'idle', taskStartTs: now - 60_000 - 30 * 60_000, taskTokens: 0, anomaly: undefined
    })
  })
})

describe('Codex live identity and existing rules', () => {
  it.each([
    [{ session_id: 'legacy-id', id: 'native-id' }, 'legacy-id'],
    [{ id: 'native-id' }, 'native-id'],
    [{ session_id: '', id: 'native-id' }, 'native-id']
  ])('resolves session metadata %j to %s', (metadata, sessionId) => {
    const card = __internals.codexLinesCard('C:\\logs\\rollout-test.jsonl.zst', now, now, {
      lines: [JSON.stringify(record(now - 1_000, 'session_meta', metadata))], sessionId: 'cached-id'
    })
    expect(card?.sessionId).toBe(sessionId)
  })

  it.each(['C:\\logs\\rollout-test.jsonl', 'C:\\logs\\rollout-test.jsonl.zst', '/logs/rollout-test.jsonl.zst'])('uses a canonical filename fallback for %s', (path) => {
    const card = __internals.codexLinesCard(path, now, now, {
      lines: [JSON.stringify(record(now - 1_000, 'event_msg', { type: 'task_complete' }))]
    })
    expect(card?.sessionId).toBe('rollout-test.jsonl')
  })

  it('keeps the legacy file-card entry point synchronous', () => {
    const path = log('rollout-sync.jsonl', activity())
    const card = __internals.codexFileCard(path, statSync(path).size, now, now)
    expect(card).not.toBeInstanceOf(Promise)
    expect(card).toMatchObject({ sessionId: 'session-test', status: 'tool', taskTokens: 130 })
  })

  it.each([
    ['response_item', { type: 'function_call', name: 'read_file' }, 19_999, 'tool'],
    ['response_item', { type: 'function_call', name: 'read_file' }, 20_000, 'idle'],
    ['event_msg', { type: 'task_complete' }, 30_000, 'thinking'],
    ['event_msg', { type: 'task_complete' }, 30_001, 'idle'],
    ['event_msg', { type: 'stream_error', message: 'failed' }, 299_999, 'error'],
    ['event_msg', { type: 'stream_error', message: 'failed' }, 300_000, 'idle']
  ] as const)('preserves %s/%j status at %i ms', (type, payload, age, status) => {
    const card = __internals.codexLinesCard('/logs/rollout-rules.jsonl.zst', now, now, {
      lines: [JSON.stringify(record(now - age, type, payload))]
    })
    expect(card?.status).toBe(status)
  })

  it('only suppresses generic Codex cards matching a direct Codex session', async () => {
    log('rollout-direct.jsonl.zst', activity('shared-session'))
    vi.spyOn(Date, 'now').mockReturnValue(now)
    const recentSessionsForLive = vi.fn(() => [
      { agent: 'codex', sessionId: 'shared-session', model: 'gpt-5.6-sol', lastTs: now - 50_000, tokens: 999 },
      { agent: 'codex', sessionId: 'fallback-session', model: 'gpt-5.6-sol', lastTs: now - 60_000, tokens: 20 },
      { agent: 'claude-code', sessionId: 'shared-session', model: 'claude', lastTs: now - 45_000, tokens: 30 },
      { agent: 'dsh', sessionId: 'shared-session', model: 'dsh', lastTs: now - 10_000, tokens: 40 },
      { agent: 'zcode', sessionId: 'shared-session', model: 'zcode', lastTs: now - 10_000, tokens: 50 }
    ])
    const pending = collectLiveAgents({ recentSessionsForLive } as unknown as Store)
    expect(pending).toBeInstanceOf(Promise)
    const cards = await pending
    expect(recentSessionsForLive).toHaveBeenCalledWith(hour, now)
    expect(cards).toHaveLength(4)
    expect(cards.filter((card) => card.agent === 'codex' && card.sessionId === 'shared-session')).toHaveLength(1)
    expect(cards).toEqual(expect.arrayContaining([
      expect.objectContaining({ agent: 'codex', sessionId: 'shared-session', status: 'tool', taskTokens: 130 }),
      expect.objectContaining({ agent: 'codex', sessionId: 'fallback-session', status: 'idle', taskTokens: 20 }),
      expect.objectContaining({ agent: 'claude-code', sessionId: 'shared-session', status: 'idle', taskTokens: 30 }),
      expect.objectContaining({ agent: 'dsh', sessionId: 'shared-session', status: 'thinking', taskTokens: 40 })
    ]))
  })
})
