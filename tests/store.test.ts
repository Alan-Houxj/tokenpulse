import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Store } from '@core/store/sqlite'
import type { UsageEvent } from '@core/model/types'

let dir: string
let store: Store

function ev(partial: Partial<UsageEvent> & { id: string }): UsageEvent {
  return {
    ts: 1_700_000_000_000,
    agent: 'codex',
    sessionId: 's1',
    model: 'gpt-5.1',
    tokens: { input: 1000, output: 200, reasoning: 0, cacheRead: 5000, cacheWrite: 0 },
    costEstUSD: 0.01,
    ...partial
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agentmeter-test-'))
  store = Store.open(join(dir, 'test.db'))
})

afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('Store', () => {
  it('幂等写入：相同 id 重复插入被跳过', () => {
    const e = ev({ id: 'codex:s1:r1' })
    expect(store.insertEvents([e])).toEqual({ inserted: 1, skipped: 0 })
    expect(store.insertEvents([e])).toEqual({ inserted: 0, skipped: 1 })
    expect(store.eventCount()).toBe(1)
  })

  it('批量写入 >500 条也正确分批提交', () => {
    const events = Array.from({ length: 1200 }, (_, i) =>
      ev({ id: `codex:s1:r${i}`, ts: 1_700_000_000_000 + i * 1000 })
    )
    const r = store.insertEvents(events)
    expect(r.inserted).toBe(1200)
    expect(store.eventCount()).toBe(1200)
  })

  it('file_positions 位点存取往返', () => {
    expect(store.getFileOffset('codex', 'C:/a/b.jsonl')).toBe(0)
    store.saveFileOffset('codex', 'C:/a/b.jsonl', 4096, 8192, 12345)
    expect(store.getFileOffset('codex', 'C:/a/b.jsonl')).toBe(4096)
    const pos = store.getFilePositions('codex')
    expect(pos.get('C:/a/b.jsonl')).toEqual({ size: 8192, mtimeMs: 12345 })
  })

  it('overview 按时间范围与 Agent 维度聚合', () => {
    const day = 86_400_000
    const base = Date.UTC(2026, 8, 1) // 2026-09-01
    store.insertEvents([
      ev({ id: 'a:1', agent: 'codex', ts: base + 1000, tokens: { input: 100, output: 50, reasoning: 0, cacheRead: 0, cacheWrite: 0 } }),
      ev({ id: 'a:2', agent: 'codex', ts: base + day + 1000, tokens: { input: 10, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0 } }),
      ev({ id: 'b:1', agent: 'zcode', ts: base + 2000, model: 'GLM-5.3', tokens: { input: 200, output: 80, reasoning: 20, cacheRead: 1000, cacheWrite: 100 } })
    ])

    const all = store.overview({ from: base, to: base + 2 * 86_400_000 })
    expect(all.totals.total).toBe(100 + 50 + 10 + 5 + 200 + 80 + 20 + 1000 + 100)
    expect(all.byAgent.map((a) => a.agent).sort()).toEqual(['codex', 'zcode'])
    const zcode = all.byAgent.find((a) => a.agent === 'zcode')!
    expect(zcode.displayName).toBe('ZCode')
    expect(zcode.totals.cacheRead).toBe(1000)

    const day1 = store.overview({ from: base, to: base + day })
    expect(day1.totals.total).toBe(100 + 50 + 200 + 80 + 20 + 1000 + 100)
  })

  it('trend 按天分桶且空区间返回空数组', () => {
    const base = Date.UTC(2026, 8, 1, 10)
    store.insertEvents([
      ev({ id: 'a:1', ts: base }),
      ev({ id: 'a:2', ts: base + 3600_000 }),
      ev({ id: 'a:3', ts: base + 86_400_000 })
    ])
    const points = store.trend({ from: base, to: base + 2 * 86_400_000 }, 'day')
    expect(points).toHaveLength(2)
    // 每条事件 1000+200+5000 = 6200
    expect(points[0]!.total).toBe(12_400)
    const hours = store.trend({ from: base, to: base + 2 * 3600_000 }, 'hour')
    expect(hours).toHaveLength(2)
    expect(store.trend({ from: 0, to: 1 }, 'day')).toEqual([])
  })

  it('trendByModel 按 bucket+model 分组', () => {
    const base = Date.UTC(2026, 8, 1, 10)
    store.insertEvents([
      ev({ id: 'm:1', ts: base, model: 'GLM-5.3' }),
      ev({ id: 'm:2', ts: base + 1000, model: 'gpt-5.1' }),
      ev({ id: 'm:3', ts: base + 86_400_000, model: 'GLM-5.3' })
    ])
    const rows = store.trendByModel({ from: base, to: base + 2 * 86_400_000 }, 'day')
    expect(rows).toHaveLength(3) // GLM 两天 + gpt 一天
    const glmTotal = rows.filter((r) => r.model === 'glm-5.3').reduce((s, r) => s + r.total, 0)
    expect(glmTotal).toBe(12_400)
    expect(rows.find((r) => r.model === 'gpt-5.1')!.total).toBe(6_200)
  })

  it('sessions 聚合出项目路径与模型列表', () => {
    store.insertEvents([
      ev({ id: 'a:1', sessionId: 's1', projectPath: 'C:/proj/x', model: 'gpt-5.1' }),
      ev({ id: 'a:2', sessionId: 's1', projectPath: 'C:/proj/x', model: 'gpt-5.2' }),
      ev({ id: 'a:3', sessionId: 's2', agent: 'zcode', model: 'GLM-5.3' })
    ])
    const rows = store.sessions()
    expect(rows).toHaveLength(2)
    const s1 = rows.find((r) => r.sessionId === 's1')!
    expect(s1.models.sort()).toEqual(['gpt-5.1', 'gpt-5.2'])
    expect(s1.projectPath).toBe('C:/proj/x')
    expect(s1.totals.total).toBe(12_400)
  })

  it('migrateZcodeInputV2 拆分含缓存的历史输入且不影响其他 Agent', () => {
    store.insertEvents([
      ev({ id: 'mig:1', agent: 'zcode', model: 'GLM-5.3', tokens: { input: 1000, output: 10, reasoning: 0, cacheRead: 800, cacheWrite: 0 } }),
      ev({ id: 'mig:2', agent: 'codex', tokens: { input: 1000, output: 10, reasoning: 0, cacheRead: 800, cacheWrite: 0 } }) // codex 口径本来就对
    ])
    const n = store.migrateZcodeInputV2()
    expect(n).toBe(1)
    const rows = store.sessions(10, 0)
    const z = rows.find((r) => r.agent === 'zcode')!
    const c = rows.find((r) => r.agent === 'codex')!
    expect(z.totals.input).toBe(200)
    expect(c.totals.input).toBe(1000) // 不动
  })

  it('recomputeCosts 按新价格表重算历史', () => {
    store.insertEvents([ev({ id: 'rc:1', model: 'gpt-5.1', tokens: { input: 1_000_000, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, costEstUSD: 0 })])
    // 用自定义完整价格表（gpt-5 档 input=2）重算
    const n = store.recomputeCosts({ 'gpt-5': { input: 2, output: 0, cacheRead: 0, cacheWrite: 0 } })
    expect(n).toBe(1)
    const rows = store.sessions(10, 0)
    const gptRow = rows.find((r) => r.models.includes('gpt-5.1'))!
    expect(gptRow.totals.costEstUSD).toBe(2) // 1M input × $2
  })

  it('activeSessions 按会话合并，吞吐 = Σtoken ÷ Σ请求耗时', () => {
    const now = Date.now()
    store.insertEvents([
      // 两条带耗时：6200 tok / 2s + 6200 tok / 4s → 吞吐 = 12400 / 6 ≈ 2067 tok/s
      ev({ id: 'a:1', sessionId: 's1', model: 'gpt-5.1', ts: now - 1000, durationMs: 2000 }),
      ev({ id: 'a:2', sessionId: 's1', model: 'gpt-5.2', ts: now - 2 * 60_000, durationMs: 4000 }),
      // 无耗时的事件不参与吞吐
      ev({ id: 'a:3', sessionId: 's1', model: 'gpt-5.1', ts: now - 3 * 60_000 }),
      ev({ id: 'a:4', sessionId: 's2', ts: now - 90 * 60_000 }) // 出窗
    ])
    const active = store.activeSessions(60 * 60_000, now)
    expect(active).toHaveLength(1)
    expect(active[0]!.model).toBe('gpt-5.1') // 取最近事件的模型
    expect(active[0]!.recentTokens).toBe(18_600)
    expect(active[0]!.tokensPerSec).toBe(2067)

    // 全部无耗时 → null（数据源不支持）
    store.insertEvents([ev({ id: 'b:1', sessionId: 's9', ts: now - 1000 })])
    const withNull = store.activeSessions(60 * 60_000, now)
    expect(withNull.find((r) => r.sessionId === 's9')!.tokensPerSec).toBeNull()
  })

  it('模型名大小写合并：GLM-5.3 与 glm-5.3 入库后是同一行', () => {
    const base = 1_700_000_000_000
    store.insertEvents([
      ev({ id: 'z:1', agent: 'zcode', sessionId: 's1', model: 'GLM-5.3' }),
      ev({ id: 'c:1', agent: 'codex', sessionId: 's2', model: 'glm-5.3' }),
      ev({ id: 'z:2', agent: 'zcode', sessionId: 's1', model: 'GLM-5.3-20260901' })
    ])
    const ov = store.overview({ from: base - 1000, to: base + 2 * 86_400_000 })
    // 大小写统一、日期后缀剥掉 → 三条合成一行
    expect(ov.byModel).toHaveLength(1)
    expect(ov.byModel[0]!.model).toBe('glm-5.3')
    expect(ov.byModel[0]!.totals.eventCount).toBe(3)
  })

  it('迁移 v6：存量大小写混合的模型名统一为小写', () => {
    store.insertEvents([ev({ id: 'z:1', agent: 'zcode', sessionId: 's1', model: 'legacy' })])
    store.close()
    const db = new DatabaseSync(join(dir, 'test.db'))
    db.prepare(
      `INSERT INTO events (id, ts, agent, session_id, model, input_tokens, output_tokens, reasoning_tokens, cache_read_tokens, cache_write_tokens, cost_est_usd)
       VALUES ('raw:1', 1, 'zcode', 's1', 'GLM-5.3', 0,0,0,0,0, 0)`
    ).run()
    db.close()
    store = Store.open(join(dir, 'test.db'))
    const changed = store.migrateModelCaseV6()
    expect(changed).toBe(1)
    const ov = store.overview({ from: 0, to: 9e15 })
    expect(ov.byModel.filter((m) => m.model.includes('5.3')).map((m) => m.model)).toEqual(['glm-5.3'])
  })
})
