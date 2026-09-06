/**
 * 活动看板引擎：从各数据源推断"此刻谁在跑、在干什么"。
 *
 * 状态推断优先级（每会话）：
 *   error（5 分钟内有错误记录） > tool（工具 running） > waiting/thinking（请求进行中）
 *   > idle（30 秒内无活动且最后为完成态）；> 5 分钟无日志且非空闲 → 异常
 *
 * 数据源分工：
 *   zcode  —— 源 SQLite 直查（tool_usage.status='running'、model_usage 进行中/错误、message+part 文本）
 *   codex  —— tail 最新 rollout jsonl 尾部，按行类型推断
 *   其余   —— 本库 events 近 60 分钟会话兜底（思考近似/空闲）
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Store } from '../store/sqlite'
import type { LiveAgentCard, LiveStatus } from '../model/types'
import { canonicalModelId } from './cost'
import { readLinesIncremental, parseJsonLine, walkFiles } from '../adapters/util'

const ACTIVITY_WINDOW_MS = 60 * 60_000 // 看板只显示近 1 小时内有活动的会话
const IDLE_AFTER_MS = 30_000
const STALE_AFTER_MS = 5 * 60_000

export function collectLiveAgents(store: Store): LiveAgentCard[] {
  const now = Date.now()
  const cards: LiveAgentCard[] = []
  try {
    cards.push(...zcodeLive(now))
  } catch {
    /* ZCode 源不可达则跳过 */
  }
  try {
    cards.push(...codexLive(now))
  } catch {
    /* 同上 */
  }
  cards.push(...genericLive(store, now))
  return cards
}

// ---------------- ZCode：SQLite 直查 ----------------

function zcodeLive(now: number): LiveAgentCard[] {
  const dbPath = join(homedir(), '.zcode', 'cli', 'db', 'db.sqlite')
  let db: DatabaseSync
  try {
    db = new DatabaseSync(dbPath, { readOnly: true })
    db.exec('PRAGMA busy_timeout = 3000')
  } catch {
    return []
  }

  try {
    const since = now - ACTIVITY_WINDOW_MS
    const sessionRows = db
      .prepare(
        `SELECT DISTINCT session_id FROM (
           SELECT session_id, started_at AS ts FROM model_usage
           UNION ALL SELECT session_id, started_at FROM tool_usage
           UNION ALL SELECT session_id, time_created AS ts FROM message
         ) WHERE session_id IS NOT NULL AND ts >= ? ORDER BY ts DESC LIMIT 12`
      )
      .all(since) as unknown as { session_id: string }[]

    const cards: LiveAgentCard[] = []
    for (const { session_id: sid } of sessionRows) {
      const card = zcodeSessionCard(db, sid, now)
      if (card) cards.push(card)
    }
    return cards
  } finally {
    db.close()
  }
}

function zcodeSessionCard(db: DatabaseSync, sid: string, now: number): LiveAgentCard | null {
  interface MuRow {
    model_id: string | null
    started_at: number | null
    first_token_at: number | null
    completed_at: number | null
    status: string | null
    input_tokens: number | null
    output_tokens: number | null
    reasoning_tokens: number | null
    cache_read_input_tokens: number | null
    cache_creation_input_tokens: number | null
    duration_ms: number | null
    error: string | null
  }
  const mu = db
    .prepare(
      `SELECT model_id, started_at, first_token_at, completed_at, status,
              input_tokens, output_tokens, reasoning_tokens, cache_read_input_tokens,
              cache_creation_input_tokens, duration_ms,
              COALESCE(NULLIF(error_message,''), status) AS error
       FROM model_usage WHERE session_id = ? ORDER BY started_at DESC LIMIT 1`
    )
    .get(sid) as unknown as MuRow | undefined

  interface ToolRow {
    tool_name: string | null
    started_at: number | null
    completed_at: number | null
    status: string | null
    error_type: string | null
    error_message: string | null
  }
  const runningTool = db
    .prepare(
      `SELECT tool_name, started_at, completed_at, status, error_type, error_message
       FROM tool_usage WHERE session_id = ? AND status = 'running'
       ORDER BY started_at DESC LIMIT 1`
    )
    .get(sid) as unknown as ToolRow | undefined
  const lastTool = db
    .prepare(
      `SELECT tool_name, started_at, completed_at, status, error_type, error_message
       FROM tool_usage WHERE session_id = ? ORDER BY started_at DESC LIMIT 1`
    )
    .get(sid) as unknown as ToolRow | undefined

  const lastUser = zcodeLastUserMessage(db, sid)
  const session = db
    .prepare('SELECT id, directory FROM session WHERE id = ?')
    .get(sid) as unknown as { directory: string | null } | undefined

  // 时间基准：各来源最近活动
  const candidates = [
    mu?.completed_at ?? mu?.started_at,
    runningTool?.started_at ?? lastTool?.completed_at ?? lastTool?.started_at,
    lastUser?.ts
  ].filter((t): t is number => typeof t === 'number' && t > 0)
  const lastActivityTs = Math.max(...(candidates.length > 0 ? candidates : [0]))
  if (lastActivityTs < Date.now() - ACTIVITY_WINDOW_MS) return null

  const model = mu?.model_id ? canonicalModelId(mu.model_id) : undefined
  const projectName = lastSegment(session?.directory ?? '')

  // 当前任务：最近用户消息之后算一个任务；没有则取最近 30 分钟
  const taskStartTs = lastUser?.ts && now - lastUser.ts < 6 * 3_600_000 ? lastUser.ts : lastActivityTs - 30 * 60_000
  const agg = db
    .prepare(
      `SELECT COALESCE(SUM(input_tokens+output_tokens+reasoning_tokens+cache_read_input_tokens+cache_creation_input_tokens),0) AS tokens,
              COALESCE(SUM(CASE WHEN duration_ms > 0 THEN duration_ms ELSE 0 END),0) AS dur,
              COALESCE(SUM(CASE WHEN duration_ms > 0 THEN input_tokens+output_tokens+reasoning_tokens+cache_read_input_tokens+cache_creation_input_tokens ELSE 0 END),0) AS dur_tokens
       FROM model_usage WHERE session_id = ? AND started_at >= ?`
    )
    .get(sid, taskStartTs) as unknown as { tokens: number; dur: number; dur_tokens: number }
  const taskTokens = Number(agg?.tokens ?? 0)
  const durMs = Number(agg?.dur ?? 0)
  const rateTokensPerSec = durMs > 0 ? Math.round(Number(agg?.dur_tokens ?? 0) / (durMs / 1000)) : 0

  // ---- 状态机 ----
  // 异常只对应「挂着未完成的东西超时」：请求未返回 / 工具卡死 / 明确报错。
  // 任务完成后人离开（无论多久没动静）都是空闲，不是异常。
  let status: LiveStatus
  let action: string
  let anomaly: string | undefined

  const secSince = (t: number): number => Math.max(0, Math.round((now - t) / 1000))
  const minSince = (t: number): number => Math.max(0, Math.round((now - t) / 60_000))

  if (mu?.status === 'error' && mu.completed_at != null && now - mu.completed_at < STALE_AFTER_MS) {
    status = 'error'
    anomaly = `模型请求失败：${mu.error ?? 'unknown'}`
    action = `异常：${anomaly}`
  } else if (
    lastTool?.error_type != null &&
    lastTool.completed_at != null &&
    now - lastTool.completed_at < STALE_AFTER_MS
  ) {
    status = 'error'
    anomaly = `工具 ${lastTool.tool_name} 失败：${lastTool.error_message ?? lastTool.error_type}`
    action = `异常：${anomaly}`
  } else if (runningTool?.started_at != null) {
    if (now - runningTool.started_at > STALE_AFTER_MS) {
      status = 'error'
      anomaly = `工具 ${runningTool.tool_name} 运行超过 ${minSince(runningTool.started_at)} 分钟未返回`
      action = `异常：${anomaly}`
    } else {
      status = 'tool'
      action = `调用 ${runningTool.tool_name ?? '工具'} · 已运行 ${secSince(runningTool.started_at)} 秒`
    }
  } else if (mu?.started_at != null && mu.completed_at == null) {
    if (now - mu.started_at > STALE_AFTER_MS) {
      status = 'error'
      anomaly = `请求超过 ${minSince(mu.started_at)} 分钟未响应（可能已挂起）`
      action = `异常：${anomaly}`
    } else if (mu.first_token_at == null) {
      status = 'waiting'
      action = `等待 ${model ?? '模型'} 响应...（已等待 ${secSince(mu.started_at)} 秒）`
    } else {
      status = 'thinking'
      action = `生成回复中...（${secSince(mu.started_at)} 秒）`
    }
  } else if (now - lastActivityTs <= IDLE_AFTER_MS && mu?.completed_at != null) {
    status = 'thinking'
    action = lastUser ? `处理请求：${lastUser.text}` : '生成回复中...'
  } else {
    status = 'idle'
    action = `空闲 · 最后活动 ${minSince(lastActivityTs)} 分钟前`
  }

  return {
    agent: 'zcode',
    sessionId: sid,
    projectName: projectName || 'ZCode',
    projectPath: session?.directory ?? undefined,
    model,
    status,
    action,
    taskStartTs,
    lastActivityTs,
    taskTokens,
    rateTokensPerSec,
    anomaly,
    logFilePath: join(homedir(), '.zcode', 'cli', 'db', 'db.sqlite'),
    polledAt: now
  }
}

/** 最近一条真实用户消息（排除系统合成消息），文本截 20 字 */
function zcodeLastUserMessage(db: DatabaseSync, sid: string): { ts: number; text: string } | null {
  try {
    const rows = db
      .prepare(
        `SELECT m.time_created AS ts, p.data AS pdata
         FROM message m LEFT JOIN part p ON p.message_id = m.id
         WHERE m.session_id = ? AND m.data LIKE '%"role":"user"%'
           AND m.data NOT LIKE '%todo_reminder%'
           AND m.data NOT LIKE '%"origin":"synthetic"%'
         ORDER BY m.time_created DESC LIMIT 3`
      )
      .all(sid) as unknown as { ts: number; pdata: string | null }[]
    for (const r of rows) {
      const text = extractPartText(r.pdata)
      if (text) return { ts: Number(r.ts), text }
    }
  } catch {
    /* 结构不符则无用户消息描述 */
  }
  return null
}

function extractPartText(pdata: string | null | undefined): string | null {
  if (!pdata) return null
  try {
    const j = JSON.parse(pdata) as Record<string, unknown>
    const t =
      (typeof j['text'] === 'string' && j['text']) ||
      (typeof j['content'] === 'string' && j['content']) ||
      null
    if (!t) return null
    const clean = t.replace(/\s+/g, ' ').trim()
    return clean.length > 20 ? `${clean.slice(0, 20)}...` : clean
  } catch {
    return null
  }
}

// ---------------- Codex：rollout 尾部解析 ----------------

function codexLive(now: number): LiveAgentCard[] {
  const sessionsRoot = join(homedir(), '.codex', 'sessions')
  const files = walkFiles(sessionsRoot, (n) => n.startsWith('rollout-') && n.endsWith('.jsonl'))
    .filter((f) => now - f.mtimeMs < ACTIVITY_WINDOW_MS)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, 6)

  const cards: LiveAgentCard[] = []
  for (const file of files) {
    const card = codexFileCard(file.path, file.size, file.mtimeMs, now)
    if (card) cards.push(card)
  }
  return cards
}

function codexFileCard(path: string, size: number, mtimeMs: number, now: number): LiveAgentCard | null {
  const { lines } = readLinesIncremental(path, Math.max(0, size - 64 * 1024))
  let sessionId = ''
  let cwd: string | undefined
  let lastTs = 0
  let model: string | undefined
  let lastTool: { name: string; ts: number } | null = null
  let lastUserText: { text: string; ts: number } | null = null
  let lastCompleteTs = 0
  let taskTokens = 0
  let error: string | null = null

  for (const line of lines) {
    const j = parseJsonLine<Record<string, unknown>>(line)
    if (!j) continue
    const ts = typeof j['timestamp'] === 'string' ? Date.parse(j['timestamp']) : 0
    if (ts > 0) lastTs = ts
    const type = String(j['type'] ?? '')
    const payload = (j['payload'] ?? {}) as Record<string, unknown>
    if (type === 'session_meta') {
      sessionId = String(payload['session_id'] ?? '')
      cwd = typeof payload['cwd'] === 'string' ? payload['cwd'] : cwd
    } else if (type === 'turn_context') {
      if (typeof payload['model'] === 'string') model = canonicalModelId(payload['model'])
      if (typeof payload['cwd'] === 'string') cwd = payload['cwd']
    } else if (type === 'response_item') {
      const ptype = String(payload['type'] ?? '')
      if (ptype === 'custom_tool_call' || ptype === 'function_call') {
        lastTool = { name: String(payload['name'] ?? '工具'), ts }
      } else if (ptype === 'message' && String(payload['role'] ?? '') === 'user') {
        const text = codexMessageText(payload['content'])
        if (text) lastUserText = { text, ts }
      }
    } else if (type === 'token_usage_record') {
      const usage = (payload['usage'] ?? {}) as Record<string, unknown>
      taskTokens =
        Number(usage['input_tokens'] ?? 0) +
        Number(usage['cached_input_tokens'] ?? 0) +
        Number(usage['output_tokens'] ?? 0)
      lastCompleteTs = ts
    } else if (type === 'event_msg') {
      const et = String(payload['type'] ?? '')
      if (et === 'task_complete') lastCompleteTs = ts
      if (et === 'error' || et === 'stream_error') {
        error = String(payload['message'] ?? et)
      }
    }
  }

  if (!lastTs) return null
  const lastActivityTs = Math.max(lastTs, mtimeMs - 1000)
  const projectName = lastSegment(cwd ?? '')

  const secSince = (t: number): number => Math.max(0, Math.round((now - t) / 1000))
  const minSince = (t: number): number => Math.max(0, Math.round((now - t) / 60_000))

  let status: LiveStatus
  let action: string
  let anomaly: string | undefined

  if (error && now - lastTs < STALE_AFTER_MS) {
    status = 'error'
    anomaly = `错误：${error.slice(0, 80)}`
    action = `异常：${error.slice(0, 40)}`
  } else if (lastTool && now - lastTool.ts < 20_000) {
    status = 'tool'
    action = `调用 ${lastTool.name} · ${secSince(lastTool.ts)} 秒前发起`
  } else if (lastCompleteTs && now - lastCompleteTs <= IDLE_AFTER_MS) {
    status = 'thinking'
    action = lastUserText ? `处理请求：${lastUserText.text}` : '生成回复中...'
  } else {
    status = 'idle'
    action = `空闲 · 最后活动 ${minSince(lastActivityTs)} 分钟前`
  }

  const taskStartTs = lastUserText?.ts ?? lastTs - 30 * 60_000
  return {
    agent: 'codex',
    sessionId: sessionId || (path.split('/').pop() ?? path),
    projectName: projectName || 'Codex',
    projectPath: cwd,
    model,
    status,
    action,
    taskStartTs,
    lastActivityTs,
    taskTokens,
    rateTokensPerSec: 0,
    anomaly,
    logFilePath: path,
    polledAt: now
  }
}

function codexMessageText(content: unknown): string | null {
  if (!Array.isArray(content)) return null
  for (const c of content) {
    const t = (c as Record<string, unknown>)['text']
    if (typeof t === 'string' && t.trim()) {
      const clean = t.replace(/\s+/g, ' ').trim()
      if (clean.startsWith('<') || clean.includes('environment_context')) continue // 系统注入内容跳过
      return clean.length > 20 ? `${clean.slice(0, 20)}...` : clean
    }
  }
  return null
}

// ---------------- 兜底：本库 events（claude/gemini/qwen） ----------------

function genericLive(store: Store, now: number): LiveAgentCard[] {
  const rows = store.recentSessionsForLive(ACTIVITY_WINDOW_MS, now)
  return rows
    .filter((r) => r.agent !== 'zcode') // zcode 有专路
    .map((r) => {
      const idle = now - r.lastTs > IDLE_AFTER_MS
      const secSince = Math.round((now - r.lastTs) / 1000)
      return {
        agent: r.agent,
        sessionId: r.sessionId,
        projectName: r.projectPath ? lastSegment(r.projectPath) : '未知项目',
        projectPath: r.projectPath,
        model: r.model,
        status: idle ? 'idle' : 'thinking',
        action: idle
          ? `空闲 · 最后活动 ${Math.max(1, Math.round(secSince / 60))} 分钟前`
          : '生成回复中...',
        taskStartTs: r.lastTs - 10 * 60_000,
        lastActivityTs: r.lastTs,
        taskTokens: r.tokens,
        rateTokensPerSec: 0,
        logFilePath: undefined,
        polledAt: now
      } satisfies LiveAgentCard
    })
}

function lastSegment(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/').filter(Boolean)
  return parts[parts.length - 1] ?? ''
}

/** 测试用：暴露内部推断函数 */
export const __internals = { zcodeSessionCard, codexFileCard }
