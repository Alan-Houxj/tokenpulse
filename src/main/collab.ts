/**
 * 协同模块主进程接线：collab.db + 引擎 + IPC + 事件广播。
 * 参与者 = 受支持 ∩ 就绪的 Agent（与数据源探测一致；ZCode 需 CLI + 模型配置就绪）。
 */
import { ipcMain, app } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { CollabStore, defaultCollabDbPath } from '@core/collab/store'
import { CollabEngine } from '@core/collab/engine'
import { zcodeHeadlessReady } from '@core/collab/drivers'
import { AGENT_COLORS, AGENT_NAMES, type CollabAgentInfo, type CollabRoom, type Participant } from '@core/collab/types'
import type { AgentId } from '@core/model/types'
import type { Store } from '@core/store/sqlite'
import { broadcast } from './events'

/** 探测可参与协同的 Agent（数据源探测结果 + headless 就绪检查） */
export function detectCollabAgents(probes: { agent: AgentId; status: string }[]): CollabAgentInfo[] {
  const probeOk = new Set(probes.filter((p) => p.status === 'ok').map((p) => p.agent))
  const zcode = zcodeHeadlessReady(homedir())
  return (Object.keys(AGENT_NAMES) as AgentId[]).map((kind) => {
    if (!probeOk.has(kind)) {
      return { agentKind: kind, name: AGENT_NAMES[kind], color: AGENT_COLORS[kind], ready: false, reason: '本机未检测到该 Agent' }
    }
    if (kind === 'zcode' && !zcode.ready) {
      return { agentKind: kind, name: AGENT_NAMES[kind], color: AGENT_COLORS[kind], ready: false, reason: zcode.reason }
    }
    return { agentKind: kind, name: AGENT_NAMES[kind], color: AGENT_COLORS[kind], ready: true }
  })
}

export function setupCollab(
  monitorStore: Store,
  probeAll: () => Promise<{ agent: AgentId; status: string }[]>
): CollabEngine {
  const store = CollabStore.open(defaultCollabDbPath(app.getPath('userData')))
  const zcode = zcodeHeadlessReady(homedir())
  const engine = new CollabEngine({
    store,
    usage: (kind, from, to) => monitorStore.agentWindowUsage(kind, from, to),
    onChange: (roomId) => broadcast('collab:event', { roomId }),
    zcodeCli: zcode.cliPath
  })

  ipcMain.handle('collab:agents', async () => detectCollabAgents(await probeAll()))

  ipcMain.handle('collab:rooms', () => store.listRooms())
  ipcMain.handle('collab:messages', (_e, roomId: unknown) => store.getMessages(String(roomId ?? '')))

  ipcMain.handle('collab:room:save', (_e, p: Partial<CollabRoom>) => {
    const name = String(p.name ?? '').trim()
    const workspace = String(p.workspace ?? '').trim()
    if (!name) return { ok: false, error: '房间名不能为空' }
    if (!existsSync(workspace)) return { ok: false, error: `工作目录不存在：${workspace}` }
    const participants = (p.participants ?? []).filter((x) => x.agentKind && x.name.trim())
    if (participants.length === 0) return { ok: false, error: '至少需要一名参与者' }
    const room: CollabRoom = {
      id: p.id ?? randomUUID(),
      name,
      workspace,
      participants: participants.map<Participant>((x) => ({
        id: x.id ?? randomUUID(),
        agentKind: x.agentKind,
        name: x.name.trim(),
        color: x.color ?? AGENT_COLORS[x.agentKind],
        model: x.model?.trim() || undefined,
        reasoning: x.reasoning ?? 'default'
      })),
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
