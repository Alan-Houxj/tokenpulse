/**
 * 仓储层：我们自己的 SQLite 索引库。
 * - events 表：全量 UsageEvent，幂等键 PRIMARY KEY
 * - file_positions 表：每个数据文件的读取位点，断点增量
 * 聚合全部交给 SQL（几十万行量级毫秒级返回）。
 */
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import type {
  ActiveSessionRow,
  AgentId,
  IngestResult,
  OverviewSummary,
  SessionRow,
  TokenTotals,
  TrendPoint,
  TrendPointByModel,
  UsageEvent
} from '../model/types'
import { canonicalModelId, estimateCost, type PriceTable } from '../engine/cost'
import { openOwnDb, type DbDriver } from './dbDriver'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  agent TEXT NOT NULL,
  session_id TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL,
  cost_est_usd REAL NOT NULL DEFAULT 0,
  duration_ms INTEGER,
  project_path TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
CREATE INDEX IF NOT EXISTS idx_events_agent_ts ON events(agent, ts);
CREATE INDEX IF NOT EXISTS idx_events_session_ts ON events(session_id, ts);

CREATE TABLE IF NOT EXISTS file_positions (
  agent TEXT NOT NULL,
  file_path TEXT NOT NULL,
  byte_offset INTEGER NOT NULL DEFAULT 0,
  last_size INTEGER NOT NULL DEFAULT 0,
  last_mtime_ms INTEGER NOT NULL DEFAULT 0,
  state_json TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (agent, file_path)
);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`

function toTotals(r: Record<string, unknown> | undefined): TokenTotals {
  if (!r) {
    return {
      input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0,
      total: 0, costUSD: 0, costEstUSD: 0, eventCount: 0
    }
  }
  const input = Number(r['input_tokens'] ?? 0)
  const output = Number(r['output_tokens'] ?? 0)
  const reasoning = Number(r['reasoning_tokens'] ?? 0)
  const cacheRead = Number(r['cache_read_tokens'] ?? 0)
  const cacheWrite = Number(r['cache_write_tokens'] ?? 0)
  return {
    input, output, reasoning, cacheRead, cacheWrite,
    total: input + output + reasoning + cacheRead + cacheWrite,
    costUSD: Number(r['cost_usd'] ?? 0),
    costEstUSD: Number(r['cost_est_usd'] ?? 0),
    eventCount: Number(r['event_count'] ?? 0)
  }
}

const AGENT_DISPLAY: Record<AgentId, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  'gemini-cli': 'Gemini CLI',
  qwen: 'Qwen Code',
  zcode: 'ZCode'
}

export function agentDisplayName(agent: AgentId): string {
  return AGENT_DISPLAY[agent] ?? agent
}

const TOTALS_SQL = `
  SELECT
    COALESCE(SUM(input_tokens),0) AS input_tokens,
    COALESCE(SUM(output_tokens),0) AS output_tokens,
    COALESCE(SUM(reasoning_tokens),0) AS reasoning_tokens,
    COALESCE(SUM(cache_read_tokens),0) AS cache_read_tokens,
    COALESCE(SUM(cache_write_tokens),0) AS cache_write_tokens,
    COALESCE(SUM(cost_usd),0) AS cost_usd,
    COALESCE(SUM(cost_est_usd),0) AS cost_est_usd,
    COUNT(*) AS event_count
  FROM events
`

export class Store {
  private constructor(private readonly db: DbDriver) {}

  static open(dbPath: string): Store {
    mkdirSync(dirname(dbPath), { recursive: true })
    const db = openOwnDb(dbPath)
    db.exec(SCHEMA)
    // 旧库列迁移：file_positions.state_json（v0.3.1 加入）
    const cols = db.prepare('PRAGMA table_info(file_positions)').all()
    if (!cols.some((c) => String(c['name']) === 'state_json')) {
      db.exec('ALTER TABLE file_positions ADD COLUMN state_json TEXT')
    }
    return new Store(db)
  }

  close(): void {
    this.db.close()
  }

  // ---------- 写入 ----------

  /** 批量幂等写入；单事务 + INSERT OR IGNORE，重复采集安全 */
  insertEvents(events: UsageEvent[]): IngestResult {
    if (events.length === 0) return { inserted: 0, skipped: 0 }
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO events
        (id, ts, agent, session_id, model,
         input_tokens, output_tokens, reasoning_tokens, cache_read_tokens, cache_write_tokens,
         cost_usd, cost_est_usd, duration_ms, project_path)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    let inserted = 0
    // 500 一批，兼顾吞吐与长事务
    for (let i = 0; i < events.length; i += 500) {
      const chunk = events.slice(i, i + 500)
      this.db.transaction(() => {
        for (const e of chunk) {
          const r = stmt.run(
            e.id, e.ts, e.agent, e.sessionId, canonicalModelId(e.model),
            e.tokens.input, e.tokens.output, e.tokens.reasoning,
            e.tokens.cacheRead, e.tokens.cacheWrite,
            e.costUSD ?? null, e.costEstUSD,
            e.durationMs ?? null, e.projectPath ?? null
          )
          inserted += r.changes
        }
      })
    }
    return { inserted, skipped: events.length - inserted }
  }

  getFileOffset(agent: AgentId, filePath: string): number {
    const r = this.db
      .prepare('SELECT byte_offset FROM file_positions WHERE agent = ? AND file_path = ?')
      .get(agent, filePath)
    return r ? Number(r['byte_offset']) : 0
  }

  /** 取回适配器的解析状态（跨增量段保持行内状态，如 Codex 当前模型） */
  getFileState(agent: AgentId, filePath: string): unknown {
    const r = this.db
      .prepare('SELECT state_json FROM file_positions WHERE agent = ? AND file_path = ?')
      .get(agent, filePath)
    if (!r || r['state_json'] == null) return undefined
    try {
      return JSON.parse(String(r['state_json']))
    } catch {
      return undefined
    }
  }

  saveFileOffset(
    agent: AgentId,
    filePath: string,
    offset: number,
    size: number,
    mtimeMs: number,
    state?: unknown
  ): void {
    const stateJson = state === undefined ? null : JSON.stringify(state)
    this.db.prepare(`
      INSERT INTO file_positions (agent, file_path, byte_offset, last_size, last_mtime_ms, state_json, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(agent, file_path) DO UPDATE SET
        byte_offset = excluded.byte_offset,
        last_size = excluded.last_size,
        last_mtime_ms = excluded.last_mtime_ms,
        state_json = excluded.state_json,
        updated_at = excluded.updated_at
    `).run(agent, filePath, offset, size, mtimeMs, stateJson, Date.now())
  }

  getFilePositions(agent: AgentId): Map<string, { size: number; mtimeMs: number }> {
    const rows = this.db
      .prepare('SELECT file_path, last_size, last_mtime_ms FROM file_positions WHERE agent = ?')
      .all(agent)
    const m = new Map<string, { size: number; mtimeMs: number }>()
    for (const r of rows) {
      m.set(String(r['file_path']), {
        size: Number(r['last_size']),
        mtimeMs: Number(r['last_mtime_ms'])
      })
    }
    return m
  }

  // ---------- 聚合查询 ----------

  private where(range: { from: number; to: number }): string {
    return `WHERE ts >= ${Math.floor(range.from)} AND ts < ${Math.floor(range.to)}`
  }

  overview(range: { from: number; to: number }): OverviewSummary {
    const w = this.where(range)
    const totals = toTotals(this.db.prepare(`${TOTALS_SQL} ${w}`).get())

    const byAgentRows = this.db.prepare(`
      SELECT agent,
        SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
        SUM(reasoning_tokens) AS reasoning_tokens,
        SUM(cache_read_tokens) AS cache_read_tokens, SUM(cache_write_tokens) AS cache_write_tokens,
        SUM(cost_usd) AS cost_usd, SUM(cost_est_usd) AS cost_est_usd,
        COUNT(*) AS event_count
      FROM events ${w} GROUP BY agent ORDER BY event_count DESC
    `).all()

    const byModelRows = this.db.prepare(`
      SELECT model,
        SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
        SUM(reasoning_tokens) AS reasoning_tokens,
        SUM(cache_read_tokens) AS cache_read_tokens, SUM(cache_write_tokens) AS cache_write_tokens,
        SUM(cost_usd) AS cost_usd, SUM(cost_est_usd) AS cost_est_usd,
        COUNT(*) AS event_count
      FROM events ${w} GROUP BY model ORDER BY event_count DESC LIMIT 50
    `).all()

    return {
      range,
      totals,
      byAgent: byAgentRows.map((r) => ({
        agent: String(r['agent']) as AgentId,
        displayName: agentDisplayName(String(r['agent']) as AgentId),
        totals: toTotals(r)
      })),
      byModel: byModelRows.map((r) => ({
        model: String(r['model']),
        totals: toTotals(r)
      })),
      unpricedModels: byModelRows
        .filter((r) => Number(r['cost_est_usd']) === 0 && Number(r['event_count']) > 0)
        .map((r) => String(r['model']))
    }
  }

  /** 趋势序列。bucket='hour' | 'day'，按本地时区分桶 */
  trend(range: { from: number; to: number }, bucket: 'hour' | 'day'): TrendPoint[] {
    const fmt = bucket === 'hour' ? '%Y-%m-%dT%H:00:00' : '%Y-%m-%dT00:00:00'
    const rows = this.db.prepare(`
      SELECT
        strftime('${fmt}', ts / 1000, 'unixepoch', 'localtime') AS bucket,
        SUM(input_tokens + output_tokens + reasoning_tokens + cache_read_tokens + cache_write_tokens) AS total_tokens,
        SUM(input_tokens) AS input_tokens,
        SUM(output_tokens) AS output_tokens,
        SUM(cache_read_tokens) AS cache_read_tokens,
        SUM(cost_est_usd) AS cost_est_usd
      FROM events ${this.where(range)}
      GROUP BY bucket ORDER BY bucket
    `).all()
    return rows.map((r) => ({
      bucketStart: new Date(String(r['bucket'])).getTime(),
      total: Number(r['total_tokens'] ?? 0),
      input: Number(r['input_tokens'] ?? 0),
      output: Number(r['output_tokens'] ?? 0),
      cacheRead: Number(r['cache_read_tokens'] ?? 0),
      costEstUSD: Number(r['cost_est_usd'] ?? 0)
    }))
  }

  /** 趋势序列（按模型分组，用于分模型堆叠视图） */
  trendByModel(range: { from: number; to: number }, bucket: 'hour' | 'day'): TrendPointByModel[] {
    const fmt = bucket === 'hour' ? '%Y-%m-%dT%H:00:00' : '%Y-%m-%dT00:00:00'
    const rows = this.db.prepare(`
      SELECT
        strftime('${fmt}', ts / 1000, 'unixepoch', 'localtime') AS bucket,
        model,
        SUM(input_tokens + output_tokens + reasoning_tokens + cache_read_tokens + cache_write_tokens) AS total_tokens,
        SUM(cost_est_usd) AS cost_est_usd
      FROM events ${this.where(range)}
      GROUP BY bucket, model ORDER BY bucket
    `).all()
    return rows.map((r) => ({
      bucketStart: new Date(String(r['bucket'])).getTime(),
      model: String(r['model']),
      total: Number(r['total_tokens'] ?? 0),
      costEstUSD: Number(r['cost_est_usd'] ?? 0)
    }))
  }

  /** 会话明细（按 agent+session 聚合，可按时间范围 / agent / 模型过滤） */
  sessions(
    limit = 200,
    offset = 0,
    range?: { from: number; to: number },
    filters?: { agent?: string; model?: string }
  ): SessionRow[] {
    const conds: string[] = []
    if (range) conds.push(this.where(range).replace(/^WHERE /, ''))
    if (filters?.agent) conds.push(`agent = '${filters.agent.replace(/'/g, "''")}'`)
    if (filters?.model) conds.push(`model LIKE '%${filters.model.replace(/'/g, "''")}%'`)
    const w = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : ''
    const rows = this.db.prepare(`
      SELECT agent, session_id,
        MIN(ts) AS first_ts, MAX(ts) AS last_ts,
        SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
        SUM(reasoning_tokens) AS reasoning_tokens,
        SUM(cache_read_tokens) AS cache_read_tokens, SUM(cache_write_tokens) AS cache_write_tokens,
        SUM(cost_usd) AS cost_usd, SUM(cost_est_usd) AS cost_est_usd,
        COUNT(*) AS event_count,
        GROUP_CONCAT(DISTINCT model) AS models,
        (SELECT project_path FROM events e2
          WHERE e2.session_id = events.session_id AND e2.project_path IS NOT NULL
          LIMIT 1) AS project_path
      FROM events ${w}
      GROUP BY agent, session_id
      ORDER BY last_ts DESC
      LIMIT ? OFFSET ?
    `).all(limit, offset)
    return rows.map((r) => ({
      agent: String(r['agent']) as AgentId,
      sessionId: String(r['session_id']),
      projectPath: r['project_path'] ? String(r['project_path']) : undefined,
      models: String(r['models'] ?? '').split(',').filter(Boolean),
      firstTs: Number(r['first_ts']),
      lastTs: Number(r['last_ts']),
      totals: toTotals(r)
    }))
  }

  /** 全部出现过的模型名（筛选下拉用） */
  distinctModels(): string[] {
    return this.db
      .prepare('SELECT DISTINCT model FROM events ORDER BY model')
      .all()
      .map((r) => String(r['model']))
  }

  /** 活动看板兜底：近窗口内有事件的其他 Agent 会话 */
  recentSessionsForLive(windowMs: number, now: number): {
    agent: AgentId
    sessionId: string
    projectPath?: string
    model: string
    lastTs: number
    tokens: number
  }[] {
    const rows = this.db
      .prepare(
        `SELECT agent, session_id, MAX(ts) AS last_ts,
           SUM(input_tokens+output_tokens+reasoning_tokens+cache_read_tokens+cache_write_tokens) AS tokens,
           (SELECT model FROM events e2 WHERE e2.session_id = events.session_id ORDER BY e2.ts DESC LIMIT 1) AS model,
           (SELECT project_path FROM events e3 WHERE e3.session_id = events.session_id AND e3.project_path IS NOT NULL LIMIT 1) AS project_path
         FROM events WHERE ts >= ?
         GROUP BY agent, session_id ORDER BY last_ts DESC LIMIT 20`
      )
      .all(now - windowMs)
    return rows.map((r) => ({
      agent: String(r['agent']) as AgentId,
      sessionId: String(r['session_id']),
      projectPath: r['project_path'] ? String(r['project_path']) : undefined,
      model: String(r['model'] ?? 'unknown'),
      lastTs: Number(r['last_ts']),
      tokens: Number(r['tokens'] ?? 0)
    }))
  }

  /** 侧滑面板：某会话最近 N 条请求（倒序时间轴） */
  sessionTimeline(agent: string, sessionId: string, limit = 20): {
    ts: number
    model: string
    tokens: number
    costEstUSD: number
    durationMs?: number
  }[] {
    const rows = this.db
      .prepare(
        `SELECT ts, model, input_tokens+output_tokens+reasoning_tokens+cache_read_tokens+cache_write_tokens AS tokens,
                cost_est_usd, duration_ms
         FROM events WHERE agent = ? AND session_id = ?
         ORDER BY ts DESC LIMIT ?`
      )
      .all(agent, sessionId, limit)
    return rows.map((r) => ({
      ts: Number(r['ts']),
      model: String(r['model']),
      tokens: Number(r['tokens']),
      costEstUSD: Number(r['cost_est_usd'] ?? 0),
      durationMs: r['duration_ms'] != null ? Number(r['duration_ms']) : undefined
    }))
  }

  /** 实时页：窗口期内有活动的会话 + 请求吞吐（Σtoken ÷ Σ请求耗时，无耗时数据为 null） */
  activeSessions(windowMs = 60 * 60_000, now = Date.now()): ActiveSessionRow[] {
    const since = now - windowMs
    const rows = this.db.prepare(`
      SELECT agent, session_id, MAX(ts) AS last_ts,
        SUM(input_tokens + output_tokens + reasoning_tokens + cache_read_tokens + cache_write_tokens) AS recent_tokens,
        SUM(CASE WHEN duration_ms > 0 THEN
          input_tokens + output_tokens + reasoning_tokens + cache_read_tokens + cache_write_tokens ELSE 0 END) AS dur_tokens,
        SUM(CASE WHEN duration_ms > 0 THEN duration_ms ELSE 0 END) AS dur_ms,
        (SELECT model FROM events e2
          WHERE e2.session_id = events.session_id ORDER BY e2.ts DESC LIMIT 1) AS model,
        (SELECT project_path FROM events e2
          WHERE e2.session_id = events.session_id AND e2.project_path IS NOT NULL LIMIT 1) AS project_path
      FROM events WHERE ts >= ${Math.floor(since)}
      GROUP BY agent, session_id
      ORDER BY last_ts DESC
    `).all()
    return rows.map((r) => {
      const durTokens = Number(r['dur_tokens'] ?? 0)
      const durMs = Number(r['dur_ms'] ?? 0)
      return {
        agent: String(r['agent']) as AgentId,
        sessionId: String(r['session_id']),
        projectPath: r['project_path'] ? String(r['project_path']) : undefined,
        model: String(r['model'] ?? 'unknown'),
        lastTs: Number(r['last_ts']),
        recentTokens: Number(r['recent_tokens'] ?? 0),
        tokensPerSec: durMs > 0 ? Math.round(durTokens / (durMs / 1000)) : null
      }
    })
  }

  /** 回填进度用：当前事件总数 */
  eventCount(): number {
    const r = this.db.prepare('SELECT COUNT(*) AS c FROM events').get()
    return Number(r?.['c'] ?? 0)
  }

  getMeta(key: string): string | undefined {
    const r = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key)
    return r ? String(r['value']) : undefined
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value)
  }

  /**
   * 数据口径修正迁移 v2：ZCode 的 input_tokens 实为「含缓存读」口径（OpenAI 式），
   * v0.1 直接入库导致缓存双计。此迁移把 zcode 事件的 input 拆为非缓存值。
   */
  migrateZcodeInputV2(): number {
    const r = this.db
      .prepare(
        `UPDATE events SET input_tokens = MAX(0, input_tokens - cache_read_tokens)
         WHERE agent = 'zcode'`
      )
      .run()
    return r.changes
  }

  /**
   * 迁移 v3：清理 v0.3 之前产生的 model='unknown' 事件，并重置全部文件位点，
   * 让调度器重新全量回填（幂等键保证不重复；新代码会正确携带模型状态）。
   */
  migrateUnknownModelsV3(): { removedEvents: number; resetPositions: number } {
    const del = this.db.prepare(`DELETE FROM events WHERE model = 'unknown'`).run()
    const pos = this.db.prepare(`DELETE FROM file_positions`).run()
    return { removedEvents: del.changes, resetPositions: pos.changes }
  }

  /**
   * 迁移 v4：ZCode 适配器此前 JOIN 用错 session 表主键列名（session_id → 实为 id），
   * 历史事件 project_path 全部缺失。删除 zcode 事件与位点，重采自动带回路径。
   */
  migrateZcodePathsV4(): number {
    this.db.prepare(`DELETE FROM file_positions WHERE agent = 'zcode'`).run()
    return this.db.prepare(`DELETE FROM events WHERE agent = 'zcode'`).run().changes
  }

  /** 迁移 v5：重置 Codex 位点触发全量重扫（旧格式补采，幂等键防重） */
  resetCodexPositionsV5(): number {
    return this.db.prepare(`DELETE FROM file_positions WHERE agent = 'codex'`).run().changes
  }

  /**
   * 迁移 v6：模型名统一小写 + 去日期后缀。
   * v0.1 入库保留源大小写，ZCode 'GLM-5.3' 与 Codex 'glm-5.3' 在模型分布裂成两行。
   * 价格查表本就先小写归一化，历史 cost_est 无需重算。
   */
  migrateModelCaseV6(): number {
    const rows = this.db.prepare(`SELECT DISTINCT model FROM events`).all() as { model: string }[]
    const upd = this.db.prepare(`UPDATE events SET model = ? WHERE model = ?`)
    let changed = 0
    for (const r of rows) {
      const c = canonicalModelId(r.model)
      if (c !== r.model) changed += upd.run(c, r.model).changes
    }
    return changed
  }

  /**
   * 按给定价格表重算全部历史事件的估算成本。
   * 价格表更新 / 用户覆盖价格后调用，保证历史口径一致（事件量万级内毫秒完成）。
   */
  recomputeCosts(prices: PriceTable): number {
    const rows = this.db
      .prepare(
        `SELECT id, model, input_tokens, output_tokens, reasoning_tokens, cache_read_tokens, cache_write_tokens FROM events`
      )
      .all()
    const upd = this.db.prepare('UPDATE events SET cost_est_usd = ? WHERE id = ?')
    let n = 0
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500)
      this.db.transaction(() => {
        for (const r of chunk) {
          const est = estimateCost(
            String(r['model']),
            {
              input: Number(r['input_tokens'] ?? 0),
              output: Number(r['output_tokens'] ?? 0),
              reasoning: Number(r['reasoning_tokens'] ?? 0),
              cacheRead: Number(r['cache_read_tokens'] ?? 0),
              cacheWrite: Number(r['cache_write_tokens'] ?? 0)
            },
            prices
          )
          upd.run(est ?? 0, String(r['id']))
          n++
        }
      })
    }
    return n
  }

  firstTs(): number | undefined {
    const r = this.db.prepare('SELECT MIN(ts) AS m FROM events').get()
    const v = r?.['m']
    return v == null ? undefined : Number(v)
  }

  lastTs(): number | undefined {
    const r = this.db.prepare('SELECT MAX(ts) AS m FROM events').get()
    const v = r?.['m']
    return v == null ? undefined : Number(v)
  }
}

/** 解析我们自己的库文件默认路径（不依赖 Electron，测试可用） */
export function defaultDbPath(userDataDir: string): string {
  return resolve(userDataDir, 'agentmeter.db')
}
