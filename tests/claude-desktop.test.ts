import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { ClaudeCodeAdapter } from '@core/adapters/claude-code'
import { ClaudeDesktopAdapter } from '@core/adapters/claude-desktop'
import { normalizePathKey } from '@core/adapters/util'

let dir: string

const usage = {
  input_tokens: 120,
  output_tokens: 37,
  cache_read_input_tokens: 400,
  cache_creation_input_tokens: 80
}

function assistant(overrides: Record<string, unknown> = {}) {
  return {
    type: 'assistant',
    sessionId: 'synthetic-session',
    uuid: 'synthetic-block-1',
    timestamp: '2026-10-01T12:00:00.000Z',
    cwd: 'C:/synthetic/work',
    entrypoint: 'local-agent',
    apiBlockIndex: 0,
    message: {
      id: 'msg_synthetic_1',
      model: 'claude-sonnet-4-5',
      role: 'assistant',
      stop_reason: 'end_turn',
      content: [],
      usage: { ...usage }
    },
    ...overrides
  }
}

function message(overrides: Record<string, unknown>) {
  return { ...assistant().message, ...overrides }
}

function transcript(root: string, surface = 'local-agent-mode-sessions', name = 'synthetic.jsonl') {
  return join(root, surface, 'aaaaaaaa', 'bbbbbbbb', 'cccccccc', '.claude', 'projects', 'session', name)
}

function writeRows(path: string, rows: unknown[]) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, rows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8')
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tokenpulse-claude-desktop-'))
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(dir, { recursive: true, force: true })
})

describe('ClaudeDesktopAdapter', () => {
  it('reads settled canonical Cowork usage without subtracting or double-counting cache or thinking', async () => {
    const root = join(dir, 'Claude-3p')
    writeRows(transcript(root), [
      { type: 'user', sessionId: 'synthetic-session', message: { role: 'user', content: [] } },
      assistant({
        costUSD: 0.0042,
        durationMs: 500,
        message: message({
          stop_reason: 'tool_use',
          usage: { ...usage, output_tokens_details: { thinking_tokens: 11 }, cache_creation: { ephemeral_5m_input_tokens: 80 } }
        })
      })
    ])
    const adapter = new ClaudeDesktopAdapter({ roots: root })
    const files = adapter.discover()
    expect(files).toHaveLength(1)
    const result = await adapter.readIncremental(files[0]!, 0)
    expect(result.recognized).toBe(true)
    expect(result.events).toHaveLength(1)
    expect(result.events[0]).toMatchObject({
      id: 'claude-code:synthetic-session:msg_synthetic_1',
      agent: 'claude-desktop',
      sessionId: 'synthetic-session',
      model: 'claude-sonnet-4-5',
      ts: Date.parse('2026-10-01T12:00:00.000Z'),
      projectPath: 'C:/synthetic/work',
      costUSD: 0.0042,
      costEstUSD: 0,
      durationMs: 500,
      tokens: { input: 120, output: 37, reasoning: 0, cacheRead: 400, cacheWrite: 80 }
    })
    const probe = await adapter.probe()
    expect(probe.status).toBe('ok')
    expect(probe.sessionCount).toBe(1)
    expect(probe.detail).toContain('普通 Desktop 聊天')
  })

  it('discovers only bounded Code/Cowork canonical transcripts, including subagents', () => {
    const root = join(dir, 'Claude')
    const cowork = transcript(root)
    const code = transcript(root, 'claude-code-sessions', 'synthetic-code.jsonl')
    const subagent = join(dirname(code), 'dddddddd-dddd-4000-8000-eeeeeeeeeeee', 'subagents', 'agent-synthetic.jsonl')
    const allowed = [cowork, code, subagent]
    for (const path of allowed) writeRows(path, [assistant()])
    const scratch = join(root, 'local-agent-mode-sessions', 'aaaaaaaa', 'bbbbbbbb', 'cccccccc')
    for (const path of [
      join(scratch, 'audit.jsonl'),
      join(scratch, '.claude', 'debug', 'debug.jsonl'),
      join(scratch, 'outputs', '.claude', 'projects', 'session', 'not-a-transcript.jsonl'),
      join(root, 'IndexedDB', 'ordinary-chat.jsonl'),
      join(root, 'Local Storage', 'chat.jsonl'),
      join(root, 'logs', 'cli-diagnostics.jsonl'),
      join(root, '.claude', 'projects', 'session', 'terminal.jsonl'),
      join(root, 'local-agent-mode-sessions', 'aaaaaaaa', 'bbbbbbbb', 'cccccccc', 'dddddddd', 'eeeeeeee', 'ffffffff', '.claude', 'projects', 'session', 'too-deep.jsonl')
    ]) writeRows(path, [assistant()])
    const adapter = new ClaudeDesktopAdapter({ roots: root })
    expect(adapter.discover().map((file) => file.path).sort()).toEqual(allowed.map(normalizePathKey).sort())
  })

  it('deduplicates content blocks and copied roots using message ID, not row UUID', async () => {
    const root = join(dir, 'Claude-3p')
    const row = assistant()
    writeRows(transcript(root), [
      row,
      assistant({ uuid: 'synthetic-block-2', apiBlockIndex: 1 }),
      assistant({ uuid: 'synthetic-replay', isReplay: true })
    ])
    const copyRoot = join(dir, 'Claude-copy')
    writeRows(transcript(copyRoot), [row])
    const adapter = new ClaudeDesktopAdapter({ roots: [root, root, copyRoot] })
    const files = adapter.discover()
    expect(files).toHaveLength(2)
    const results = await Promise.all(files.map((file) => adapter.readIncremental(file, 0)))
    expect(results.map((result) => result.events.length)).toEqual([1, 1])
    expect(new Set(results.flatMap((result) => result.events.map((event) => event.id))).size).toBe(1)
  })

  it.each([undefined, 'req_synthetic_1'])('shares the existing Claude Code identity with request ID %s', async (requestId) => {
    const desktopRoot = join(dir, 'Claude')
    const cliRoot = join(dir, '.claude')
    const row = assistant({ requestId })
    writeRows(transcript(desktopRoot), [row])
    writeRows(join(cliRoot, 'projects', 'synthetic-project', 'synthetic-session.jsonl'), [row])
    const desktop = new ClaudeDesktopAdapter({ roots: desktopRoot })
    const cli = new ClaudeCodeAdapter({ roots: cliRoot })
    const desktopResult = await desktop.readIncremental(desktop.discover()[0]!, 0)
    const cliResult = await cli.readIncremental(cli.discover()[0]!, 0)
    expect(desktopResult.events[0]!.id).toBe(cliResult.events[0]!.id)
    expect(desktopResult.events[0]!.agent).toBe('claude-desktop')
    expect(new ClaudeDesktopAdapter({ roots: cliRoot }).discover()).toEqual([])
  })

  it('never converts missing, malformed, estimated, streaming, synthetic-error, or replay usage into zero', async () => {
    const root = join(dir, 'Claude')
    writeRows(transcript(root), [
      assistant({ message: message({ usage: undefined }) }),
      assistant({ message: message({ usage: {} }) }),
      assistant({ message: message({ usage: { estimated_tokens: 100 } }) }),
      assistant({ message: message({ usage: { input_tokens: 3, output_tokens: 4 } }) }),
      assistant({ message: message({ usage: { ...usage, input_tokens: '120' } }) }),
      assistant({ message: message({ usage: { ...usage, output_tokens: null } }) }),
      assistant({ message: message({ usage: { ...usage, cache_read_input_tokens: -1 } }) }),
      assistant({ message: message({ usage: { ...usage, cache_creation_input_tokens: 1.5 } }) }),
      assistant({ message: message({ usage: { ...usage, input_tokens: Number.MAX_SAFE_INTEGER + 1 } }) }),
      assistant({ message: message({ stop_reason: null }) }),
      assistant({ message: message({ stop_reason: undefined }) }),
      assistant({ message: message({ model: '<synthetic>', usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }) }),
      assistant({ isApiErrorMessage: true }),
      assistant({ is_api_error_message: true }),
      assistant({ error: 'synthetic-test-error' }),
      assistant({ isReplay: true }),
      assistant({ timestamp: 'not-a-timestamp' }),
      assistant({ sessionId: '' }),
      assistant({ message: message({ id: undefined }) }),
      { type: 'system', subtype: 'token_estimate', estimated_tokens: 100 },
      { type: 'result', session_id: 'synthetic-session', usage, modelUsage: { synthetic: usage } }
    ])
    const adapter = new ClaudeDesktopAdapter({ roots: root })
    const result = await adapter.readIncremental(adapter.discover()[0]!, 0)
    expect(result.recognized).toBe(true)
    expect(result.events).toEqual([])
    expect((await adapter.probe()).status).toBe('unsupported')
  })

  it('preserves explicitly recorded zero counters on a settled non-error message', async () => {
    const root = join(dir, 'Claude')
    writeRows(transcript(root), [assistant({ message: message({ usage: {
      input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0
    } }) })])
    const adapter = new ClaudeDesktopAdapter({ roots: root })
    const result = await adapter.readIncremental(adapter.discover()[0]!, 0)
    expect(result.events).toHaveLength(1)
    expect(result.events[0]!.tokens).toEqual({ input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 })
  })

  it('reports a detected ordinary-chat-only profile as unsupported, not empty or zero', async () => {
    const root = join(dir, 'Claude')
    writeRows(join(root, 'IndexedDB', 'synthetic-chat.jsonl'), [assistant()])
    writeRows(join(root, 'logs', 'main.log'), [assistant()])
    writeRows(join(root, 'claude_desktop_config.json'), [{ synthetic: true }])
    const adapter = new ClaudeDesktopAdapter({ roots: root })
    expect(adapter.discover()).toEqual([])
    const result = await adapter.probe()
    expect(result.status).toBe('unsupported')
    expect(result.fileCount).toBe(0)
    expect(result.sessionCount).toBeUndefined()
    expect(result.detail).toContain('不计为零')
  })

  it('distinguishes absent data and an unrecognized canonical transcript', async () => {
    const root = join(dir, 'Claude-missing')
    const adapter = new ClaudeDesktopAdapter({ roots: root })
    expect((await adapter.probe()).status).toBe('absent')
    writeRows(transcript(root), [{ unrelated: true }, null, []])
    expect((await adapter.probe()).status).toBe('unrecognized')
  })

  it('supports profile/surface root overrides without falling back to global Claude data', () => {
    const root = join(dir, 'custom-profile')
    const path = transcript(root)
    writeRows(path, [assistant()])
    const surface = join(root, 'local-agent-mode-sessions')
    const adapter = new ClaudeDesktopAdapter({ roots: [root, `${root}/`, surface, ' '] })
    expect(adapter.defaultRoots()).toEqual([resolve(root), resolve(surface)])
    expect(adapter.discover()).toHaveLength(1)
    expect(new ClaudeDesktopAdapter({ roots: root }).defaultRoots()).toEqual([resolve(root)])
    expect(new ClaudeDesktopAdapter({ roots: surface }).discover()).toHaveLength(1)
  })

  it('resumes complete JSONL lines and retains stable identities across append and truncation', async () => {
    const root = join(dir, 'Claude')
    const path = transcript(root)
    writeRows(path, [assistant()])
    const adapter = new ClaudeDesktopAdapter({ roots: root })
    const [file] = adapter.discover()
    const first = await adapter.readIncremental(file!, 0)
    appendFileSync(path, JSON.stringify(assistant({ uuid: 'synthetic-block-2', apiBlockIndex: 1 })) + '\n')
    const repeated = await adapter.readIncremental(file!, first.endOffset, first.state)
    expect(repeated.events[0]!.id).toBe(first.events[0]!.id)

    const nextRow = JSON.stringify(assistant({ message: message({ id: 'msg_synthetic_2' }) }))
    appendFileSync(path, nextRow)
    const incomplete = await adapter.readIncremental(file!, repeated.endOffset, repeated.state)
    expect(incomplete.events).toEqual([])
    expect(incomplete.endOffset).toBe(repeated.endOffset)
    appendFileSync(path, '\n')
    const complete = await adapter.readIncremental(file!, incomplete.endOffset, incomplete.state)
    expect(complete.events[0]!.id).toBe('claude-code:synthetic-session:msg_synthetic_2')

    writeRows(path, [assistant({ message: message({ id: 'msg_synthetic_3' }) })])
    const truncated = await adapter.readIncremental(file!, complete.endOffset, complete.state)
    expect(truncated.events[0]!.id).toBe('claude-code:synthetic-session:msg_synthetic_3')
  })

  it('persists bounded fingerprints and keeps unchanged rereads empty across adapter instances', async () => {
    const root = join(dir, 'Claude')
    const path = transcript(root)
    writeRows(path, [assistant()])
    const adapter = new ClaudeDesktopAdapter({ roots: root })
    const [file] = adapter.discover()
    const first = await adapter.readIncremental(file!, 0)
    const state = JSON.parse(JSON.stringify(first.state))
    expect(state).toMatchObject({
      version: 1,
      offset: first.endOffset,
      prefix: expect.stringMatching(/^[a-f0-9]{64}$/),
      boundary: expect.stringMatching(/^[a-f0-9]{64}$/)
    })
    expect(JSON.stringify(state).length).toBeLessThan(2048)
    expect(JSON.stringify(state)).not.toContain('msg_synthetic_1')
    const restored = new ClaudeDesktopAdapter({ roots: root })
    const unchanged = await restored.readIncremental(file!, first.endOffset, state)
    expect(unchanged.events).toEqual([])
    expect(unchanged.endOffset).toBe(first.endOffset)
    expect(unchanged.recognized).toBe(true)
    appendFileSync(path, JSON.stringify(assistant({ message: message({ id: 'msg_synthetic_2' }) })) + '\n')
    const appended = await restored.readIncremental(file!, unchanged.endOffset, unchanged.state)
    expect(appended.events.map((event) => event.id)).toEqual(['claude-code:synthetic-session:msg_synthetic_2'])
  })

  it.each(['prefix', 'boundary'] as const)('replays equal-size rewrites when the %s fingerprint changes', async (location) => {
    const root = join(dir, 'Claude')
    const path = transcript(root)
    const filler = { type: 'user', message: { content: 'x'.repeat(12000) } }
    const initial = assistant()
    const replacement = assistant({ message: message({ id: 'msg_synthetic_2' }) })
    writeRows(path, location === 'prefix' ? [initial, filler] : [filler, initial])
    const adapter = new ClaudeDesktopAdapter({ roots: root })
    const [file] = adapter.discover()
    const first = await adapter.readIncremental(file!, 0)
    writeRows(path, location === 'prefix' ? [replacement, filler] : [filler, replacement])
    expect(statSync(path).size).toBe(file!.size)
    const stat = statSync(path)
    // Keep state metadata equal to prove the bounded content fingerprint detects the rewrite.
    const state = { ...JSON.parse(JSON.stringify(first.state)), mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs }
    const rewritten = await adapter.readIncremental(file!, first.endOffset, state)
    expect(rewritten.events.map((event) => event.id)).toEqual(['claude-code:synthetic-session:msg_synthetic_2'])
    const unchanged = await adapter.readIncremental(file!, rewritten.endOffset, rewritten.state)
    expect(unchanged.events).toEqual([])
  })

  it('replays same-size middle rewrites when unchanged fingerprints have newer file metadata', async () => {
    const root = join(dir, 'Claude')
    const path = transcript(root)
    const filler = { type: 'user', message: { content: 'x'.repeat(9000) } }
    writeRows(path, [filler, assistant(), filler])
    const adapter = new ClaudeDesktopAdapter({ roots: root })
    const [file] = adapter.discover()
    const first = await adapter.readIncremental(file!, 0)
    writeRows(path, [filler, assistant({ message: message({ id: 'msg_synthetic_2' }) }), filler])
    const later = new Date(statSync(path).mtimeMs + 5000)
    utimesSync(path, later, later)
    expect(statSync(path).size).toBe(file!.size)
    const rewritten = await adapter.readIncremental(file!, first.endOffset, first.state)
    expect(rewritten.events.map((event) => event.id)).toEqual(['claude-code:synthetic-session:msg_synthetic_2'])
  })

  it('replays repeated larger rewrites that settle earlier messages behind the saved offset', async () => {
    const root = join(dir, 'Claude')
    const path = transcript(root)
    const pending = (id: string) => assistant({ message: message({ id, stop_reason: null }) })
    const settled = (id: string) => assistant({ message: message({ id }) })
    writeRows(path, [pending('msg_synthetic_1')])
    const adapter = new ClaudeDesktopAdapter({ roots: root })
    const [file] = adapter.discover()
    const first = await adapter.readIncremental(file!, 0)
    expect(first.events).toEqual([])
    writeRows(path, [settled('msg_synthetic_1'), pending('msg_synthetic_2')])
    expect(statSync(path).size).toBeGreaterThan(file!.size)
    const second = await adapter.readIncremental(file!, first.endOffset, first.state)
    expect(second.events.map((event) => event.id)).toEqual(['claude-code:synthetic-session:msg_synthetic_1'])
    writeRows(path, [settled('msg_synthetic_1'), settled('msg_synthetic_2'), settled('msg_synthetic_3')])
    const third = await adapter.readIncremental(file!, second.endOffset, second.state)
    expect(third.events.map((event) => event.id)).toEqual([
      'claude-code:synthetic-session:msg_synthetic_1',
      'claude-code:synthetic-session:msg_synthetic_2',
      'claude-code:synthetic-session:msg_synthetic_3'
    ])
    expect(new Set([...second.events, ...third.events].map((event) => event.id)).size).toBe(3)
    expect((await adapter.readIncremental(file!, third.endOffset, third.state)).events).toEqual([])
  })

  it('replays a replaced file generation even when size and fingerprints are unchanged', async () => {
    const root = join(dir, 'Claude')
    const path = transcript(root)
    writeRows(path, [assistant()])
    const adapter = new ClaudeDesktopAdapter({ roots: root })
    const [file] = adapter.discover()
    const first = await adapter.readIncremental(file!, 0)
    renameSync(path, `${path}.previous`)
    writeRows(path, [assistant()])
    const replacement = await adapter.readIncremental(file!, first.endOffset, first.state)
    expect(replacement.events.map((event) => event.id)).toEqual(first.events.map((event) => event.id))
  })

  it('replays legacy or corrupt offset state once instead of trusting an unverified byte offset', async () => {
    const root = join(dir, 'Claude')
    const path = transcript(root)
    writeRows(path, [assistant()])
    const adapter = new ClaudeDesktopAdapter({ roots: root })
    const [file] = adapter.discover()
    const first = await adapter.readIncremental(file!, 0)
    for (const state of [undefined, {}, { version: 1, offset: first.endOffset }]) {
      const replay = await adapter.readIncremental(file!, first.endOffset, state)
      expect(replay.events.map((event) => event.id)).toEqual(first.events.map((event) => event.id))
      expect((await adapter.readIncremental(file!, replay.endOffset, replay.state)).events).toEqual([])
    }
  })

  it('preserves partial UTF-8 tails in bytes and resets an offset after truncation', async () => {
    const root = join(dir, 'Claude')
    const path = transcript(root)
    writeRows(path, [assistant()])
    const adapter = new ClaudeDesktopAdapter({ roots: root })
    const [file] = adapter.discover()
    const first = await adapter.readIncremental(file!, 0)
    const row = Buffer.from(JSON.stringify(assistant({
      message: message({ id: 'msg_synthetic_2', content: [{ type: 'text', text: '\u4e2d\u6587' }] })
    })) + '\n')
    const split = row.indexOf(Buffer.from('\u4e2d')) + 1
    expect(split).toBeGreaterThan(0)
    appendFileSync(path, row.subarray(0, split))
    const partial = await adapter.readIncremental(file!, first.endOffset, first.state)
    expect(partial.events).toEqual([])
    expect(partial.endOffset).toBe(first.endOffset)
    appendFileSync(path, row.subarray(split))
    const complete = await adapter.readIncremental(file!, partial.endOffset, partial.state)
    expect(complete.events.map((event) => event.id)).toEqual(['claude-code:synthetic-session:msg_synthetic_2'])
    expect(complete.endOffset).toBe(first.endOffset + row.length)

    writeFileSync(path, row.subarray(0, split))
    const truncatedPartial = await adapter.readIncremental(file!, complete.endOffset, complete.state)
    expect(truncatedPartial.events).toEqual([])
    expect(truncatedPartial.endOffset).toBe(0)
    appendFileSync(path, row.subarray(split))
    const recovered = await adapter.readIncremental(file!, truncatedPartial.endOffset, truncatedPartial.state)
    expect(recovered.events.map((event) => event.id)).toEqual(['claude-code:synthetic-session:msg_synthetic_2'])
    expect(recovered.endOffset).toBe(row.length)
    writeFileSync(path, '')
    const empty = await adapter.readIncremental(file!, recovered.endOffset, recovered.state)
    expect(empty.endOffset).toBe(0)
    expect(empty.events).toEqual([])
  })

  it('throws when a discovered file cannot be read instead of committing an unread offset', async () => {
    const root = join(dir, 'Claude')
    const path = transcript(root)
    writeRows(path, [assistant()])
    const adapter = new ClaudeDesktopAdapter({ roots: root })
    const [file] = adapter.discover()
    const first = await adapter.readIncremental(file!, 0)
    rmSync(path)
    await expect(adapter.readIncremental(file!, first.endOffset, first.state)).rejects.toThrow()
    mkdirSync(path)
    await expect(adapter.readIncremental(file!, first.endOffset, first.state)).rejects.toThrow()
  })

  it.skipIf(process.platform !== 'win32')('detects verified Windows local, roaming, and MSIX profile paths', () => {
    const local = join(dir, 'Local')
    const roaming = join(dir, 'Roaming')
    const custom = join(dir, 'custom')
    vi.stubEnv('LOCALAPPDATA', local)
    vi.stubEnv('APPDATA', roaming)
    vi.stubEnv('CLAUDE_USER_DATA_DIR', custom)
    const msix = join(local, 'Packages', 'Claude_syntheticfamily', 'LocalCache', 'Roaming', 'Claude')
    mkdirSync(msix, { recursive: true })
    mkdirSync(join(local, 'Packages', 'Unrelated_syntheticfamily'), { recursive: true })
    const adapter = new ClaudeDesktopAdapter()
    expect(adapter.defaultRoots()).toEqual(expect.arrayContaining([
      join(local, 'Claude-3p'), join(local, 'Claude'), join(roaming, 'Claude'), join(roaming, 'Claude-3p'), custom, msix
    ]))
    expect(adapter.defaultRoots().some((root) => root.includes('Unrelated_syntheticfamily'))).toBe(false)
    expect(adapter.defaultRoots().some((root) => /[/\\]\.claude(?:[/\\]|$)/.test(root))).toBe(false)
  })
})
