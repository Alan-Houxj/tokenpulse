import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CollabStore } from '@core/collab/store'
import { CollabEngine, buildPrompt, parseMentions } from '@core/collab/engine'
import { buildCommand, captureSessionId, estimatePromptTokens, runSpec, trimBanner } from '@core/collab/drivers'
import type { CollabRoom, Participant, RunResult } from '@core/collab/types'

let dir: string
let store: CollabStore

const p = (over: Partial<Participant> = {}): Participant => ({
  id: 'codex-1',
  name: 'Codex',
  agentKind: 'codex',
  color: '#60a5fa',
  reasoning: 'default',
  ...over
})

const room = (over: Partial<CollabRoom> = {}): CollabRoom => ({
  id: 'r1',
  name: '测试房',
  workspace: 'C:/proj',
  participants: [p()],
  timeoutMs: 60_000,
  createdAt: 1,
  ...over
})

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'collab-test-'))
  store = CollabStore.open(join(dir, 'collab.db'))
})

afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('collab.drivers', () => {
  it('buildCommand：codex 首跑/续跑、模型与推理强度覆盖', () => {
    const first = buildCommand('codex', {})
    expect(first.args.join(' ')).toContain('exec')
    expect(first.args.join(' ')).toContain('workspace-write')
    expect(first.stdinMode).toBe(true)

    const full = buildCommand('codex', { sessionId: 'abc-123', model: 'gpt-5.6-sol', reasoning: 'high' })
    const s = full.args.join(' ')
    expect(s).toContain('resume abc-123')
    expect(s).toContain('-m gpt-5.6-sol')
    expect(s).toContain('model_reasoning_effort="high"')
    expect(s.endsWith(' -')).toBe(true)
  })

  it('buildCommand：zcode 参数模式（--prompt 收文本）', () => {
    const spec = buildCommand('zcode', { zcodeCli: 'C:/x/zcode.cjs', sessionId: 'sess_1' })
    expect(spec.args[0]).toBe(process.execPath)
    expect(spec.args.join(' ')).toContain('--resume sess_1')
    expect(spec.stdinMode).toBe(false)
  })

  it('captureSessionId：codex 横幅 / zcode sess_ / claude json', () => {
    expect(captureSessionId('codex', 'session id: 01a086f0-f703-7561-9c1d-f8b6bf119ba9')).toBe(
      '01a086f0-f703-7561-9c1d-f8b6bf119ba9'
    )
    expect(captureSessionId('zcode', 'xx sess_00befcc0-5c8d-4522-b6fd-8554bc440004 yy')).toBe(
      'sess_00befcc0-5c8d-4522-b6fd-8554bc440004'
    )
    expect(captureSessionId('claude-code', '{"session_id":"s123","result":"ok"}')).toBe('s123')
    expect(captureSessionId('codex', '无标记')).toBeUndefined()
  })

  it('trimBanner 裁掉 codex 横幅与 user 回显块', () => {
    const out = ['model: gpt-5.6-luna', '--------', 'user', '只回复：收到', '', '收到'].join('\n')
    expect(trimBanner(out)).toBe('收到')
    expect(trimBanner('直接就是结果')).toBe('直接就是结果')
  })

  it('estimatePromptTokens：中文与拉丁混合粗估', () => {
    const cjk = estimatePromptTokens('你好世界')
    expect(cjk).toBeGreaterThanOrEqual(2)
    expect(estimatePromptTokens('abcdefgh')).toBe(2)
  })

  it('runSpec：stdin 注入与 stdout 收回（stub 命令）', async () => {
    const spec = {
      args: [process.execPath, '-e', "process.stdout.write('回复:'+require('fs').readFileSync(0,'utf8').slice(-2))"],
      stdinMode: true
    }
    const r = await runSpec(spec, '……结尾', { cwd: dir, timeoutMs: 15_000 }).promise
    expect(r.code).toBe(0)
    expect(r.stdout).toBe('回复:结尾')
  }, 20_000)

  it('runSpec：超时强杀进程树并标记 timedOut', async () => {
    const spec = { args: [process.execPath, '-e', 'setTimeout(()=>{},60000)'], stdinMode: true }
    const r = await runSpec(spec, 'x', { cwd: dir, timeoutMs: 800 }).promise
    expect(r.timedOut).toBe(true)
  }, 10_000)

  it('runSpec：参数模式把 prompt 作为末参', async () => {
    const spec = {
      args: [process.execPath, '-e', 'process.stdout.write(process.argv[1])'],
      stdinMode: false
    }
    // runAgent 会在末尾 push prompt；这里直接验证机制
    spec.args.push('HELLO')
    const r = await runSpec(spec, 'HELLO', { cwd: dir, timeoutMs: 15_000 }).promise
    expect(r.stdout).toBe('HELLO')
  }, 20_000)
})

describe('collab.engine', () => {
  it('parseMentions：按名命中、长名优先、顺序去重', () => {
    const ps = [p(), p({ id: 'cl-1', name: 'Claude Code', agentKind: 'claude-code' })]
    expect(parseMentions('@Codex 帮我看看 @Claude Code 再确认', ps).map((x) => x.name)).toEqual(['Codex', 'Claude Code'])
    expect(parseMentions('@cl-1 你好', ps).map((x) => x.name)).toEqual(['Claude Code'])
    expect(parseMentions('没有提及', ps)).toEqual([])
    expect(parseMentions('@codex @Codex 重复只算一次', ps)).toHaveLength(1)
  })

  it('buildPrompt：全量注入三段式，历史含全部消息且不截断', () => {
    const r = room()
    const long = 'B'.repeat(10_000)
    const history = [
      { id: '1', roomId: 'r1', ts: 1, author: 'user', text: '第一条' },
      { id: '2', roomId: 'r1', ts: 2, author: 'codex-1', text: long },
      { id: '3', roomId: 'r1', ts: 3, author: 'user', text: '@Codex 开工' }
    ]
    const out = buildPrompt(r, history, history[2]!, p())
    expect(out).toContain('你是「Codex」')
    expect(out).toContain('「测试房」')
    expect(out).toContain('第一条') // 全量：最早的消息也在
    expect(out).toContain(long) // 不截断
    expect(out.match(/=== @ 你的最新消息 ===/)).toBeTruthy()
    // 最新消息只出现一次（不在历史里重复）
    expect(out.indexOf('@Codex 开工')).toBe(out.lastIndexOf('@Codex 开工'))
  })

  it('用户消息带 @ → 串行执行、状态流转、成本回查、session id 持久化', async () => {
    store.createRoom(room())
    const runs: { sessionId?: string }[] = []
    const fakeRun = vi.fn((participant: Participant, prompt: string, opts: { sessionId?: string }) => {
      runs.push({ sessionId: opts.sessionId })
      return {
        kill: () => {},
        promise: Promise.resolve<RunResult>({
          stdout: `来自${participant.name}的答复`,
          stderr: '',
          code: 0,
          timedOut: false,
          sessionId: opts.sessionId ?? 'native-sess-1'
        })
      }
    })
    const engine = new CollabEngine({
      store,
      run: fakeRun as never,
      usage: () => ({ tokens: 1234, costEstUSD: 0.05 }),
      onChange: () => {},
      now: (() => 1000) as never
    })
    engine.postUserMessage('r1', '@Codex 分析一下')
    await vi.waitFor(() => {
      expect(store.getMessages('r1').some((m) => m.status === 'done')).toBe(true)
    })
    // 首跑无 session；捕获到的 native-sess-1 已存档
    expect(runs[0]!.sessionId).toBeUndefined()
    expect(store.getSession('r1', 'codex-1')).toBe('native-sess-1')

    // 第二次 @ 应带 session id（持久会话续跑）
    const fakeRun2 = vi.fn((participant: Participant, prompt: string, opts: { sessionId?: string }) => ({
      kill: () => {},
      promise: Promise.resolve<RunResult>({ stdout: '第二次答复', stderr: '', code: 0, timedOut: false })
    }))
    const engine2 = new CollabEngine({ store, run: fakeRun2 as never, onChange: () => {}, now: (() => 2000) as never })
    engine2.postUserMessage('r1', '@Codex 继续')
    await vi.waitFor(() => {
      const msgs = store.getMessages('r1')
      expect(msgs.filter((m) => m.status === 'done')).toHaveLength(2)
    })
    expect(fakeRun2.mock.calls[0]![2]).toMatchObject({ sessionId: 'native-sess-1' })
    // 消息附带 prompt 规模估算
    const done = store.getMessages('r1').filter((m) => m.status === 'done')
    expect(done[0]!.promptEst).toBeGreaterThan(0)
  })

  it('用户消息无 @ → 只落库不执行（主持人模式）', async () => {
    store.createRoom(room())
    const fakeRun = vi.fn()
    const engine = new CollabEngine({ store, run: fakeRun as never, onChange: () => {} })
    engine.postUserMessage('r1', '没人被提到')
    await new Promise((r) => setTimeout(r, 30))
    expect(fakeRun).not.toHaveBeenCalled()
    expect(store.getMessages('r1')).toHaveLength(1)
  })

  it('运行失败 → error 状态与错误信息', async () => {
    store.createRoom(room())
    const engine = new CollabEngine({
      store,
      run: (() => ({
        kill: () => {},
        promise: Promise.resolve<RunResult>({ stdout: '', stderr: 'boom', code: 1, timedOut: false })
      })) as never,
      onChange: () => {}
    })
    engine.postUserMessage('r1', '@Codex 会失败')
    await vi.waitFor(() => {
      expect(store.getMessages('r1').some((m) => m.status === 'error')).toBe(true)
    })
    const err = store.getMessages('r1').find((m) => m.status === 'error')!
    expect(err.error).toContain('退出码 1')
  })
})

describe('collab.store', () => {
  it('房间/消息/session CRUD 往返一致', () => {
    const r = room({ participants: [p(), p({ id: 'x', name: 'X', agentKind: 'zcode' })] })
    store.createRoom(r)
    expect(store.getRoom('r1')!.participants.map((x) => x.name)).toEqual(['Codex', 'X'])
    store.updateRoom({ ...r, name: '改名' })
    expect(store.getRoom('r1')!.name).toBe('改名')

    store.insertMessage({ id: 'm1', roomId: 'r1', ts: 1, author: 'user', text: 'hi', status: 'done' })
    store.updateMessage('m1', { text: 'hi2', tokens: 5, promptEst: 42 })
    const msgs = store.getMessages('r1')
    expect(msgs[0]!.text).toBe('hi2')
    expect(msgs[0]!.promptEst).toBe(42)

    expect(store.getSession('r1', 'codex-1')).toBeUndefined()
    store.setSession('r1', 'codex-1', 's-a')
    expect(store.getSession('r1', 'codex-1')).toBe('s-a')
    store.setSession('r1', 'codex-1', 's-b') // 覆盖
    expect(store.getSession('r1', 'codex-1')).toBe('s-b')

    store.deleteRoom('r1')
    expect(store.listRooms()).toHaveLength(0)
    expect(store.getSession('r1', 'codex-1')).toBeUndefined()
  })
})
