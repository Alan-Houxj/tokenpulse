/**
 * SQLite 驱动薄封装。
 * 首选 Node 24 内置的 node:sqlite（零原生依赖、vitest/Electron 通吃）；
 * 运行时探测失败时抛出可识别错误，由上层决定是否换 better-sqlite3。
 */
import { DatabaseSync } from 'node:sqlite'

export interface StmtResult {
  changes: number
  lastInsertRowid: number
}

export type SqlParam = null | number | string | Uint8Array

export interface DbStatement {
  run(...params: SqlParam[]): StmtResult
  get(...params: SqlParam[]): Record<string, unknown> | undefined
  all(...params: SqlParam[]): Record<string, unknown>[]
}

export interface DbDriver {
  exec(sql: string): void
  prepare(sql: string): DbStatement
  close(): void
  transaction<T>(fn: () => T): T
}

export class NodeSqliteDriver implements DbDriver {
  private readonly db: DatabaseSync
  private inTransaction = false

  constructor(path: string, options: { readOnly?: boolean } = {}) {
    // node:sqlite 的 readOnly 选项对应 SQLite OPEN_READONLY（可读 WAL，配合 busy 超时读活动库）
    this.db = new DatabaseSync(path, { readOnly: options.readOnly })
    if (!options.readOnly) {
      this.db.exec('PRAGMA journal_mode = WAL')
      this.db.exec('PRAGMA synchronous = NORMAL')
    }
    // 读他人写入的活动库时给足重试窗口，避免偶发 SQLITE_BUSY
    this.db.exec('PRAGMA busy_timeout = 3000')
  }

  exec(sql: string): void {
    this.db.exec(sql)
  }

  prepare(sql: string): DbStatement {
    const stmt = this.db.prepare(sql)
    return {
      run: (...params: SqlParam[]): StmtResult => {
        const r = stmt.run(...params)
        return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) }
      },
      get: (...params: SqlParam[]) => stmt.get(...params) as Record<string, unknown> | undefined,
      all: (...params: SqlParam[]) => stmt.all(...params) as Record<string, unknown>[]
    }
  }

  transaction<T>(fn: () => T): T {
    if (this.inTransaction) return fn() // 不嵌套，内层直接执行
    this.inTransaction = true
    this.db.exec('BEGIN')
    try {
      const result = fn()
      this.db.exec('COMMIT')
      return result
    } catch (e) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        /* 连接异常时 ROLLBACK 可能已失败，保留原始错误 */
      }
      throw e
    } finally {
      this.inTransaction = false
    }
  }

  close(): void {
    this.db.close()
  }
}

/** 打开我们自己的库（读写，WAL） */
export function openOwnDb(path: string): DbDriver {
  return new NodeSqliteDriver(path)
}
