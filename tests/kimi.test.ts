import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { KimiCodeAdapter, KimiDesktopAdapter } from '@core/adapters/kimi'
import { appDataPath } from '@core/adapters/paths'
import type { DiscoveredFile } from '@core/model/types'

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, openSync: vi.fn(actual.openSync), readSync: vi.fn(actual.readSync) }
})
vi.mock('@core/adapters/paths', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@core/adapters/paths')>()
  return { ...actual, appDataPath: vi.fn(actual.appDataPath) }
})

let dir: string
const epoch = 1800000000000
const usage = { inputOther: 1200, output: 80, inputCacheRead: 800, inputCacheCreation: 40 }
const jsonl = (...records: unknown[]): string => records.map((record) => JSON.stringify(record)).join('\n') + '\n'
const metadata = (protocol = '1.5', createdAt = epoch) => ({ type: 'metadata', protocol_version: protocol, created_at: createdAt })
const begin = (uuid = 'step-example', time = epoch + 1, agentId = 'main') => ({
  type: 'context.append_loop_event', agentId, time,
  event: { type: 'step.begin', uuid, turnId: '1', step: 1 }
})
const request = (model = 'provider-model-v1', alias = 'model-alias', time = epoch + 2, agentId = 'main') => ({
  type: 'llm.request', agentId, kind: 'loop', provider: 'openai', model, modelAlias: alias, turnStep: '1.1', time
})
const recorded = (time = epoch + 3, model = 'model-alias', agentId = 'main') => ({
  type: 'usage.record', agentId, time, model, usageScope: 'turn', usage
})
const desktopState = {
  workDir: '/example/desktop-project',
  custom: { owner: 'daimon', createdBy: 'daimon-kernel-adapter', sessionKind: 'conversation', workspacePath: '/example/desktop-project' }
}

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'tokenpulse-kimi-')) })
afterEach(() => { vi.resetAllMocks(); vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }) })

function wire(root: string, records: unknown[], opts: { session?: string; agent?: string; state?: unknown } = {}): string {
  const session = join(root, 'sessions', 'workspace-example', opts.session ?? 'session-example')
  const path = join(session, 'agents', opts.agent ?? 'main', 'wire.jsonl')
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, records.length ? jsonl(...records) : '')
  if (opts.state !== undefined) writeFileSync(join(session, 'state.json'), JSON.stringify(opts.state))
  return path
}
function discovered(path: string): DiscoveredFile {
  const st = statSync(path)
  return { path, size: st.size, mtimeMs: st.mtimeMs }
}
function persisted(state: unknown): unknown { return JSON.parse(JSON.stringify(state)) }

describe('Kimi adapters', () => {
  it('uses independent verified defaults and accepts one root string', () => {
    vi.stubEnv('KIMI_CODE_HOME', '')
    expect(new KimiCodeAdapter().defaultRoots()).toEqual([join(homedir(), '.kimi-code')])
    vi.stubEnv('KIMI_CODE_HOME', join(dir, 'custom-code-home'))
    expect(new KimiCodeAdapter().defaultRoots()).toEqual([join(dir, 'custom-code-home')])
    expect(new KimiDesktopAdapter().defaultRoots()).toEqual([
      join(appDataPath('kimi-desktop'), 'daimon-share', 'daimon', 'runtime', 'kimi-code', 'home')
    ])
    expect(new KimiCodeAdapter({ roots: dir }).defaultRoots()).toEqual([dir])
    expect(new KimiDesktopAdapter({ roots: dir }).defaultRoots()).toEqual([dir])
  })

  it('discovers only session agent wires, including subagents, and deduplicates overlapping roots', () => {
    wire(dir, [metadata()])
    wire(dir, [metadata()], { agent: 'agent-0' })
    mkdirSync(join(dir, 'cache'), { recursive: true })
    writeFileSync(join(dir, 'cache', 'wire.jsonl'), jsonl(metadata(), recorded()))
    writeFileSync(join(dir, 'sessions', 'session_index.jsonl'), jsonl(recorded()))
    const adapter = new KimiCodeAdapter({ roots: [dir, dir, join(dir, 'sessions')] })
    expect(adapter.discover()).toHaveLength(2)
    expect(adapter.discover().every((file) => file.path.endsWith('/wire.jsonl'))).toBe(true)
  })

  it('parses v1.5 deltas without step.end and ignores transcript/context usage copies', async () => {
    const path = wire(dir, [
      metadata(), begin(), request(), recorded(),
      { type: 'agent.message.appended', message: { message: { content: 'private-body' }, meta: { usage } }, time: epoch + 4 },
      { type: 'context.append_loop_event', event: { type: 'step.end', uuid: 'step-example', usage }, time: epoch + 5 },
      { type: 'context.append_loop_event', event: { type: 'content.part', part: { text: 'private-body' } }, time: epoch + 6 },
      { type: 'token_counting.measured', length: 100, tokens: 2120, time: epoch + 7 },
      { contextTokens: 999999, contextUsage: 0.9 }
    ], { state: { cwd: '/example/code-project', title: 'private-title', lastPrompt: 'private-body' } })
    const result = await new KimiCodeAdapter({ roots: dir }).readIncremental(discovered(path), 0)
    expect(result.recognized).toBe(true)
    expect(result.events).toHaveLength(1)
    expect(result.events[0]).toMatchObject({
      agent: 'kimi-code', model: 'provider-model-v1', sessionId: 'session-example', ts: epoch + 3,
      projectPath: '/example/code-project', costEstUSD: 0,
      tokens: { input: 1200, output: 80, cacheRead: 800, cacheWrite: 40, reasoning: 0 }
    })
    expect(result.events[0]!.id).toMatch(/^kimi:[a-f0-9]{64}$/)
    expect(JSON.stringify(result)).not.toContain('private-body')
    expect(JSON.stringify(result)).not.toContain('private-title')
    expect(result.endOffset).toBe(statSync(path).size)
  })

  it('parses v1.4 after-step usage and session-scoped compaction without summing counters', async () => {
    const path = wire(dir, [
      metadata('1.4'), begin(), request(),
      { type: 'context.append_loop_event', event: { type: 'step.end', uuid: 'step-example', usage }, time: epoch + 3 },
      recorded(epoch + 4),
      { type: 'full_compaction.begin', time: epoch + 5 },
      { ...request('summary-provider-model', 'summary-alias', epoch + 6), kind: 'compaction', turnStep: undefined },
      { ...recorded(epoch + 7, 'summary-alias'), usageScope: 'session', usage: { ...usage, inputOther: 20, output: 5 } },
      { type: 'context.apply_compaction', summary: 'private-summary', time: epoch + 8 }
    ].map((row) => ({ ...row, agentId: undefined })), { state: desktopState })
    const result = await new KimiDesktopAdapter({ roots: dir }).readIncremental(discovered(path), 0)
    expect(result.recognized).toBe(true)
    expect(result.events).toHaveLength(2)
    expect(result.events[0]!.tokens.input).toBe(1200)
    expect(result.events[1]).toMatchObject({ agent: 'kimi-desktop', model: 'summary-provider-model', tokens: { input: 20, output: 5 } })
    expect(new Set(result.events.map((event) => event.id)).size).toBe(2)
    expect(JSON.stringify(result)).not.toContain('private-summary')
  })

  it('restores request/model and step context across chunks and a serialized cursor', async () => {
    const path = wire(dir, [metadata(), begin(), request(), { type: 'profile.bind', environmentDisclosure: { cwd: '/example/cwd' }, systemPrompt: 'private-system' }])
    const adapter = new KimiCodeAdapter({ roots: dir })
    const first = await adapter.readIncremental(discovered(path), 0)
    expect(first.events).toHaveLength(0)
    appendFileSync(path, jsonl(recorded()))
    const second = await adapter.readIncremental(discovered(path), first.endOffset, persisted(first.state))
    expect(second.events).toHaveLength(1)
    expect(second.events[0]).toMatchObject({ model: 'provider-model-v1', projectPath: '/example/cwd' })
    const full = await adapter.readIncremental(discovered(path), 0)
    expect(second.events[0]!.id).toBe(full.events[0]!.id)
    expect(JSON.stringify(second.state)).not.toContain('private-system')
    const again = await adapter.readIncremental(discovered(path), second.endOffset, persisted(second.state))
    expect(again.events).toHaveLength(0)
  })

  it('rebuilds a missing parser cursor from the prefix without re-emitting old events', async () => {
    const path = wire(dir, [metadata(), begin(), request(), recorded()])
    const adapter = new KimiCodeAdapter({ roots: dir })
    const first = await adapter.readIncremental(discovered(path), 0)
    appendFileSync(path, jsonl(recorded(epoch + 4)))
    const next = await adapter.readIncremental(discovered(path), first.endOffset)
    expect(next.events).toHaveLength(1)
    expect(next.events[0]!.ts).toBe(epoch + 4)
    expect(next.events[0]!.model).toBe('provider-model-v1')
  })

  it('resolves only matching model aliases and isolates per-agent request state', async () => {
    const path = wire(dir, [
      metadata(), begin(), request(),
      begin('sub-step', epoch + 2, 'agent-0'), request('sub-provider', 'sub-alias', epoch + 3, 'agent-0'),
      recorded(epoch + 4, 'model-alias'), recorded(epoch + 5, 'sub-alias', 'agent-0'),
      recorded(epoch + 6, 'different-alias'),
      { ...request('new-provider', 'model-alias', epoch + 7), systemPrompt: 'private-config' }, recorded(epoch + 8)
    ])
    const result = await new KimiCodeAdapter({ roots: dir }).readIncremental(discovered(path), 0)
    expect(result.events.map((event) => event.model)).toEqual(['provider-model-v1', 'sub-provider', 'different-alias', 'new-provider'])
    expect(JSON.stringify(result.state)).not.toContain('private-config')
  })

  it('uses one accounting identity for copied roots, protocols, and Desktop/Code representations', async () => {
    const codeRoot = join(dir, 'code')
    const desktopRoot = join(dir, 'desktop')
    const rows = [metadata(), begin(), request(), recorded()]
    const a = wire(codeRoot, rows, { state: { cwd: '/example/code' } })
    const b = wire(desktopRoot, [{ ...metadata(), protocol_version: '1.4' }, ...rows.slice(1).map((row) => ({ ...row, agentId: undefined }))], { session: 'copy', state: desktopState })
    const code = await new KimiCodeAdapter({ roots: codeRoot }).readIncremental(discovered(a), 0)
    const desktop = await new KimiDesktopAdapter({ roots: desktopRoot }).readIncremental(discovered(b), 0)
    expect(code.events[0]!.id).toBe(desktop.events[0]!.id)
    expect(code.events[0]!.agent).toBe('kimi-code')
    expect(desktop.events[0]!.agent).toBe('kimi-desktop')
  })

  it('preserves copied compaction identities and counts new fork usage once', async () => {
    const originalRoot = join(dir, 'original')
    const forkRoot = join(dir, 'fork')
    const rows = [metadata(), { ...request(), kind: 'compaction', turnStep: undefined }, { ...recorded(), usageScope: 'session' }]
    const a = wire(originalRoot, rows, { session: 'original-session' })
    const b = wire(forkRoot, [
      ...rows, { type: 'forked', time: epoch + 10 },
      begin('fork-step', epoch + 11), request('fork-model', 'model-alias', epoch + 12), recorded(epoch + 13)
    ], { session: 'fork-session', state: { forkedFrom: 'original-session', cwd: '/example/project' } })
    const original = await new KimiCodeAdapter({ roots: originalRoot }).readIncremental(discovered(a), 0)
    const fork = await new KimiCodeAdapter({ roots: forkRoot }).readIncremental(discovered(b), 0)
    expect(fork.events).toHaveLength(2)
    expect(fork.events[0]!.id).toBe(original.events[0]!.id)
    expect(fork.events[0]!.sessionId).toBe('original-session')
    expect(fork.events[1]!.sessionId).toBe('fork-session')
    expect(new Set([...original.events, ...fork.events].map((event) => event.id)).size).toBe(2)
  })

  it('deduplicates repeated accounting while preserving retries or repeated calls in one step', async () => {
    const record = recorded()
    const path = wire(dir, [
      metadata(), begin(), request(), record, record,
      { ...request('provider-model-v1', 'model-alias', epoch + 5), attempt: '2/10' }, recorded(epoch + 6),
      recorded(epoch + 7)
    ])
    const result = await new KimiCodeAdapter({ roots: dir }).readIncremental(discovered(path), 0)
    expect(result.events).toHaveLength(4)
    expect(result.events[0]!.id).toBe(result.events[1]!.id)
    expect(new Set(result.events.map((event) => event.id)).size).toBe(3)
  })

  it('honors Desktop ownership and leaves independently configured unknown roots separate', async () => {
    const root = join(dir, 'mixed')
    wire(root, [metadata(), begin(), request(), recorded()], { session: 'desktop', state: desktopState })
    const codeFile = wire(root, [metadata(), begin('code-step'), request(), recorded()], {
      session: 'code', state: { cwd: '/example/code', custom: { vscode_legacy_approval: { yolo: false } } }
    })
    const code = new KimiCodeAdapter({ roots: root })
    const desktop = new KimiDesktopAdapter({ roots: root })
    expect(code.discover()).toHaveLength(1)
    expect(code.discover()[0]!.path).toContain('/code/')
    expect(desktop.discover()).toHaveLength(1)
    expect(desktop.discover()[0]!.path).toContain('/desktop/')
    expect((await desktop.readIncremental(discovered(codeFile), 0)).events).toHaveLength(0)
    const codeRoot = join(dir, 'standalone')
    const desktopRoot = join(dir, 'embedded')
    wire(codeRoot, [metadata()])
    wire(desktopRoot, [metadata()])
    expect(new KimiCodeAdapter({ roots: codeRoot }).discover()[0]!.path).not.toBe(new KimiDesktopAdapter({ roots: desktopRoot }).discover()[0]!.path)
  })

  it('retains the entire unfinished UTF-8 usage line and commits byte offsets only at newline', async () => {
    const alias = 'model-\u6a21\u578b'
    const path = wire(dir, [metadata(), begin(), request('provider-unicode', alias)])
    const adapter = new KimiCodeAdapter({ roots: dir })
    const first = await adapter.readIncremental(discovered(path), 0)
    const line = Buffer.from(jsonl(recorded(epoch + 3, alias)))
    const split = line.indexOf(Buffer.from('\u6a21')) + 1
    appendFileSync(path, line.subarray(0, split))
    const partial = await adapter.readIncremental(discovered(path), first.endOffset, persisted(first.state))
    expect(partial.events).toHaveLength(0)
    expect(partial.endOffset).toBe(first.endOffset)
    appendFileSync(path, line.subarray(split, line.length - 1))
    const noNewline = await adapter.readIncremental(discovered(path), partial.endOffset, persisted(partial.state))
    expect(noNewline.endOffset).toBe(first.endOffset)
    appendFileSync(path, '\n')
    const complete = await adapter.readIncremental(discovered(path), noNewline.endOffset, persisted(noNewline.state))
    expect(complete.events).toHaveLength(1)
    expect(complete.events[0]!.model).toBe('provider-unicode')
    expect(complete.endOffset).toBe(statSync(path).size)
  })

  it('recovers an initially incomplete metadata line', async () => {
    const path = wire(dir, [])
    writeFileSync(path, '{"type":"metadata"')
    const adapter = new KimiCodeAdapter({ roots: dir })
    const first = await adapter.readIncremental(discovered(path), 0)
    expect(first.endOffset).toBe(0)
    expect(first.recognized).toBe(false)
    writeFileSync(path, jsonl(metadata(), begin(), request(), recorded()))
    const next = await adapter.readIncremental(discovered(path), first.endOffset, persisted(first.state))
    expect(next.events).toHaveLength(1)
    expect(next.recognized).toBe(true)
  })

  it('resets request state and offsets after truncation, including a new partial tail', async () => {
    const path = wire(dir, [metadata(), begin(), request(), { type: 'padding', text: 'x'.repeat(5000) }, recorded()])
    const adapter = new KimiCodeAdapter({ roots: dir })
    const first = await adapter.readIncremental(discovered(path), 0)
    writeFileSync(path, jsonl(metadata('1.4')) + '{"type":"usage.record"')
    const truncated = await adapter.readIncremental(discovered(path), first.endOffset, persisted(first.state))
    expect(truncated.events).toHaveLength(0)
    expect(truncated.endOffset).toBe(Buffer.byteLength(jsonl(metadata('1.4'))))
    writeFileSync(path, jsonl(metadata('1.4'), recorded(epoch + 20)))
    const next = await adapter.readIncremental(discovered(path), truncated.endOffset, persisted(truncated.state))
    expect(next.events).toHaveLength(1)
    expect(next.events[0]!.model).toBe('model-alias')
    expect(next.endOffset).toBe(statSync(path).size)
  })

  it('detects same-sized replacements and longer in-place rewrites rather than trusting old offsets', async () => {
    const path = wire(dir, [metadata(), begin(), request(), recorded()])
    const adapter = new KimiCodeAdapter({ roots: dir })
    const first = await adapter.readIncremental(discovered(path), 0)
    const replacement = readFileSync(path, 'utf8').replace('provider-model-v1', 'provider-model-v2')
    expect(Buffer.byteLength(replacement)).toBe(statSync(path).size)
    writeFileSync(path, replacement)
    const rewritten = await adapter.readIncremental(discovered(path), first.endOffset, persisted(first.state))
    expect(rewritten.events).toHaveLength(1)
    expect(rewritten.events[0]!.model).toBe('provider-model-v2')
    expect(rewritten.events[0]!.id).toBe(first.events[0]!.id)
    writeFileSync(path, jsonl(metadata(), begin('new-step'), request('new-model', 'new-alias'), recorded(epoch + 30, 'new-alias'), { type: 'padding', text: 'x'.repeat(6000) }))
    const longer = await adapter.readIncremental(discovered(path), rewritten.endOffset, persisted(rewritten.state))
    expect(longer.events).toHaveLength(1)
    expect(longer.events[0]!.model).toBe('new-model')
  })

  it('uses the committed boundary to detect rewrites after an unchanged large prefix', async () => {
    const path = wire(dir, [metadata(), { type: 'padding', text: 'x'.repeat(9000) }, begin(), request(), recorded()])
    const adapter = new KimiCodeAdapter({ roots: dir })
    const first = await adapter.readIncremental(discovered(path), 0)
    writeFileSync(path, readFileSync(path, 'utf8').replace('provider-model-v1', 'provider-model-v2') + jsonl({ type: 'padding', text: 'extra' }))
    const next = await adapter.readIncremental(discovered(path), first.endOffset, persisted(first.state))
    expect(next.events).toHaveLength(1)
    expect(next.events[0]!.model).toBe('provider-model-v2')
  })

  it('replays a replaced file even if its prefix is identical', async () => {
    const path = wire(dir, [metadata(), begin(), request(), recorded()])
    const adapter = new KimiCodeAdapter({ roots: dir })
    const first = await adapter.readIncremental(discovered(path), 0)
    const replacement = join(dirname(path), 'replacement.jsonl')
    copyFileSync(path, replacement)
    rmSync(path)
    renameSync(replacement, path)
    appendFileSync(path, jsonl(recorded(epoch + 20)))
    const next = await adapter.readIncremental(discovered(path), first.endOffset, persisted(first.state))
    expect(next.events).toHaveLength(2)
    expect(next.events[0]!.id).toBe(first.events[0]!.id)
  })

  it.each(['1.3', '1.6', '2.0', 'unexpected'])('fails closed for protocol %s', async (protocol) => {
    const path = wire(dir, [metadata(protocol), begin(), request(), recorded()])
    const result = await new KimiCodeAdapter({ roots: dir }).readIncremental(discovered(path), 0)
    expect(result.recognized).toBe(false)
    expect(result.events).toHaveLength(0)
  })

  it('fails closed when metadata is missing or changes protocol mid-file', async () => {
    const path = wire(dir, [request(), recorded()])
    const adapter = new KimiCodeAdapter({ roots: dir })
    const missing = await adapter.readIncremental(discovered(path), 0)
    expect(missing.recognized).toBe(false)
    expect(missing.events).toHaveLength(0)
    writeFileSync(path, jsonl(metadata(), begin(), request(), recorded(), metadata('2.0')))
    const changed = await adapter.readIncremental(discovered(path), 0)
    expect(changed.recognized).toBe(false)
    expect(changed.events).toHaveLength(0)
  })

  it('recognizes valid no-usage logs but skips zero, malformed, and unmeasured records', async () => {
    const path = wire(dir, [
      metadata(), begin(), request(),
      { ...recorded(), usage: { inputOther: 0, output: 0, inputCacheRead: 0, inputCacheCreation: 0 } },
      { ...recorded(), usage: { ...usage, inputOther: -1 } },
      { ...recorded(), usage: { ...usage, output: '80' } },
      { ...recorded(), usage: { ...usage, output: 0.5 } },
      { ...recorded(), usage: { inputOther: 10, output: 5 } },
      { ...recorded(), usage: null }, { ...recorded(), time: undefined },
      { type: 'context.append_loop_event', event: { type: 'step.end', usage }, time: epoch + 50 }
    ])
    appendFileSync(path, '{invalid-json}\n')
    const result = await new KimiCodeAdapter({ roots: dir }).readIncremental(discovered(path), 0)
    expect(result.recognized).toBe(true)
    expect(result.events).toHaveLength(0)
    expect(result.endOffset).toBe(statSync(path).size)
  })

  it('reports absent, empty, unsupported, unknown, and measured probe states', async () => {
    expect((await new KimiCodeAdapter({ roots: join(dir, 'missing') }).probe()).status).toBe('absent')
    expect((await new KimiCodeAdapter({ roots: dir }).probe()).status).toBe('empty')
    expect((await new KimiDesktopAdapter({ roots: dir }).probe()).status).toBe('unsupported')
    const path = wire(dir, [metadata()])
    const adapter = new KimiCodeAdapter({ roots: dir })
    expect((await adapter.probe()).status).toBe('unsupported')
    writeFileSync(path, jsonl(metadata('2.0'), recorded()))
    expect((await adapter.probe()).status).toBe('unrecognized')
    writeFileSync(path, jsonl(metadata(), begin(), request(), recorded()))
    const measured = await adapter.probe()
    expect(measured.status).toBe('ok')
    expect(measured.sessionCount).toBe(1)
    expect(measured.earliest).toBe(epoch + 3)
    expect(measured.detail).toContain('统计 Kimi Code 已记录用量')
  })

  it.each(['EACCES', 'EPERM'])('rejects %s reads without a parsed success and retries from the saved cursor', async (code) => {
    const path = wire(dir, [metadata(), begin(), request(), recorded()])
    const adapter = new KimiCodeAdapter({ roots: dir })
    const first = await adapter.readIncremental(discovered(path), 0)
    appendFileSync(path, jsonl(recorded(epoch + 30)))
    const nextFile = discovered(path)
    const saved = persisted(first.state)
    const snapshot = JSON.stringify(saved)
    const resolved = vi.fn()
    vi.mocked(openSync).mockImplementationOnce(() => {
      throw Object.assign(new Error('private-source-error-message'), { code, path })
    })
    const denied = adapter.readIncremental(nextFile, first.endOffset, saved).then(resolved)
    await expect(denied).rejects.toThrow('暂时无法读取 Kimi 记录，将重试')
    expect(resolved).not.toHaveBeenCalled()
    expect(JSON.stringify(saved)).toBe(snapshot)
    const retried = await adapter.readIncremental(nextFile, first.endOffset, saved)
    expect(retried.recognized).toBe(true)
    expect(retried.events).toHaveLength(1)
    expect(retried.events[0]!.ts).toBe(epoch + 30)
  })

  it('reports a denied probe as unreadable and never exposes the original error', async () => {
    wire(dir, [metadata(), begin(), request(), recorded()])
    const adapter = new KimiCodeAdapter({ roots: dir })
    vi.mocked(openSync).mockImplementation(() => {
      throw Object.assign(new Error('private-denied-message'), { code: 'EACCES' })
    })
    const result = await adapter.probe()
    expect(result.status).toBe('unrecognized')
    expect(result.sessionCount).toBeUndefined()
    expect(result.detail).toContain('暂时无法读取 Kimi 记录')
    expect(result.detail).not.toContain('private-denied-message')
  })

  it('rejects a file removed after discovery instead of committing an empty read', async () => {
    const rows = [metadata(), begin(), request(), recorded()]
    const path = wire(dir, rows)
    const file = discovered(path)
    const adapter = new KimiCodeAdapter({ roots: dir })
    rmSync(path)
    await expect(adapter.readIncremental(file, 0)).rejects.toThrow('暂时无法读取 Kimi 记录，将重试')
    vi.spyOn(adapter, 'discover').mockReturnValue([file])
    const result = await adapter.probe()
    expect(result.status).toBe('unrecognized')
    expect(result.sessionCount).toBeUndefined()
    expect(result.detail).not.toContain(path)
    writeFileSync(path, jsonl(...rows))
    expect((await adapter.readIncremental(discovered(path), 0)).events).toHaveLength(1)
  })

  it('sanitizes failures during an already-open read and leaves the file retryable', async () => {
    const path = wire(dir, [metadata(), begin(), request(), recorded()])
    const adapter = new KimiCodeAdapter({ roots: dir })
    vi.mocked(readSync).mockImplementationOnce(() => {
      throw Object.assign(new Error('private-read-error'), { code: 'EIO' })
    })
    await expect(adapter.readIncremental(discovered(path), 0)).rejects.toThrow('暂时无法读取 Kimi 记录，将重试')
    expect((await adapter.readIncremental(discovered(path), 0)).events).toHaveLength(1)
  })

  it('reports an installed default Desktop profile without usage home as unsupported without scanning it', async () => {
    const profile = join(dir, 'kimi-desktop')
    vi.mocked(appDataPath).mockReturnValue(profile)
    const adapter = new KimiDesktopAdapter()
    expect((await adapter.probe()).status).toBe('absent')
    mkdirSync(profile)
    // A decoy usage tree elsewhere in the profile must never be collected.
    wire(join(profile, 'cache'), [metadata(), begin(), request(), recorded()])
    expect(adapter.discover()).toHaveLength(0)
    const result = await adapter.probe()
    expect(result.status).toBe('unsupported')
    expect(result.root).toBe(profile)
    expect(result.fileCount).toBe(0)
    expect(result.detail).toContain('尚无本地任务用量')
    expect(result.detail).toContain('云端聊天暂不支持')
    expect(adapter.defaultRoots()).toEqual([join(profile, 'daimon-share', 'daimon', 'runtime', 'kimi-code', 'home')])
    const home = adapter.defaultRoots()[0]!
    wire(home, [metadata(), begin(), request(), recorded()], { state: desktopState })
    const available = await adapter.probe()
    expect(available.status).toBe('ok')
    expect(available.detail).toContain('仅统计本地任务，不含云端聊天')
  })

  it('keeps explicit custom Desktop roots isolated from an existing default profile', async () => {
    const profile = join(dir, 'kimi-desktop')
    mkdirSync(profile)
    vi.mocked(appDataPath).mockReturnValue(profile)
    const custom = join(dir, 'missing-custom')
    for (const roots of [custom, [custom]]) {
      const adapter = new KimiDesktopAdapter({ roots })
      expect(adapter.discover()).toHaveLength(0)
      const result = await adapter.probe()
      expect(result.status).toBe('absent')
      expect(result.root).toBe(custom)
    }
    mkdirSync(custom)
    const result = await new KimiDesktopAdapter({ roots: custom }).probe()
    expect(result.status).toBe('unsupported')
    expect(result.root).toBe(custom)
    expect(result.detail).toContain('尚无本地任务用量')
  })

  it('does not mistake a regular file at the Desktop profile path for an installed profile directory', async () => {
    const profile = join(dir, 'not-a-profile')
    writeFileSync(profile, '')
    vi.mocked(appDataPath).mockReturnValue(profile)
    expect((await new KimiDesktopAdapter().probe()).status).toBe('absent')
  })

  it.each(['partial', 'complete'])('rejects a %s line over 4 MiB without committing earlier records', async (ending) => {
    const path = wire(dir, [metadata(), begin(), request()])
    const adapter = new KimiCodeAdapter({ roots: dir })
    const first = await adapter.readIncremental(discovered(path), 0)
    const prefix = readFileSync(path)
    const saved = persisted(first.state)
    const snapshot = JSON.stringify(saved)
    const large = '{"private-payload":"' + 'x'.repeat(4 * 1024 * 1024 + 1)
    appendFileSync(path, jsonl(recorded()) + large + (ending === 'complete' ? '"}\n' : ''))
    const resolved = vi.fn()
    const result = adapter.readIncremental(discovered(path), first.endOffset, saved).then(resolved)
    await expect(result).rejects.toThrow('Kimi 记录单行过大，已暂停读取')
    expect(resolved).not.toHaveBeenCalled()
    expect(JSON.stringify(saved)).toBe(snapshot)
    writeFileSync(path, Buffer.concat([prefix, Buffer.from(jsonl(recorded()))]))
    const retried = await adapter.readIncremental(discovered(path), first.endOffset, saved)
    expect(retried.events).toHaveLength(1)
    expect(retried.endOffset).toBe(statSync(path).size)
  })

  it('accepts a line exactly at the 4 MiB limit and preserves the following usage', async () => {
    const path = wire(dir, [metadata()])
    const wrapper = JSON.stringify({ type: 'context.append_message', text: '' })
    const record = { type: 'context.append_message', text: 'x'.repeat(4 * 1024 * 1024 - Buffer.byteLength(wrapper)) }
    const line = JSON.stringify(record)
    expect(Buffer.byteLength(line)).toBe(4 * 1024 * 1024)
    appendFileSync(path, line + '\n' + jsonl(begin(), request(), recorded()))
    const result = await new KimiCodeAdapter({ roots: dir }).readIncremental(discovered(path), 0)
    expect(result.events).toHaveLength(1)
    expect(result.endOffset).toBe(statSync(path).size)
    expect(JSON.stringify(result.state).length).toBeLessThan(3000)
  })

  it('restores an empty parser state after a truncate-to-zero before new usage arrives', async () => {
    const path = wire(dir, [metadata(), begin(), request(), recorded()])
    const adapter = new KimiCodeAdapter({ roots: dir })
    const first = await adapter.readIncremental(discovered(path), 0)
    writeFileSync(path, '')
    const empty = await adapter.readIncremental(discovered(path), first.endOffset, persisted(first.state))
    expect(empty.endOffset).toBe(0)
    expect(empty.recognized).toBe(false)
    appendFileSync(path, jsonl(metadata(), recorded(epoch + 70)))
    const next = await adapter.readIncremental(discovered(path), empty.endOffset, persisted(empty.state))
    expect(next.events).toHaveLength(1)
    expect(next.events[0]!.model).toBe('model-alias')
  })

  it('preserves usage ids through a protocol migration that inserts records before a request', async () => {
    const path = wire(dir, [metadata('1.4'), begin(), request(), recorded()])
    const adapter = new KimiCodeAdapter({ roots: dir })
    const first = await adapter.readIncremental(discovered(path), 0)
    writeFileSync(path, jsonl(metadata(), { type: 'runtime.set_binding', workspaceId: 'example', runtimeId: 'example', agentId: 'main' }, begin(), request(), recorded()))
    const migrated = await adapter.readIncremental(discovered(path), first.endOffset, persisted(first.state))
    expect(migrated.recognized).toBe(true)
    expect(migrated.events).toHaveLength(1)
    expect(migrated.events[0]!.id).toBe(first.events[0]!.id)
  })

  it('counts independent same-valued subagent calls instead of merging their histories', async () => {
    const main = wire(dir, [metadata(), begin('main-step'), request(), recorded()])
    const sub = wire(dir, [metadata(), begin('sub-step', epoch + 1, 'agent-0'), request('provider-model-v1', 'model-alias', epoch + 2, 'agent-0'), recorded(epoch + 3, 'model-alias', 'agent-0')], { agent: 'agent-0' })
    const adapter = new KimiCodeAdapter({ roots: dir })
    const a = await adapter.readIncremental(discovered(main), 0)
    const b = await adapter.readIncremental(discovered(sub), 0)
    expect(a.events).toHaveLength(1)
    expect(b.events).toHaveLength(1)
    expect(a.events[0]!.id).not.toBe(b.events[0]!.id)
  })

  it('handles large lines without retaining content or losing byte offsets', async () => {
    const path = wire(dir, [metadata(), { type: 'context.append_message', message: { content: 'private-large-body'.repeat(10000) } }, begin(), request(), recorded()])
    const result = await new KimiCodeAdapter({ roots: dir }).readIncremental(discovered(path), 0)
    expect(result.events).toHaveLength(1)
    expect(result.endOffset).toBe(statSync(path).size)
    expect(JSON.stringify(result.state)).not.toContain('private-large-body')
    expect(JSON.stringify(result.state).length).toBeLessThan(3000)
  })
})
