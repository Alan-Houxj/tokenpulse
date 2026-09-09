import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CollabStore } from '@core/collab/store'
import { CollabEngine, buildPrompt, parseMentions } from '@core/collab/engine'
import { renderCommand, trimBanner, usesStdin } from '@core/collab/drivers'
import type { CollabRoom, Participant, RunResult } from '@core/collab/types'

let dir: string
let store: CollabStore

const p = (over: Partial<Participant> = {}): Participant => ({
  id: 'codex-1',
  name: 'Codex',
  agentKind: 'codex',
  color: '#60a5fa',
  command: 'codex exec -',
  ...over
})

const room = (over: Partial<CollabRoom> = {}): CollabRoom => ({
  id: 'r1',
  name: '测试房',
  workspace: 'C:/proj',
  participants: [p()],
  contextMessages: 10,
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
  it('命令模板：{prompt} 替换 / 无占位符走 stdin', () => {
    expect(renderCommand({ command: 'echo {prompt}' }, '你好')).toBe('echo 你好')
    expect(usesStdin('codex exec -')).toBe(true)
    expect(usesStdin('run.sh {prompt}')).toBe(false)
  })

  it('trimBanner 裁掉 codex 横幅与 user 回显行', () => {
    const out = ['model: gpt-5.6-luna', 'provider: openai', '--------', 'user', '只回复：收到', '', '收到'].join('\n')
    expect(trimBanner(out)).toBe('收到')
  })

  it('无横幅输出原样返回', () => {
    expect(trimBanner('直接就是结果')).toBe('直接就是结果')
  })

  it('真实进程：stdin 注入与 stdout 收回（stub 命令）', async () => {
    const { runAgent } = await import('@core/collab/drivers')
    const stub = p({ command: `node -e "process.stdout.write('回复:'+require('fs').readFileSync(0,'utf8').slice(-2))"` })
    const h = runAgent(stub, '……结尾', { cwd: dir, timeoutMs: 15_000 })
    const r = await h.promise
    expect(r.code).toBe(0)
    expect(r.stdout).toBe('回复:结尾')
  }, 20_000)

  it('超时强杀并标记 timedOut', async () => {
    const { runAgent } = await import('@core/collab/drivers')
    const stub = p({ command: 'node -e "setTimeout(()=>{},60000)"' })
    const h = runAgent(stub, 'x', { cwd: dir, timeoutMs: 800 })
    const r = await h.promise
    expect(r.timedOut).toBe(true)
  }, 10_000)
})

describe('collab.engine', () => {
  it('parseMentions：按名/按 id 命中、顺序去重、大小写不敏感', () => {
    const ps = [p(), p({ id: 'cl-1', name: 'Claude Code' })]
    expect(parseMentions('@codex 帮我看看 @Claude Code 再确认', ps).map((x) => x.name)).toEqual([
      'Codex',
      'Claude Code'
    ])
    expect(parseMentions('@cl-1 你好', ps).map((x) => x.name)).toEqual(['Claude Code'])
    expect(parseMentions('没有提及', ps)).toEqual([])
    expect(parseMentions('@codex @codex 重复只算一次', ps)).toHaveLength(1)
  })

  it('buildPrompt：含协作说明、上下文转录与最新消息，超长截断', () => {
    const r = room({ contextMessages: 2 })
    const history = [
      { id: '1', roomId: 'r1', ts: 1, author: 'user', text: '第一条' },
      { id: '2', roomId: 'r1', ts: 2, author: 'codex-1', text: 'B'.repeat(5000) },
      { id: '3', roomId: 'r1', ts: 3, author: 'user', text: '第二条' },
      { id: '4', roomId: 'r1', ts: 4, author: 'user', text: '@Codex 开工' }
    ]
    const out = buildPrompt(r, history, history[3]!, p())
    expect(out).toContain('你是「Codex」')
    expect(out).not.toContain('第一条') // 只带最近 2 条
    expect(out).toContain('超长已截断')
    expect(out).toContain('@Codex 开工')
  })

  it('用户消息带 @ → 串行执行、落库状态流转、成本回查附带', async () => {
    store.createRoom(room())
    const changes: string[] = []
    const runs: string[] = []
    const fakeRun = vi.fn((participant: Participant, prompt: string) => {
      runs.push(prompt)
      return {
        kill: () => {},
        promise: Promise.resolve<RunResult>({ stdout: `来自${participant.name}的答复`, stderr: '', code: 0, timedOut: false })
      }
    })
    const engine = new CollabEngine({
      store,
      run: fakeRun as never,
      usage: (kind) => (kind === 'codex' ? { tokens: 1234, costEstUSD: 0.05 } : null),
      onChange: (rid) => changes.push(rid),
      now: (() => 1000) as never
    })
    // now 固定会让 ts 全等，runMentions 里 durationMs=0；消息顺序按 rowid 仍稳定
    const res = engine.postUserMessage('r1', '@Codex 分析一下')
    expect(res.ok).toBe(true)
    await vi.waitFor(() => {
      expect(store.getMessages('r1').filter((m) => m.status === 'done')).toHaveLength(1)
    })
    const msgs = store.getMessages('r1')
    expect(msgs).toHaveLength(2) // 用户消息 + Agent 回复
    const reply = msgs.find((m) => m.author === 'codex-1')!
    expect(reply.text).toBe('来自Codex的答复')
    expect(reply.tokens).toBe(1234)
    expect(reply.costEstUSD).toBe(0.05)
    expect(runs[0]).toContain('分析一下')
    expect(changes.length).toBeGreaterThan(0)
  })

  it('用户消息无 @ → 只落库不执行（主持人模式：Agent 输出的 @ 也不触发）', async () => {
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
  it('房间与消息 CRUD 往返一致', () => {
    const r = room({ participants: [p(), p({ id: 'x', name: 'X' })] })
    store.createRoom(r)
    expect(store.listRooms()).toHaveLength(1)
    expect(store.getRoom('r1')!.participants.map((x) => x.name)).toEqual(['Codex', 'X'])
    store.updateRoom({ ...r, name: '改名' })
    expect(store.getRoom('r1')!.name).toBe('改名')
    store.insertMessage({ id: 'm1', roomId: 'r1', ts: 1, author: 'user', text: 'hi', status: 'done' })
    store.updateMessage('m1', { text: 'hi2', tokens: 5 })
    const msgs = store.getMessages('r1')
    expect(msgs[0]!.text).toBe('hi2')
    expect(msgs[0]!.tokens).toBe(5)
    expect(store.roomHasRunning('r1')).toBe(false)
    store.insertMessage({ id: 'm2', roomId: 'r1', ts: 2, author: 'user', text: '', status: 'running' })
    expect(store.roomHasRunning('r1')).toBe(true)
    store.deleteRoom('r1')
    expect(store.listRooms()).toHaveLength(0)
    expect(store.getMessages('r1')).toHaveLength(0)
  })
})
