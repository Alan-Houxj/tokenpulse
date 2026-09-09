/**
 * 协同房间持久化：独立 collab.db（与监控库分离，卸载/迁移语义互不影响）。
 * node:sqlite，零原生依赖，与主库同栈。
 */
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { CollabMessage, CollabRoom, Participant } from './types'

export class CollabStore {
  private constructor(readonly db: DatabaseSync) {}

  static open(dbPath: string): CollabStore {
    mkdirSync(dirname(dbPath), { recursive: true })
    const db = new DatabaseSync(dbPath)
    db.exec(`
      CREATE TABLE IF NOT EXISTS rooms (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        workspace TEXT NOT NULL,
        participants_json TEXT NOT NULL,
        context_messages INTEGER NOT NULL DEFAULT 20,
        timeout_ms INTEGER NOT NULL DEFAULT 600000,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL,
        ts INTEGER NOT NULL,
        author TEXT NOT NULL,
        text TEXT NOT NULL DEFAULT '',
        status TEXT,
        duration_ms INTEGER,
        tokens INTEGER,
        cost_est_usd REAL,
        error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_messages_room ON messages(room_id, ts);
    `)
    return new CollabStore(db)
  }

  createRoom(room: CollabRoom): void {
    this.db
      .prepare(
        `INSERT INTO rooms (id, name, workspace, participants_json, context_messages, timeout_ms, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        room.id,
        room.name,
        room.workspace,
        JSON.stringify(room.participants),
        room.contextMessages,
        room.timeoutMs,
        room.createdAt
      )
  }

  updateRoom(room: CollabRoom): void {
    this.db
      .prepare(
        `UPDATE rooms SET name = ?, workspace = ?, participants_json = ?, context_messages = ?, timeout_ms = ? WHERE id = ?`
      )
      .run(
        room.name,
        room.workspace,
        JSON.stringify(room.participants),
        room.contextMessages,
        room.timeoutMs,
        room.id
      )
  }

  deleteRoom(roomId: string): void {
    this.db.prepare(`DELETE FROM rooms WHERE id = ?`).run(roomId)
    this.db.prepare(`DELETE FROM messages WHERE room_id = ?`).run(roomId)
  }

  listRooms(): CollabRoom[] {
    const rows = this.db
      .prepare(`SELECT * FROM rooms ORDER BY created_at DESC`)
      .all() as Record<string, unknown>[]
    return rows.map(rowToRoom)
  }

  getRoom(roomId: string): CollabRoom | null {
    const r = this.db.prepare(`SELECT * FROM rooms WHERE id = ?`).get(roomId) as
      | Record<string, unknown>
      | undefined
    return r ? rowToRoom(r) : null
  }

  insertMessage(m: CollabMessage): void {
    this.db
      .prepare(
        `INSERT INTO messages (id, room_id, ts, author, text, status, duration_ms, tokens, cost_est_usd, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        m.id,
        m.roomId,
        m.ts,
        m.author,
        m.text,
        m.status ?? null,
        m.durationMs ?? null,
        m.tokens ?? null,
        m.costEstUSD ?? null,
        m.error ?? null
      )
  }

  updateMessage(id: string, patch: Partial<Omit<CollabMessage, 'id' | 'roomId'>>): void {
    const m = this.getMessage(id)
    if (!m) return
    this.db
      .prepare(
        `UPDATE messages SET text = ?, status = ?, duration_ms = ?, tokens = ?, cost_est_usd = ?, error = ? WHERE id = ?`
      )
      .run(
        patch.text ?? m.text,
        patch.status ?? m.status ?? null,
        patch.durationMs ?? m.durationMs ?? null,
        patch.tokens ?? m.tokens ?? null,
        patch.costEstUSD ?? m.costEstUSD ?? null,
        patch.error ?? m.error ?? null,
        id
      )
  }

  getMessage(id: string): CollabMessage | null {
    const r = this.db.prepare(`SELECT * FROM messages WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined
    if (!r) return null
    return {
      id: String(r['id']),
      roomId: String(r['room_id']),
      ts: Number(r['ts']),
      author: String(r['author']),
      text: String(r['text'] ?? ''),
      status: (r['status'] as CollabMessage['status']) ?? undefined,
      durationMs: r['duration_ms'] != null ? Number(r['duration_ms']) : undefined,
      tokens: r['tokens'] != null ? Number(r['tokens']) : undefined,
      costEstUSD: r['cost_est_usd'] != null ? Number(r['cost_est_usd']) : undefined,
      error: r['error'] != null ? String(r['error']) : undefined
    }
  }

  getMessages(roomId: string): CollabMessage[] {
    const rows = this.db
      .prepare(`SELECT * FROM messages WHERE room_id = ? ORDER BY ts, rowid`)
      .all(roomId) as Record<string, unknown>[]
    return rows.map((r) => ({
      id: String(r['id']),
      roomId: String(r['room_id']),
      ts: Number(r['ts']),
      author: String(r['author']),
      text: String(r['text'] ?? ''),
      status: (r['status'] as CollabMessage['status']) ?? undefined,
      durationMs: r['duration_ms'] != null ? Number(r['duration_ms']) : undefined,
      tokens: r['tokens'] != null ? Number(r['tokens']) : undefined,
      costEstUSD: r['cost_est_usd'] != null ? Number(r['cost_est_usd']) : undefined,
      error: r['error'] != null ? String(r['error']) : undefined
    }))
  }

  roomHasRunning(roomId: string): boolean {
    const r = this.db
      .prepare(`SELECT COUNT(*) n FROM messages WHERE room_id = ? AND status = 'running'`)
      .get(roomId) as { n: number }
    return r.n > 0
  }

  close(): void {
    this.db.close()
  }
}

function rowToRoom(r: Record<string, unknown>): CollabRoom {
  return {
    id: String(r['id']),
    name: String(r['name']),
    workspace: String(r['workspace']),
    participants: JSON.parse(String(r['participants_json'])) as Participant[],
    contextMessages: Number(r['context_messages']),
    timeoutMs: Number(r['timeout_ms']),
    createdAt: Number(r['created_at'])
  }
}

/** collab.db 默认路径（userData 下） */
export function defaultCollabDbPath(userDataDir: string): string {
  return join(userDataDir, 'collab.db')
}
