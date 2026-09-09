/**
 * 协同模块主进程接线：collab.db + 引擎 + IPC + 事件广播。
 * 消息/状态变化通过 'collab:event' 推给渲染端（带 roomId，渲染端自行拉取）。
 */
import { ipcMain, app } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { CollabStore, defaultCollabDbPath } from '@core/collab/store'
import { CollabEngine } from '@core/collab/engine'
import { PARTICIPANT_PRESETS, type CollabRoom, type Participant } from '@core/collab/types'
import type { Store } from '@core/store/sqlite'
import { broadcast } from './events'

export function setupCollab(monitorStore: Store): CollabEngine {
  const store = CollabStore.open(defaultCollabDbPath(app.getPath('userData')))
  const engine = new CollabEngine({
    store,
    usage: (kind, from, to) =>
      kind === 'custom' ? null : monitorStore.agentWindowUsage(kind, from, to),
    onChange: (roomId) => broadcast('collab:event', { roomId })
  })

  ipcMain.handle('collab:presets', () => PARTICIPANT_PRESETS)

  ipcMain.handle('collab:rooms', () => store.listRooms())
  ipcMain.handle('collab:messages', (_e, roomId: unknown) => store.getMessages(String(roomId ?? '')))

  ipcMain.handle('collab:room:save', (_e, p: Partial<CollabRoom>) => {
    const name = String(p.name ?? '').trim()
    const workspace = String(p.workspace ?? '').trim()
    if (!name) return { ok: false, error: '房间名不能为空' }
    if (!existsSync(workspace)) return { ok: false, error: `工作目录不存在：${workspace}` }
    const participants = (p.participants ?? []).filter((x) => x.name.trim() && x.command.trim())
    if (participants.length === 0) return { ok: false, error: '至少需要一名参与者' }
    const room: CollabRoom = {
      id: p.id ?? randomUUID(),
      name,
      workspace,
      participants: participants.map<Participant>((x, i) => ({
        id: x.id ?? randomUUID(),
        name: x.name.trim(),
        agentKind: x.agentKind ?? 'custom',
        color: x.color ?? PARTICIPANT_PRESETS.find((s) => s.name === x.name)?.color ?? ['#60a5fa', '#34d399', '#a78bfa', '#fbbf24', '#22d3ee', '#f472b6'][i % 6]!,
        command: x.command.trim()
      })),
      contextMessages: Math.max(2, Math.min(100, Number(p.contextMessages) || 20)),
      timeoutMs: Math.max(60_000, Number(p.timeoutMs) || 600_000),
      createdAt: p.createdAt ?? Date.now()
    }
    if (p.id && store.getRoom(p.id)) store.updateRoom(room)
    else store.createRoom(room)
    return { ok: true, room }
  })

  ipcMain.handle('collab:room:delete', (_e, roomId: unknown) => {
    store.deleteRoom(String(roomId ?? ''))
    return true
  })

  ipcMain.handle('collab:send', (_e, p: { roomId?: string; text?: string }) => {
    const text = String(p.text ?? '').trim()
    if (!text) return { ok: false, error: '消息不能为空' }
    if (store.roomHasRunning(String(p.roomId ?? ''))) return { ok: false, error: '有 Agent 正在工作中，请等待完成' }
    return engine.postUserMessage(String(p.roomId ?? ''), text)
  })

  return engine
}
