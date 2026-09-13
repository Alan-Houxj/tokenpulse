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
        prompt_est INTEGER,
        error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_messages_room ON messages(room_id, ts);
      CREATE TABLE IF NOT EXISTS room_sessions (
        room_id TEXT NOT NULL,
        participant_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (room_id, participant_id)
      );
    `)
    // 旧库升级：messages 缺 prompt_est 列则补
    try {
      db.exec(`ALTER TABLE messages ADD COLUMN prompt_est INTEGER`)
    } catch {
      /* 已存在 */
    }
    return new CollabStore(db)
  }

  // ---------- 房间 ----------
  createRoom(room: CollabRoom): void {
    this.db
      .prepare(
        `INSERT INTO rooms (id, name, workspace, participants_json, timeout_ms, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(room.id, room.name, room.workspace, JSON.stringify(room.participants), room.timeoutMs, room.createdAt)
  }

  updateRoom(room: CollabRoom): void {
    this.db
      .prepare(`UPDATE rooms SET name = ?, workspace = ?, participants_json = ?, timeout_ms = ? WHERE id = ?`)
      .run(room.name, room.workspace, JSON.stringify(room.participants), room.timeoutMs, room.id)
  }

  deleteRoom(roomId: string): void {
    this.db.prepare(`DELETE FROM rooms WHERE id = ?`).run(roomId)
    this.db.prepare(`DELETE FROM messages WHERE room_id = ?`).run(roomId)
    this.db.prepare(`DELETE FROM room_sessions WHERE room_id = ?`).run(roomId)
  }

  listRooms(): CollabRoom[] {
    const rows = this.db.prepare(`SELECT * FROM rooms ORDER BY created_at DESC`).all() as Record<string, unknown>[]
    return rows.map(rowToRoom)
  }

  getRoom(roomId: string): CollabRoom | null {
    const r = this.db.prepare(`SELECT * FROM rooms WHERE id = ?`).get(roomId) as Record<string, unknown> | undefined
    return r ? rowToRoom(r) : null
  }

  // ---------- 消息 ----------
  insertMessage(m: CollabMessage): void {
    this.db
      .prepare(
        `INSERT INTO messages (id, room_id, ts, author, text, status, duration_ms, tokens, cost_est_usd, prompt_est, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
        m.promptEst ?? null,
        m.error ?? null
      )
  }

  updateMessage(id: string, patch: Partial<Omit<CollabMessage, 'id' | 'roomId'>>): void {
    const m = this.getMessage(id)
    if (!m) return
    this.db
      .prepare(
        `UPDATE messages SET text = ?, status = ?, duration_ms = ?, tokens = ?, cost_est_usd = ?, prompt_est = ?, error = ? WHERE id = ?`
      )
      .run(
        patch.text ?? m.text,
        patch.status ?? m.status ?? null,
        patch.durationMs ?? m.durationMs ?? null,
        patch.tokens ?? m.tokens ?? null,
        patch.costEstUSD ?? m.costEstUSD ?? null,
        patch.promptEst ?? m.promptEst ?? null,
        patch.error ?? m.error ?? null,
        id
      )
  }

  getMessage(id: string): CollabMessage | null {
    const r = this.db.prepare(`SELECT * FROM messages WHERE id = ?`).get(id) as Record<string, unknown> | undefined
    return r ? rowToMessage(r) : null
  }

  getMessages(roomId: string): CollabMessage[] {
    const rows = this.db
      .prepare(`SELECT * FROM messages WHERE room_id = ? ORDER BY ts, rowid`)
      .all(roomId) as Record<string, unknown>[]
    return rows.map(rowToMessage)
  }

  roomHasRunning(roomId: string): boolean {
    const r = this.db
      .prepare(`SELECT COUNT(*) n FROM messages WHERE room_id = ? AND status = 'running'`)
      .get(roomId) as { n: number }
    return r.n > 0
  }

  // ---------- 原生 session 映射（房间 × 参与者 → Agent 自己的 session id） ----------
  getSession(roomId: string, participantId: string): string | undefined {
    const r = this.db
      .prepare(`SELECT session_id FROM room_sessions WHERE room_id = ? AND participant_id = ?`)
      .get(roomId, participantId) as { session_id: string } | undefined
    return r?.session_id
  }

  setSession(roomId: string, participantId: string, sessionId: string): void {
    this.db
      .prepare(
        `INSERT INTO room_sessions (room_id, participant_id, session_id, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (room_id, participant_id) DO UPDATE SET session_id = excluded.session_id, updated_at = excluded.updated_at`
      )
      .run(roomId, participantId, sessionId, Date.now())
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
    timeoutMs: Number(r['timeout_ms']),
    createdAt: Number(r['created_at'])
  }
}

function rowToMessage(r: Record<string, unknown>): CollabMessage {
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
    promptEst: r['prompt_est'] != null ? Number(r['prompt_est']) : undefined,
    error: r['error'] != null ? String(r['error']) : undefined
  }
}

/** collab.db 默认路径（userData 下） */
export function defaultCollabDbPath(userDataDir: string): string {
  return join(userDataDir, 'collab.db')
}
