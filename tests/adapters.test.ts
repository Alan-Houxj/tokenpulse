import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, rmSync, writeFileSync, appendFileSync, utimesSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { ClaudeCodeAdapter } from '@core/adapters/claude-code'
import { CodexAdapter } from '@core/adapters/codex'
import { createGeminiAdapter, createQwenAdapter } from '@core/adapters/gemini-like'
import { ZCodeAdapter } from '@core/adapters/zcode'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agentmeter-adapters-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('ClaudeCodeAdapter', () => {
  it('解析 assistant 行 usage 并跳过无关行；requestId 去重', async () => {
    const root = join(dir, '.claude', 'projects', 'C--proj-x')
    mkdirSync(root, { recursive: true })
    const f = join(root, 'sess-abc.jsonl')
    writeFileSync(
      f,
      [
        JSON.stringify({ type: 'user', message: { role: 'user' }, sessionId: 'abc', timestamp: '2026-09-01T00:00:00.000Z' }),
        JSON.stringify({
          type: 'assistant',
          sessionId: 'abc',
          requestId: 'req_1',
          cwd: 'C:\\proj\\x',
          timestamp: '2026-09-01T00:00:01.000Z',
          message: {
            id: 'msg_1',
            model: 'claude-sonnet-4-5-20250929',
            usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 200, cache_read_input_tokens: 5000 }
          },
          costUSD: 0.0123
        }),
        JSON.stringify({
          type: 'assistant',
          sessionId: 'abc',
          requestId: 'req_1', // 重试造成的重复行
          timestamp: '2026-09-01T00:00:02.000Z',
          message: { id: 'msg_1', model: 'claude-sonnet-4-5-20250929', usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 200, cache_read_input_tokens: 5000 } }
        }),
        JSON.stringify({ type: 'assistant', sessionId: 'abc', timestamp: '2026-09-01T00:00:03.000Z', message: { id: 'msg_2', model: 'm', usage: null } })
      ].join('\n') + '\n',
      'utf8'
    )

    const adapter = new ClaudeCodeAdapter({ roots: [join(dir, '.claude')] })
    const files = adapter.discover()
    expect(files).toHaveLength(1)
    expect(files[0]!.path).toContain('sess-abc.jsonl')

    const { events, endOffset } = await adapter.readIncremental(files[0]!, 0)
    expect(events).toHaveLength(2) // 两行都解析出来，幂等靠存储层主键
    expect(new Set(events.map((e) => e.id)).size).toBe(1)
    const e = events[0]!
    expect(e.id).toBe('claude-code:abc:req_1')
    expect(e.model).toBe('claude-sonnet-4-5-20250929')
    expect(e.tokens).toEqual({ input: 100, output: 50, reasoning: 0, cacheRead: 5000, cacheWrite: 200 })
    expect(e.costUSD).toBeCloseTo(0.0123)
    expect(e.ts).toBe(Date.parse('2026-09-01T00:00:01.000Z'))
    expect(e.projectPath).toBe('C:\\proj\\x')
    expect(endOffset).toBeGreaterThan(0)

    // 增量：追加新事件后只读到新增
    const before = endOffset
    appendFileSync(f, JSON.stringify({
      type: 'assistant', sessionId: 'abc', requestId: 'req_2', timestamp: '2026-09-01T00:05:00.000Z',
      message: { id: 'msg_3', model: 'claude-opus-4-1', usage: { input_tokens: 1, output_tokens: 2 } }
    }) + '\n')
    const next = await adapter.readIncremental(files[0]!, before)
    expect(next.events).toHaveLength(1)
    expect(next.events[0]!.id).toBe('claude-code:abc:req_2')

    // 残缺尾行（写入中断的常态）不应被消费
    appendFileSync(f, '{"type":"assistant","partial":')
    const partial = await adapter.readIncremental(files[0]!, next.endOffset)
    expect(partial.events).toHaveLength(0)
  })
})

describe('CodexAdapter', () => {
  it('解析 token_usage_record；忽略 token_count 累计；归一化 cached/reasoning', async () => {
    const root = join(dir, '.codex', 'sessions', '2026', '09', '04')
    mkdirSync(root, { recursive: true })
    const f = join(root, 'rollout-2026-09-04T10-00-00-abc.jsonl')
    writeFileSync(
      f,
      [
        JSON.stringify({ timestamp: '2026-09-04T10:00:00.000Z', type: 'session_meta', payload: { session_id: 'codex-sess-1', cwd: 'C:/work/proj' } }),
        JSON.stringify({ timestamp: '2026-09-04T10:00:01.000Z', type: 'turn_context', payload: { model: 'gpt-5.6-sol', cwd: 'C:/work/proj', effort: 'xhigh' } }),
        JSON.stringify({ timestamp: '2026-09-04T10:00:02.000Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 99999999 }, last_token_usage: { input_tokens: 70000 } } } }),
        JSON.stringify({
          timestamp: '2026-09-04T10:00:03.000Z',
          type: 'token_usage_record',
          payload: {
            session_id: 'codex-sess-1',
            response_id: 'resp_001',
            usage: { input_tokens: 71495, cached_input_tokens: 70656, output_tokens: 305, reasoning_output_tokens: 100, total_tokens: 71800 }
          }
        })
      ].join('\n') + '\n',
      'utf8'
    )

    const adapter = new CodexAdapter({ roots: [join(dir, '.codex')] })
    const files = adapter.discover()
    expect(files).toHaveLength(1)

    const { events } = await adapter.readIncremental(files[0]!, 0)
    expect(events).toHaveLength(2) // 新格式 1 条 + 旧格式 token_count 1 条（现为受支持格式）
    const e = events.find((x) => x.id.includes('resp_001'))!
    expect(e.id).toBe('codex:codex-sess-1:resp_001')
    expect(e.model).toBe('gpt-5.6-sol')
    // 71495-70656=839 非缓存输入；305-100=205 输出；reasoning 单列
    expect(e.tokens).toEqual({ input: 839, output: 205, reasoning: 100, cacheRead: 70656, cacheWrite: 0 })
    expect(e.projectPath).toBe('C:/work/proj')
  })

  it('旧格式 token_count：解析增量并以累计指纹去重重放', async () => {
    const root = join(dir, '.codex', 'sessions')
    mkdirSync(root, { recursive: true })
    const f = join(root, 'rollout-old.jsonl')
    const ctx = JSON.stringify({ timestamp: '2026-07-18T23:00:00.000Z', type: 'turn_context', payload: { model: 'gpt-5.2', cwd: 'C:/old' } }) + '\n'
    const tc = (li: number, lo: number, ti: number, to: number, t = '2026-07-18T23:01:00.000Z') =>
      JSON.stringify({
        timestamp: t, type: 'event_msg',
        payload: { type: 'token_count', info: { last_token_usage: { input_tokens: li, cached_input_tokens: 0, output_tokens: lo }, total_token_usage: { input_tokens: ti, output_tokens: to } } }
      }) + '\n'
    // 同一累计被重放（rate-limit 重发场景）→ 只记一次；新响应累计变化 → 新事件
    writeFileSync(f, ctx + tc(100, 20, 500, 80) + tc(100, 20, 500, 80) + tc(80, 10, 580, 90), 'utf8')

    const adapter = new CodexAdapter({ roots: [join(dir, '.codex')] })
    const [file] = adapter.discover()
    const { events } = await adapter.readIncremental(file!, 0)
    // 适配器层不去重（去重在存储主键）：3 条解析结果、2 个唯一 id（重复累计指纹相同）
    expect(events).toHaveLength(3)
    expect(new Set(events.map((e) => e.id)).size).toBe(2)
    expect(events[0]!.id).toBe('codex:unknown-session:tc:500-80')
    expect(events[0]!.model).toBe('gpt-5.2')
    expect(events[0]!.tokens.input).toBe(100)
    expect(events[0]!.tokens.output).toBe(20)
    expect(events.some((e) => e.id === 'codex:unknown-session:tc:580-90')).toBe(true)
  })

  it('跨增量段恢复解析状态：新段没有 turn_context 也不丢模型', async () => {
    const root = join(dir, '.codex', 'sessions')
    mkdirSync(root, { recursive: true })
    const f = join(root, 'rollout-state.jsonl')
    const ctx = JSON.stringify({ timestamp: '2026-09-05T10:00:00.000Z', type: 'turn_context', payload: { model: 'gpt-5.6-sol', cwd: 'C:/w' } }) + '\n'
    const rec = (rid: string) => JSON.stringify({
      timestamp: '2026-09-05T10:01:00.000Z', type: 'token_usage_record',
      payload: { session_id: 'st1', response_id: rid, usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } }
    }) + '\n'
    writeFileSync(f, ctx + rec('r1'), 'utf8')

    const adapter = new CodexAdapter({ roots: [join(dir, '.codex')] })
    const [file] = adapter.discover()
    const first = await adapter.readIncremental(file!, 0)
    expect(first.events[0]!.model).toBe('gpt-5.6-sol')
    expect(first.state).toEqual({ model: 'gpt-5.6-sol', cwd: 'C:/w', sessionId: undefined })

    // 追加的新段只有用量记录——传入上次状态后模型不丢
    appendFileSync(f, rec('r2'))
    const [file2] = adapter.discover()
    const second = await adapter.readIncremental(file2!, first.endOffset, first.state)
    expect(second.events).toHaveLength(1)
    expect(second.events[0]!.model).toBe('gpt-5.6-sol')
    expect(second.events[0]!.projectPath).toBe('C:/w')

    // 不传状态（模拟旧版行为）则会回退 unknown——这正是要修的 bug
    appendFileSync(f, rec('r3'))
    const noState = await adapter.readIncremental(file2!, second.endOffset)
    expect(noState.events[0]!.model).toBe('unknown')
  })

  it('文件截断时从 0 重读', async () => {
    const root = join(dir, '.codex', 'sessions')
    mkdirSync(root, { recursive: true })
    const f = join(root, 'rollout-x.jsonl')
    const rec = JSON.stringify({
      timestamp: '2026-09-04T11:00:00.000Z', type: 'token_usage_record',
      payload: { session_id: 's2', response_id: 'r9', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } }
    })
    writeFileSync(f, 'x'.repeat(500) + '\n' + rec + '\n', 'utf8')
    const adapter = new CodexAdapter({ roots: [join(dir, '.codex')] })
    const [file] = adapter.discover()
    const first = await adapter.readIncremental(file!, 0)
    expect(first.events).toHaveLength(1)
    // 模拟轮换：文件变短
    writeFileSync(f, rec + '\n', 'utf8')
    const second = await adapter.readIncremental(file!, first.endOffset)
    expect(second.events).toHaveLength(1)
    expect(second.events[0]!.id).toBe('codex:s2:r9')
  })
})

describe('Gemini/Qwen (GeminiLike)', () => {
  it('解析 chunk 文件的 requests 数组；缺 timestamp 用文件 mtime', async () => {
    const root = join(dir, '.gemini', 'tmp', 'chat-42')
    mkdirSync(root, { recursive: true })
    const f = join(root, 'chunk_2026-09-01.json')
    const mtime = new Date('2026-09-01T08:00:00Z')
    writeFileSync(
      f,
      JSON.stringify({
        requests: [
          { chatId: 'chat-42', modelVersion: 'gemini-2.5-pro', usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 200, thoughtsTokenCount: 50, cachedContentTokenCount: 800 } },
          { chatId: 'chat-42', modelVersion: 'gemini-2.5-pro', usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2 } }
        ]
      }),
      'utf8'
    )
    utimesSync(f, mtime, mtime)

    const adapter = createGeminiAdapter([join(dir, '.gemini')])
    const files = adapter.discover()
    expect(files).toHaveLength(1)
    const { events, endOffset } = await adapter.readIncremental(files[0]!, 0)
    expect(events).toHaveLength(2)
    const e = events[0]!
    expect(e.agent).toBe('gemini-cli')
    expect(e.sessionId).toBe('chat-42')
    expect(e.model).toBe('gemini-2.5-pro')
    expect(e.tokens).toEqual({ input: 200, output: 200, reasoning: 50, cacheRead: 800, cacheWrite: 0 })
    expect(e.ts).toBe(mtime.getTime())
    expect(endOffset).toBe(files[0]!.size)
    // 内容未变时零读取
    const again = await adapter.readIncremental(files[0]!, endOffset)
    expect(again.events).toHaveLength(0)
  })

  it('qwen 复用同款解析器', async () => {
    const root = join(dir, '.qwen', 'tmp', 'qc-1')
    mkdirSync(root, { recursive: true })
    const f = join(root, 'chunks.json')
    writeFileSync(f, JSON.stringify({ requests: [{ chatId: 'qc-1', modelVersion: 'qwen3-coder-plus', usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20 } }] }), 'utf8')
    const adapter = createQwenAdapter([join(dir, '.qwen')])
    const [file] = adapter.discover()
    const { events } = await adapter.readIncremental(file!, 0)
    expect(events[0]!.agent).toBe('qwen')
    expect(events[0]!.model).toBe('qwen3-coder-plus')
  })
})

describe('ZCodeAdapter', () => {
  function buildDb(path: string): DatabaseSync {
    mkdirSync(join(path, '..'), { recursive: true })
    const db = new DatabaseSync(path)
    db.exec(`
      CREATE TABLE model_usage (
        session_id TEXT, logical_request_id TEXT, attempt_index INTEGER,
        model_id TEXT, started_at INTEGER, duration_ms INTEGER,
        input_tokens INTEGER, output_tokens INTEGER, reasoning_tokens INTEGER,
        cache_creation_input_tokens INTEGER, cache_read_input_tokens INTEGER
      );
      CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT);
    `)
    return db
  }

  it('读取 model_usage 并增量续读；项目路径来自 session 表', async () => {
    const dbPath = join(dir, 'zcode', 'db.sqlite')
    const db = buildDb(dbPath)
    const ins = db.prepare(`INSERT INTO model_usage
      (session_id, logical_request_id, attempt_index, model_id, started_at, duration_ms,
       input_tokens, output_tokens, reasoning_tokens, cache_creation_input_tokens, cache_read_input_tokens)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    ins.run('zs1', 'lr-1', 0, 'GLM-5.3', 1788497526183, 58255, 24331, 1909, 300, 0, 20096)
    ins.run('zs1', 'lr-2', 0, 'GLM-5.3', 1788497600000, 1000, 100, 50, 0, 10, 500)
    db.prepare('INSERT INTO session VALUES (?, ?)').run('zs1', 'C:/Users/dev/work/demo') // 列序 = id, directory
    db.close()

    const adapter = new ZCodeAdapter({ dbPath })
    const files = adapter.discover()
    expect(files).toHaveLength(1)

    const first = await adapter.readIncremental(files[0]!, 0)
    expect(first.events).toHaveLength(2)
    const e = first.events[0]!
    expect(e.id).toBe('zcode:zs1:lr-1:0:1788497526183')
    expect(e.model).toBe('GLM-5.3')
    // ZCode 口径：input_tokens(24331) 含 cache_read(20096) → 非缓存输入 4235
    expect(e.tokens).toEqual({ input: 4235, output: 1909, reasoning: 300, cacheRead: 20096, cacheWrite: 0 })
    expect(e.projectPath).toBe('C:/Users/dev/work/demo')
    expect(e.durationMs).toBe(58255)

    // 增量：只读到新增的一行
    const db2 = new DatabaseSync(dbPath)
    db2.prepare(`INSERT INTO model_usage
      (session_id, logical_request_id, attempt_index, model_id, started_at,
       input_tokens, output_tokens) VALUES ('zs1','lr-3',0,'GLM-5.3',1788497700000,1,2)`).run()
    db2.close()
    const next = await adapter.readIncremental(files[0]!, first.endOffset)
    expect(next.events).toHaveLength(1)
    expect(next.events[0]!.id).toContain('lr-3')
  })

  it('discover 签名合并 -wal 文件（WAL 写入不更新主文件 mtime 时的增量触发）', async () => {
    const dbPath = join(dir, 'zcode-wal', 'db.sqlite')
    const db = buildDb(dbPath)
    db.prepare(`INSERT INTO model_usage (session_id, logical_request_id, model_id, started_at, input_tokens, output_tokens)
      VALUES ('zw','lr-1','GLM-5.3',100,10,2)`).run()
    db.close() // journal_mode=delete：无 wal 文件
    let adapter = new ZCodeAdapter({ dbPath })
    const [f1] = adapter.discover()
    expect(f1!.size).toBeGreaterThan(0)

    // 模拟 WAL：主文件不变，出现 wal 文件 → 签名必须变化（mtime/size 任一）
    const walPath = dbPath + '-wal'
    const st = require('node:fs').statSync(dbPath)
    require('node:fs').writeFileSync(walPath, Buffer.alloc(4096))
    // 保留主文件 mtime 不变（writeFileSync wal 不触碰主文件）
    require('node:fs').utimesSync(dbPath, st.atime, st.mtime)
    const [f2] = adapter.discover()
    expect(f2!.size).toBeGreaterThan(f1!.size) // size 合并了 wal
  })

  it('库重建（rowid 回退）时自动全量重扫', async () => {
    const dbPath = join(dir, 'zcode2', 'db.sqlite')
    let db = buildDb(dbPath)
    const ins = db.prepare(`INSERT INTO model_usage (session_id, logical_request_id, model_id, started_at, input_tokens, output_tokens)
      VALUES (?,?,?, ?,?,?)`)
    ins.run('zs9', 'lr-a', 'GLM-5.3', 100, 1, 1)
    ins.run('zs9', 'lr-a2', 'GLM-5.3', 101, 1, 1)
    db.close()
    const adapter = new ZCodeAdapter({ dbPath })
    const [file] = adapter.discover()
    const first = await adapter.readIncremental(file!, 0)
    expect(first.events).toHaveLength(2)
    expect(first.endOffset).toBe(2)

    // 重建：新库只有 1 行 → maxRowid(1) < 位点(2)，触发重扫
    rmSync(dbPath)
    db = buildDb(dbPath)
    db.prepare(`INSERT INTO model_usage (session_id, logical_request_id, model_id, started_at, input_tokens, output_tokens)
      VALUES ('zs9','lr-b','GLM-5.3',200,2,2)`).run()
    db.close()
    const second = await adapter.readIncremental(file!, first.endOffset)
    expect(second.events).toHaveLength(1)
    expect(second.events[0]!.id).toContain('lr-b')
  })
})
