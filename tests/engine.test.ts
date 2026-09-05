import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  Store,
  CodexAdapter,
  estimateCost,
  normalizeModelId,
  applyCostEstimates,
  probeAdapter,
  UsageScheduler,
  defaultConfig
} from '@core/index'
import type { UsageEvent } from '@core/index'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agentmeter-engine-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('成本引擎', () => {
  it('四类 token 分别计价', () => {
    // sonnet-4-5: in 3 / out 15 / cacheRead 0.3 / cacheWrite 3.75（每 1M）
    const cost = estimateCost('claude-sonnet-4-5-20250929', {
      input: 1_000_000,
      output: 1_000_000,
      reasoning: 0,
      cacheRead: 1_000_000,
      cacheWrite: 1_000_000
    })
    expect(cost).toBeCloseTo(3 + 15 + 0.3 + 3.75, 4)
  })

  it('模型名归一化聚档', () => {
    expect(normalizeModelId('claude-sonnet-4-5-20250929')).toBe('claude-sonnet-4-5')
    expect(normalizeModelId('Claude-Opus-4-1-20250805')).toBe('claude-opus-4-1')
    expect(normalizeModelId('claude-fable-5-1')).toBe('claude-fable-5-1')
    expect(normalizeModelId('gpt-5.6-sol')).toBe('gpt-5.6-sol')
    expect(normalizeModelId('gpt-5.6-terra-fast')).toBe('gpt-5.6-terra')
    expect(normalizeModelId('codex-auto-review')).toBe('gpt-5.3-codex') // 推断映射
    expect(normalizeModelId('GLM-5.3')).toBe('glm-5.3')
    expect(normalizeModelId('GLM-5.3-Flash')).toBe('glm-5.3-flash')
    expect(normalizeModelId('gemini-2.5-pro-latest')).toBe('gemini-2.5-pro')
    expect(normalizeModelId('qwen3-coder-plus')).toBe('qwen3-coder-plus')
  })

  it('未知模型返回 null 并被 applyCostEstimates 收集', () => {
    const ev: UsageEvent = {
      id: 'x:s:r', ts: 1, agent: 'codex', sessionId: 's', model: 'totally-unknown-model',
      tokens: { input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, costEstUSD: 0
    }
    expect(estimateCost('totally-unknown-model', ev.tokens)).toBeNull()
    const { events, unpricedModels } = applyCostEstimates([ev])
    expect(events[0]!.costEstUSD).toBe(0)
    expect(unpricedModels.has('totally-unknown-model')).toBe(true)
  })
})

describe('四态探测', () => {
  it('absent / empty / ok 三态', async () => {
    // absent：根不存在
    const absent = await probeAdapter(new CodexAdapter({ roots: [join(dir, 'nope')] }))
    expect(absent.status).toBe('absent')

    // empty：根存在但没有 rollout 文件
    const emptyRoot = join(dir, '.codex')
    mkdirSync(join(emptyRoot, 'sessions'), { recursive: true })
    const empty = await probeAdapter(new CodexAdapter({ roots: [emptyRoot] }))
    expect(empty.status).toBe('empty')

    // ok：有可解析文件
    const d = join(emptyRoot, 'sessions', '2026', '09', '04')
    mkdirSync(d, { recursive: true })
    writeFileSync(
      join(d, 'rollout-test.jsonl'),
      JSON.stringify({
        timestamp: '2026-09-04T10:00:00.000Z', type: 'token_usage_record',
        payload: { session_id: 's1', response_id: 'r1', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } }
      }) + '\n',
      'utf8'
    )
    const ok = await probeAdapter(new CodexAdapter({ roots: [emptyRoot] }))
    expect(ok.status).toBe('ok')
    expect(ok.fileCount).toBe(1)
    expect(ok.sessionCount).toBeGreaterThanOrEqual(1)
  })
})

describe('调度器端到端', () => {
  it('增量采集 → 幂等入库 → 追加后 5s 内再采集', async () => {
    const codexRoot = join(dir, '.codex', 'sessions', '2026', '09', '04')
    mkdirSync(codexRoot, { recursive: true })
    const f = join(codexRoot, 'rollout-e2e.jsonl')
    const rec = (rid: string, n: number) =>
      JSON.stringify({
        timestamp: `2026-09-04T10:0${n}:00.000Z`, type: 'token_usage_record',
        payload: { session_id: 'e2e', response_id: rid, usage: { input_tokens: 100, cached_input_tokens: 80, output_tokens: 20 } }
      }) + '\n'
    const ctx = JSON.stringify({
      timestamp: '2026-09-04T09:59:00.000Z', type: 'turn_context', payload: { model: 'gpt-5.1', cwd: 'C:/proj' }
    }) + '\n'
    writeFileSync(f, ctx + rec('r1', 1) + rec('r2', 2), 'utf8')

    const store = Store.open(join(dir, 'store', 'db.sqlite'))
    const ticks: number[] = []
    const scheduler = new UsageScheduler({
      adapters: [new CodexAdapter({ roots: [join(dir, '.codex')] })],
      store,
      intervalMs: 60_000, // 不让定时器干扰，手动 tick
      onTick: (s) => ticks.push(s.agents.reduce((a, x) => a + x.inserted, 0))
    })

    try {
      // 首次 tick：全量回填
      const t1 = await scheduler.tick()
      expect(t1.agents[0]!.inserted).toBe(2)
      expect(store.eventCount()).toBe(2)
      // 成本已回填（gpt-5 家族有价格）。上界放宽到未来一周，
      // 避免夹具时间戳与本机时区组合出"未来事件"被范围过滤
      const ov = store.overview({ from: 0, to: Date.now() + 7 * 86_400_000 })
      expect(ov.totals.costEstUSD).toBeGreaterThan(0)
      expect(ov.unpricedModels).toEqual([])

      // 无变化 tick：零新增
      const t2 = await scheduler.tick()
      expect(t2.agents[0]!.inserted).toBe(0)

      // 追加一条 → 只有 1 条新入库
      appendFileSync(f, rec('r3', 3))
      const t3 = await scheduler.tick()
      expect(t3.agents[0]!.inserted).toBe(1)
      expect(store.eventCount()).toBe(3)

      // 幂等：重复读同一文件不会重复入库
      const t4 = await scheduler.tick()
      expect(t4.agents[0]!.inserted).toBe(0)
      expect(store.eventCount()).toBe(3)
    } finally {
      scheduler.stop()
      store.close()
    }
  })
})

describe('配置', () => {
  it('默认配置可用且字段齐全', () => {
    const c = defaultConfig()
    expect(c.pollIntervalMs).toBe(5000)
    expect(c.roots).toEqual({})
    expect(c.onboarded).toBe(false)
  })
})
