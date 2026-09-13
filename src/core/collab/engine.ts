/**
 * 协同引擎：@ 提及解析 → 串行执行 → 消息落库 + 成本回查。
 * - 主持人模式：只有用户消息里的 @ 触发执行（Agent 输出中的 @ 仅文本），防乒乓烧钱
 * - 全量注入：每次递给 Agent 房间从始至今的完整记录（三段式包装），不做任何截断
 * - 持久 session：捕获各 Agent 原生 session id 存库，后续 @ 走 resume 接续其记忆
 */
import { randomUUID } from 'node:crypto'
import { estimatePromptTokens, runAgent, trimBanner, type RunHandle } from './drivers'
import type { CollabMessage, CollabRoom, Participant } from './types'
import type { CollabStore } from './store'

export type RunFn = typeof runAgent

export interface EngineDeps {
  store: CollabStore
  /** 依赖注入便于测试；生产用 drivers.runAgent */
  run?: RunFn
  /** 成本回查：某监控源在时间窗内的 token/成本 */
  usage?: (agentKind: string, from: number, to: number) => { tokens: number; costEstUSD: number } | null
  /** 消息/状态变化回调（推 UI 刷新） */
  onChange: (roomId: string) => void
  now?: () => number
  /** ZCode CLI 路径（main 探测后传入） */
  zcodeCli?: string | null
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
      const rest = lower.slice(i + 1)
      const m = /^([\w.-]+)/.exec(rest)
      if (m) hit = participants.find((p) => p.id.toLowerCase() === m[1])
    }
    if (hit && !found.includes(hit)) found.push(hit)
  }
  return found
}

/**
 * 构建给被 @ Agent 的输入（全量注入，三段式包装）：
 * 头部说明（你是谁/哪间房）→ 房间全部历史（不含本条，时间序）→ 本次 @ 的消息 → 回复要求
 */
export function buildPrompt(room: CollabRoom, history: CollabMessage[], userMsg: CollabMessage, target: Participant): string {
  const lines: string[] = []
  lines.push(
    `你是「${target.name}」，在 TokenPulse 协作房间「${room.name}」中被 @。`,
    '以下是房间从建立到现在的全部对话，请针对最后 @ 你的消息给出最终答复。',
    '',
    '=== 房间历史 ==='
  )
  for (const m of history) {
    if (m.id === userMsg.id) continue
    const who = m.author === 'user' ? '用户' : room.participants.find((p) => p.id === m.author)?.name ?? m.author
    const time = new Date(m.ts).toLocaleTimeString()
    lines.push(`[${who} ${time}]`, m.text, '')
  }
  lines.push('=== @ 你的最新消息 ===', userMsg.text, '', '=== 回复要求 ===', '你的答复会原样展示给房间所有人；不需要复述历史，直接给出结论和产出。')
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
        const prompt = buildPrompt(room, history, history[history.length - 1]!, p)
        const promptEst = estimatePromptTokens(prompt)
        const sessionId = this.deps.store.getSession(room.id, p.id)
        const handle = this.run(p, prompt, {
          cwd: room.workspace,
          timeoutMs: room.timeoutMs,
          sessionId,
          zcodeCli: this.deps.zcodeCli
        })
        this.active.set(replyId, handle)
        const r = await handle.promise
        this.active.delete(replyId)
        const durationMs = this.now() - startedAt
        // 捕获到原生 session id 则存档（首次运行后建立持久会话）
        const sid = r.sessionId ?? sessionId
        if (sid && sid !== sessionId) this.deps.store.setSession(room.id, p.id, sid)
        const meta = { durationMs, promptEst }
        if (r.timedOut) {
          this.deps.store.updateMessage(replyId, {
            ...meta,
            status: 'timeout',
            error: `运行超过 ${Math.round(room.timeoutMs / 1000)}s 已终止`,
            text: trimBanner(r.stdout).slice(0, 2000)
          })
        } else if (r.code !== 0) {
          this.deps.store.updateMessage(replyId, {
            ...meta,
            status: 'error',
            error: `退出码 ${r.code}${r.stderr ? `：${r.stderr.slice(-400)}` : ''}`,
            text: trimBanner(r.stdout).slice(0, 2000)
          })
        } else {
          const usage = this.deps.usage ? this.deps.usage(p.agentKind, startedAt, this.now()) : null
          this.deps.store.updateMessage(replyId, {
            ...meta,
            status: 'done',
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
