/**
 * 采集调度器：准实时（默认 5s）增量采集。
 * 每 tick：发现文件 → 与上次签名(size+mtime)比对 → 变化者从位点增量读 → 估成本 → 幂等入库。
 * 文件间主动让出事件循环，回填 GB 级历史时也不冻结托盘/窗口。
 */
import type { SourceAdapter, UsageEvent } from '../model/types'
import type { Store } from '../store/sqlite'
import { applyCostEstimates, effectivePriceTable, type PriceOverrides, type PriceTable } from './cost'

export interface AgentTickSummary {
  agent: string
  displayName: string
  files: number
  inserted: number
  skipped: number
  errors: string[]
  durationMs: number
}

export interface TickSummary {
  startedAt: number
  durationMs: number
  agents: AgentTickSummary[]
  /** 本次新入库的事件（实时页推送用，上限截断） */
  freshEvents: UsageEvent[]
}

export interface SchedulerOptions {
  adapters: SourceAdapter[]
  store: Store
  intervalMs?: number
  prices?: PriceOverrides
  onTick?: (summary: TickSummary) => void
  /** 每处理多少个文件让出一次事件循环 */
  yieldEvery?: number
}

const FRESH_EVENTS_CAP = 200

export class UsageScheduler {
  private timer: ReturnType<typeof setInterval> | undefined
  private ticking = false
  private readonly opts: Required<Omit<SchedulerOptions, 'onTick' | 'adapters' | 'store' | 'prices'>> &
    SchedulerOptions & { prices: PriceTable }

  constructor(opts: SchedulerOptions) {
    this.opts = {
      intervalMs: opts.intervalMs ?? 5000,
      // opts.prices 语义是"覆盖项"，必须与内置表合成后使用
      prices: effectivePriceTable(opts.prices ?? {}),
      yieldEvery: opts.yieldEvery ?? 8,
      adapters: opts.adapters,
      store: opts.store,
      onTick: opts.onTick
    }
  }

  start(): void {
    if (this.timer) return
    void this.tick()
    this.timer = setInterval(() => void this.tick(), this.opts.intervalMs)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  async tick(): Promise<TickSummary> {
    if (this.ticking) return this.lastSummary ?? emptySummary()
    this.ticking = true
    const startedAt = Date.now()
    const agents: AgentTickSummary[] = []
    const fresh: UsageEvent[] = []

    for (const adapter of this.opts.adapters) {
      const s = await this.tickAdapter(adapter, fresh)
      agents.push(s)
    }

    const summary: TickSummary = {
      startedAt,
      durationMs: Date.now() - startedAt,
      agents,
      freshEvents: fresh.slice(0, FRESH_EVENTS_CAP)
    }
    this.lastSummary = summary
    this.ticking = false
    this.opts.onTick?.(summary)
    return summary
  }

  private lastSummary: TickSummary | undefined

  private async tickAdapter(adapter: SourceAdapter, fresh: UsageEvent[]): Promise<AgentTickSummary> {
    const t0 = Date.now()
    const summary: AgentTickSummary = {
      agent: adapter.id,
      displayName: adapter.displayName,
      files: 0,
      inserted: 0,
      skipped: 0,
      errors: [],
      durationMs: 0
    }
    try {
      const files = adapter.discover()
      summary.files = files.length
      const signatures = this.opts.store.getFilePositions(adapter.id)
      let sinceYield = 0

      for (const file of files) {
        const prev = signatures.get(file.path)
        // 签名未变：跳过（探测成本是一次 stat，已在 discover 里做过）
        if (prev && prev.size === file.size && prev.mtimeMs === file.mtimeMs) continue

        const offset = prev ? this.opts.store.getFileOffset(adapter.id, file.path) : 0
        const state = prev ? this.opts.store.getFileState(adapter.id, file.path) : undefined
        let read
        try {
          read = await adapter.readIncremental(file, offset, state)
        } catch (e) {
          summary.errors.push(`${file.path}: ${String(e)}`)
          continue
        }
        if (read.events.length > 0) {
          const { events } = applyCostEstimates(read.events, this.opts.prices)
          const r = this.opts.store.insertEvents(events)
          summary.inserted += r.inserted
          summary.skipped += r.skipped
          fresh.push(...events)
        }
        this.opts.store.saveFileOffset(adapter.id, file.path, read.endOffset, file.size, file.mtimeMs, read.state)

        if (++sinceYield >= this.opts.yieldEvery) {
          sinceYield = 0
          await new Promise((r) => setImmediate(r))
        }
      }
    } catch (e) {
      summary.errors.push(String(e))
    }
    summary.durationMs = Date.now() - t0
    return summary
  }
}

function emptySummary(): TickSummary {
  return { startedAt: Date.now(), durationMs: 0, agents: [], freshEvents: [] }
}
