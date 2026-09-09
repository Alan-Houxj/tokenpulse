/**
 * 协同引擎：@ 提及解析 → 串行执行 → 消息落库 + 成本回查。
 * 主持人模式（v1）：只有用户消息里的 @ 会触发执行；Agent 输出中的 @ 仅作文本展示，
 * 杜绝 Agent 互 @ 无限乒乓烧钱。
 */
import { randomUUID } from 'node:crypto'
import { runAgent, trimBanner, type RunHandle } from './drivers'
import type { CollabMessage, CollabRoom, Participant } from './types'
import type { CollabStore } from './store'

export type RunFn = typeof runAgent

export interface EngineDeps {
  store: CollabStore
  /** 依赖注入便于测试；生产用 drivers.runAgent */
  run?: RunFn
  /** 成本回查：某监控源在时间窗内的 token/成本（custom 返回 null） */
  usage?: (agentKind: string, from: number, to: number) => { tokens: number; costEstUSD: number } | null
  /** 消息/状态变化回调（推 UI 刷新） */
  onChange: (roomId: string) => void
  now?: () => number
}

/** 从文本解析被 @ 的参与者（按出现顺序去重；名字大小写不敏感，支持带空格的名字） */
export function parseMentions(text: string, participants: Participant[]): Participant[] {
  const lower = text.toLowerCase()
  const found: Participant[] = []
  const sorted = [...participants].sort((a, b) => b.name.length - a.name.length) // 长名优先
  for (let i = lower.indexOf('@'); i !== -1; i = lower.indexOf('@', i + 1)) {
    let hit: Participant | undefined
    for (const p of sorted) {
      if (lower.startsWith(`@${p.name.toLowerCase()}`, i)) {
        hit = p
        break
      }
    }
    if (!hit) {
      // 兜底：@id（id 无空格）
      const rest = lower.slice(i + 1)
      const m = /^([\w.-]+)/.exec(rest)
      if (m) hit = participants.find((p) => p.id.toLowerCase() === m[1])
    }
    if (hit && !found.includes(hit)) found.push(hit)
  }
  return found
}

/** 构建给被 @ Agent 的输入：协作说明 + 最近上下文转录（不含本条）+ 本条消息 */
export function buildPrompt(room: CollabRoom, history: CollabMessage[], userMsg: CollabMessage, target: Participant): string {
  const ctx = history
    .filter((m) => m.id !== userMsg.id)
    .slice(-room.contextMessages)
  const lines: string[] = []
  lines.push(`你是「${target.name}」，在一个多人协作房间里被 @。下面是房间最近的对话记录；请针对最后一条用户消息中 @ 你的部分给出你的最终答复（中文）。你的回复会被房间里的其他成员看到。`)
  lines.push('')
  lines.push('=== 房间对话记录 ===')
  for (const m of ctx) {
    const who = m.author === 'user' ? '用户' : room.participants.find((p) => p.id === m.author)?.name ?? m.author
    const time = new Date(m.ts).toLocaleTimeString()
    const body = m.text.length > 4000 ? `${m.text.slice(0, 4000)}\n…（超长已截断）` : m.text
    lines.push(`[${who} ${time}]\n${body}\n`)
  }
  lines.push('=== 最新用户消息 ===')
  lines.push(userMsg.text)
  return lines.join('\n')
}

export class CollabEngine {
  private readonly run: RunFn
  private readonly now: () => number
  private active = new Map<string, RunHandle>() // messageId -> handle

  constructor(private readonly deps: EngineDeps) {
    this.run = deps.run ?? runAgent
    this.now = deps.now ?? Date.now
  }

  get store(): CollabStore {
    return this.deps.store
  }

  /** 用户发言：落库；串行执行所有被 @ 的参与者 */
  postUserMessage(roomId: string, text: string): { ok: boolean; error?: string } {
    const room = this.deps.store.getRoom(roomId)
    if (!room) return { ok: false, error: '房间不存在' }
    const mentions = parseMentions(text, room.participants)
    const history = this.deps.store.getMessages(roomId)
    const msg: CollabMessage = {
      id: randomUUID(),
      roomId,
      ts: this.now(),
      author: 'user',
      text
    }
    this.deps.store.insertMessage(msg)
    this.deps.onChange(roomId)
    if (mentions.length === 0) return { ok: true }
    void this.runMentions(room, [...history, msg], mentions)
    return { ok: true }
  }

  private async runMentions(room: CollabRoom, history: CollabMessage[], mentions: Participant[]): Promise<void> {
    for (const p of mentions) {
      const startedAt = this.now()
      const replyId = randomUUID()
      this.deps.store.insertMessage({
        id: replyId,
        roomId: room.id,
        ts: this.now(),
        author: p.id,
        text: '',
        status: 'running'
      })
      this.deps.onChange(room.id)
      try {
        const handle = this.run(p, buildPrompt(room, history, history[history.length - 1]!, p), {
          cwd: room.workspace,
          timeoutMs: room.timeoutMs
        })
        this.active.set(replyId, handle)
        const r = await handle.promise
        this.active.delete(replyId)
        const durationMs = this.now() - startedAt
        if (r.timedOut) {
          this.deps.store.updateMessage(replyId, {
            status: 'timeout',
            durationMs,
            error: `运行超过 ${Math.round(room.timeoutMs / 1000)}s 已终止`,
            text: trimBanner(r.stdout).slice(0, 2000)
          })
        } else if (r.code !== 0) {
          this.deps.store.updateMessage(replyId, {
            status: 'error',
            durationMs,
            error: `退出码 ${r.code}${r.stderr ? `：${r.stderr.slice(-400)}` : ''}`,
            text: trimBanner(r.stdout).slice(0, 2000)
          })
        } else {
          const usage =
            p.agentKind !== 'custom' && this.deps.usage
              ? this.deps.usage(p.agentKind, startedAt, this.now())
              : null
          this.deps.store.updateMessage(replyId, {
            status: 'done',
            durationMs,
            text: trimBanner(r.stdout).trim(),
            tokens: usage?.tokens,
            costEstUSD: usage?.costEstUSD
          })
        }
      } catch (e) {
        this.active.delete(replyId)
        this.deps.store.updateMessage(replyId, {
          status: 'error',
          durationMs: this.now() - startedAt,
          error: String(e)
        })
      }
      this.deps.onChange(room.id)
    }
  }

  /** 手动终止某条运行中的消息 */
  kill(replyId: string): void {
    this.active.get(replyId)?.kill()
  }
}
