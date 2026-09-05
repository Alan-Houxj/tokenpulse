import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { __internals } from '@core/engine/live'
import type { LiveAgentCard } from '@core/model/types'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tp-live-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function buildZcodeDb(path: string): DatabaseSync {
  mkdirSync(join(path, '..'), { recursive: true })
  const db = new DatabaseSync(path)
  db.exec(`
    CREATE TABLE model_usage (
      session_id TEXT, model_id TEXT, started_at INTEGER, first_token_at INTEGER,
      completed_at INTEGER, status TEXT, input_tokens INTEGER, output_tokens INTEGER,
      reasoning_tokens INTEGER, cache_read_input_tokens INTEGER,
      cache_creation_input_tokens INTEGER, duration_ms INTEGER, error_message TEXT
    );
    CREATE TABLE tool_usage (
      session_id TEXT, tool_name TEXT, started_at INTEGER, completed_at INTEGER,
      status TEXT, error_type TEXT, error_message TEXT
    );
    CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, data TEXT);
    CREATE TABLE part (id TEXT, message_id TEXT, session_id TEXT, data TEXT);
    CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT);
  `)
  db.prepare('INSERT INTO session VALUES (?, ?)').run('s1', 'C:/proj/demo')
  return db
}

describe('ZCode 状态推断', () => {
  it('running 工具 → tool 态，动作含工具名与运行秒数', () => {
    const db = buildZcodeDb(join(dir, 'z', 'db.sqlite'))
    const now = Date.now()
    db.prepare(`INSERT INTO model_usage (session_id, model_id, started_at, completed_at, status, input_tokens, output_tokens)
      VALUES ('s1','GLM-5.3',?,?,'completed',1000,50)`).run(now - 120_000, now - 100_000)
    db.prepare(`INSERT INTO tool_usage (session_id, tool_name, started_at, status)
      VALUES ('s1','Bash',?,'running')`).run(now - 5_000)
    const card = __internals.zcodeSessionCard(db, 's1', now) as LiveAgentCard
    expect(card.status).toBe('tool')
    expect(card.action).toContain('Bash')
    expect(card.action).toContain('5 秒')
    expect(card.projectName).toBe('demo')
    db.close()
  })

  it('请求进行中且无首 token → waiting；有首 token → thinking', () => {
    const db = buildZcodeDb(join(dir, 'z', 'db.sqlite'))
    const now = Date.now()
    db.prepare(`INSERT INTO model_usage (session_id, model_id, started_at, status, input_tokens, output_tokens)
      VALUES ('s1','GLM-5.3',?,NULL,0,0)`).run(now - 8_000)
    expect((__internals.zcodeSessionCard(db, 's1', now) as LiveAgentCard).status).toBe('waiting')

    db.prepare(`UPDATE model_usage SET first_token_at = ?`).run(now - 4_000)
    const card = __internals.zcodeSessionCard(db, 's1', now) as LiveAgentCard
    expect(card.status).toBe('thinking')
    expect(card.action).toContain('生成回复中')
    db.close()
  })

  it('最近模型请求 error → 异常态带详情', () => {
    const db = buildZcodeDb(join(dir, 'z', 'db.sqlite'))
    const now = Date.now()
    db.prepare(`INSERT INTO model_usage (session_id, model_id, started_at, completed_at, status, error_message)
      VALUES ('s1','GLM-5.3',?,?,'error','rate limit exceeded')`).run(now - 30_000, now - 20_000)
    const card = __internals.zcodeSessionCard(db, 's1', now) as LiveAgentCard
    expect(card.status).toBe('error')
    expect(card.anomaly).toContain('rate limit')
    db.close()
  })

  it('30 秒前正常完成且无进行中 → idle；动作含用户消息前 20 字', () => {
    const db = buildZcodeDb(join(dir, 'z', 'db.sqlite'))
    const now = Date.now()
    db.prepare(`INSERT INTO model_usage (session_id, model_id, started_at, completed_at, status, input_tokens, output_tokens)
      VALUES ('s1','GLM-5.3',?,?,'completed',1000,50)`).run(now - 300_000, now - 240_000)
    db.prepare(`INSERT INTO message (id, session_id, time_created, data) VALUES ('m1','s1',?,?)`).run(
      now - 300_000,
      JSON.stringify({ role: 'user', semantics: { origin: 'user' } })
    )
    db.prepare(`INSERT INTO part (id, message_id, session_id, data) VALUES ('p1','m1','s1',?)`).run(
      JSON.stringify({ type: 'text', text: '帮我看看这个报错是什么原因造成的呢' })
    )
    const card = __internals.zcodeSessionCard(db, 's1', now) as LiveAgentCard
    expect(card.status).toBe('idle')
    expect(card.action).toContain('最后活动')
    db.close()
  })

  it('任务完成后长时间无活动（>5 分钟）→ 空闲而非异常', () => {
    const db = buildZcodeDb(join(dir, 'z', 'db.sqlite'))
    const now = Date.now()
    db.prepare(`INSERT INTO model_usage (session_id, model_id, started_at, completed_at, status, input_tokens, output_tokens)
      VALUES ('s1','GLM-5.3',?,?,'completed',1000,50)`).run(now - 40 * 60_000, now - 38 * 60_000)
    const card = __internals.zcodeSessionCard(db, 's1', now) as LiveAgentCard
    expect(card.status).toBe('idle')
    expect(card.anomaly).toBeUndefined()
    db.close()
  })

  it('进行中请求超过 5 分钟未返回 → 异常（挂起）', () => {
    const db = buildZcodeDb(join(dir, 'z', 'db.sqlite'))
    const now = Date.now()
    db.prepare(`INSERT INTO model_usage (session_id, model_id, started_at, status, input_tokens, output_tokens)
      VALUES ('s1','GLM-5.3',?,NULL,0,0)`).run(now - 8 * 60_000)
    const card = __internals.zcodeSessionCard(db, 's1', now) as LiveAgentCard
    expect(card.status).toBe('error')
    expect(card.anomaly).toContain('未响应')
    db.close()
  })

  it('running 工具超过 5 分钟 → 异常（卡死）', () => {
    const db = buildZcodeDb(join(dir, 'z', 'db.sqlite'))
    const now = Date.now()
    db.prepare(`INSERT INTO tool_usage (session_id, tool_name, started_at, status)
      VALUES ('s1','Bash',?,'running')`).run(now - 7 * 60_000)
    const card = __internals.zcodeSessionCard(db, 's1', now) as LiveAgentCard
    expect(card.status).toBe('error')
    expect(card.anomaly).toContain('未返回')
    db.close()
  })
})

describe('Codex 尾部解析', () => {
  it('近期工具调用 → tool 态；用户消息驱动任务起点', () => {
    const f = join(dir, 'rollout-test.jsonl')
    const now = Date.now()
    const iso = (t: number): string => new Date(t).toISOString()
    writeFileSync(
      f,
      [
        JSON.stringify({ timestamp: iso(now - 60_000), type: 'session_meta', payload: { session_id: 'cs1', cwd: 'C:/w/proj' } }),
        JSON.stringify({ timestamp: iso(now - 50_000), type: 'turn_context', payload: { model: 'gpt-5.6-sol', cwd: 'C:/w/proj' } }),
        JSON.stringify({ timestamp: iso(now - 40_000), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '帮我修一下登录页的样式问题吧' }] } }),
        JSON.stringify({ timestamp: iso(now - 10_000), type: 'response_item', payload: { type: 'custom_tool_call', name: 'read_file' } })
      ].join('\n') + '\n',
      'utf8'
    )
    const card = __internals.codexFileCard(f, require('node:fs').statSync(f).size, now, now) as LiveAgentCard
    expect(card.status).toBe('tool')
    expect(card.action).toContain('read_file')
    expect(card.model).toBe('gpt-5.6-sol')
    expect(card.projectName).toBe('proj')
    expect(card.logFilePath).toBe(f)
  })

  it('超 30 秒无活动 → idle；error 事件 → 异常', () => {
    const f = join(dir, 'rollout-idle.jsonl')
    const now = Date.now()
    const iso = (t: number): string => new Date(t).toISOString()
    writeFileSync(
      f,
      JSON.stringify({ timestamp: iso(now - 120_000), type: 'event_msg', payload: { type: 'task_complete' } }) + '\n',
      'utf8'
    )
    const idle = __internals.codexFileCard(f, require('node:fs').statSync(f).size, now, now) as LiveAgentCard
    expect(idle.status).toBe('idle')

    const f2 = join(dir, 'rollout-err.jsonl')
    writeFileSync(
      f2,
      [
        JSON.stringify({ timestamp: iso(now - 5_000), type: 'event_msg', payload: { type: 'error', message: 'connection reset' } })
      ].join('\n') + '\n',
      'utf8'
    )
    const err = __internals.codexFileCard(f2, require('node:fs').statSync(f2).size, now, now) as LiveAgentCard
    expect(err.status).toBe('error')
    expect(err.anomaly).toContain('connection reset')
  })
})
