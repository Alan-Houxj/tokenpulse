/**
 * ZCode 适配器 —— 唯一的 SQLite 数据源。
 * 数据：~/.zcode/cli/db/db.sqlite 的 model_usage 表（每次模型请求一行，字段最全）。
 *
 * 读活动库（对方进程可能在写）：
 * - 只读模式打开（可读 WAL 中已提交内容）+ busy_timeout
 * - 打开失败（极端锁竞争/损坏）时复制 db+wal 到临时目录再读，绝不影响对方
 * - 位点语义是 rowid；检测到 MAX(rowid) < 位点说明库被重建 → 自动从头重扫
 */
import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { AgentId, DiscoveredFile, ReadResult, SourceAdapter, UsageEvent } from '../model/types'
import { normalizePathKey, statFile } from './util'

interface ModelUsageRow {
  rowid: number
  session_id: string | null
  logical_request_id: string | null
  attempt_index: number | null
  model_id: string | null
  started_at: number | null
  duration_ms: number | null
  input_tokens: number | null
  output_tokens: number | null
  reasoning_tokens: number | null
  cache_creation_input_tokens: number | null
  cache_read_input_tokens: number | null
}

function openReadonly(path: string): DatabaseSync {
  // node:sqlite 的 readOnly = SQLITE_OPEN_READONLY，可共享读 WAL
  return new DatabaseSync(path, { readOnly: true })
}

export class ZCodeAdapter implements SourceAdapter {
  readonly id: AgentId = 'zcode'
  readonly displayName = 'ZCode'
  private readonly dbPath: string
  /** 复制兜底用的临时目录（懒创建） */
  private tmpCopyDir: string | undefined

  constructor(opts: { dbPath?: string } = {}) {
    this.dbPath = opts.dbPath ?? join(homedir(), '.zcode', 'cli', 'db', 'db.sqlite')
  }

  defaultRoots(): string[] {
    return [join(homedir(), '.zcode', 'cli', 'db')]
  }

  discover(): DiscoveredFile[] {
    const st = statFile(this.dbPath)
    return st ? [{ path: normalizePathKey(this.dbPath), size: st.size, mtimeMs: st.mtimeMs }] : []
  }

  private openDb(): DatabaseSync {
    try {
      const db = openReadonly(this.dbPath)
      db.exec('PRAGMA busy_timeout = 3000')
      // 试探性查询验证可读（顺便触发 WAL 读取路径，锁问题在这里暴露）
      db.prepare('SELECT rowid FROM model_usage LIMIT 1').get()
      return db
    } catch {
      // 兜底：复制 db(+wal) 后读副本。15MB 级别，只在 mtime 变化后的首次读取发生
      return this.openCopied()
    }
  }

  private openCopied(): DatabaseSync {
    this.tmpCopyDir ??= join(tmpdir(), 'agentmeter-zcode-copy')
    mkdirSync(this.tmpCopyDir, { recursive: true })
    const base = join(this.tmpCopyDir, 'db.sqlite')
    copyFileSync(this.dbPath, base)
    for (const ext of ['-wal', '-shm']) {
      const src = this.dbPath + ext
      if (existsSync(src)) {
        try {
          copyFileSync(src, base + ext)
        } catch {
          /* 复制 wal 失败就只读主文件 */
        }
      }
    }
    const db = new DatabaseSync(base, { readOnly: true })
    db.exec('PRAGMA busy_timeout = 3000')
    return db
  }

  async readIncremental(file: DiscoveredFile, fromOffset: number): Promise<ReadResult> {
    let db: DatabaseSync
    try {
      db = this.openDb()
    } catch {
      return { events: [], endOffset: fromOffset }
    }

    try {
      const hasTable = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='model_usage'")
        .get()
      if (!hasTable) return { events: [], endOffset: file.size }

      const max = db.prepare('SELECT COALESCE(MAX(rowid), 0) AS m FROM model_usage').get()
      const maxRowid = Number(max?.['m'] ?? 0)
      // 库被重建（rowid 回退）→ 从头重扫
      let start = fromOffset
      if (maxRowid < fromOffset) start = 0

      const rows = db
        .prepare(
          `SELECT rowid, session_id, logical_request_id, attempt_index, model_id, started_at,
                  duration_ms, input_tokens, output_tokens, reasoning_tokens,
                  cache_creation_input_tokens, cache_read_input_tokens
           FROM model_usage WHERE rowid > ? ORDER BY rowid`
        )
        .all(start) as unknown as ModelUsageRow[]

      if (rows.length === 0) return { events: [], endOffset: Math.max(start, maxRowid) }

      // 项目路径：session 表的 directory（主键列是 id；只为本次新增的 session 查一次）
      const sessionIds = [...new Set(rows.map((r) => r.session_id).filter((s): s is string => !!s))]
      const dirBySession = new Map<string, string>()
      if (sessionIds.length > 0) {
        try {
          const placeholders = sessionIds.map(() => '?').join(',')
          const sRows = db
            .prepare(`SELECT id, directory FROM session WHERE id IN (${placeholders})`)
            .all(...sessionIds) as unknown as { id: string; directory: string | null }[]
          for (const s of sRows) {
            if (s.directory) dirBySession.set(s.id, s.directory)
          }
        } catch {
          /* session 表缺失则没有项目路径 */
        }
      }

      const events: UsageEvent[] = []
      for (const r of rows) {
        const sessionId = r.session_id ?? 'unknown-session'
        // 内容寻址幂等键：库重建/重装后 rowid 会复用，纯 rowid 键会漏记
        const reqKey = r.logical_request_id ?? `rowid-${r.rowid}`
        const attempt = r.attempt_index ?? 0
        // ZCode 口径已实测验证：input_tokens 包含 cache_read（in+out=totalTokens），
        // 归一化时拆开，避免缓存双计（与 Codex/Gemini 一致）
        const rawInput = Number(r.input_tokens ?? 0)
        const cacheRead = Math.max(0, Number(r.cache_read_input_tokens ?? 0))
        events.push({
          id: `zcode:${sessionId}:${reqKey}:${attempt}:${r.started_at ?? 0}`,
          ts: Number(r.started_at ?? 0),
          agent: 'zcode',
          sessionId,
          model: r.model_id ?? 'unknown',
          tokens: {
            input: Math.max(0, rawInput - cacheRead),
            output: Math.max(0, r.output_tokens ?? 0),
            reasoning: Math.max(0, r.reasoning_tokens ?? 0),
            cacheRead,
            cacheWrite: Math.max(0, r.cache_creation_input_tokens ?? 0)
          },
          costUSD: undefined,
          costEstUSD: 0,
          durationMs: r.duration_ms ?? undefined,
          projectPath: dirBySession.get(sessionId)
        })
      }
      return { events, endOffset: rows[rows.length - 1]!.rowid }
    } finally {
      db.close()
    }
  }
}
