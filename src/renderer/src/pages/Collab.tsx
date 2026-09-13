import { useEffect, useMemo, useRef, useState } from 'react'
import { LoaderCircle, Plus, Trash2 } from 'lucide-react'
import type { CollabAgentInfo, CollabMessage, CollabRoom, Participant, ReasoningLevel } from '@core/collab/types'
import Dropdown from '../components/Dropdown'
import { formatTokens, formatUSD } from '../lib/format'

/** 房间编辑器表单态 */
interface RoomForm {
  id?: string
  name: string
  workspace: string
  participants: Participant[]
  timeoutMin: number
}

const REASONING_OPTIONS = [
  { value: 'default', label: '默认强度' },
  { value: 'low', label: 'low' },
  { value: 'medium', label: 'medium' },
  { value: 'high', label: 'high' },
  { value: 'max', label: 'max' }
]

/** 协作页：多 Agent 协同 IM（@ 提及召唤，Agent 最终输出回房；每个 Agent 在房间内有持久 session） */
export default function Collab(): React.JSX.Element {
  const [agents, setAgents] = useState<CollabAgentInfo[]>([])
  const [rooms, setRooms] = useState<CollabRoom[]>([])
  const [currentId, setCurrentId] = useState<string>('')
  const [messages, setMessages] = useState<CollabMessage[]>([])
  const [input, setInput] = useState('')
  const [editor, setEditor] = useState<RoomForm | null>(null)
  const [mentionOpen, setMentionOpen] = useState(false)
  const [error, setError] = useState('')
  const listRef = useRef<HTMLDivElement | null>(null)

  const room = rooms.find((r) => r.id === currentId) ?? null
  const running = messages.some((m) => m.status === 'running')

  const refreshRooms = (): void => {
    void window.api.collabRooms().then((rs) => {
      setRooms(rs)
      setCurrentId((cur) => (rs.some((r) => r.id === cur) ? cur : (rs[0]?.id ?? '')))
    })
  }
  const refreshMessages = (roomId: string): void => {
    if (roomId !== currentId) return
    void window.api.collabMessages(roomId).then(setMessages)
  }

  useEffect(() => {
    void window.api.collabAgents().then(setAgents)
    refreshRooms()
  }, [])

  useEffect(() => {
    const off = window.api.onCollabEvent((d) => {
      refreshRooms()
      refreshMessages(d.roomId)
    })
    return off
  }, [currentId, rooms])

  useEffect(() => {
    if (currentId) void window.api.collabMessages(currentId).then(setMessages)
    else setMessages([])
  }, [currentId])

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight })
  }, [messages])

  const mentionQuery = useMemo(() => {
    const m = /@([\w.-]*)$/.exec(input)
    return m ? m[1]! : null
  }, [input])

  const insertMention = (p: Participant): void => {
    setInput((s) => s.replace(/@([\w.-]*)$/, `@${p.name} `))
    setMentionOpen(false)
  }

  const send = (): void => {
    const text = input.trim()
    if (!text || !room || running) return
    setError('')
    void window.api.collabSend(room.id, text).then((r) => {
      if (!r.ok && r.error) setError(r.error)
    })
    setInput('')
  }

  const saveRoom = (): void => {
    if (!editor) return
    void window.api
      .collabSaveRoom({
        id: editor.id,
        name: editor.name,
        workspace: editor.workspace,
        participants: editor.participants,
        timeoutMs: Math.round(editor.timeoutMin * 60_000)
      })
      .then((r) => {
        if (!r.ok) {
          setError(r.error ?? '保存失败')
          return
        }
        setEditor(null)
        refreshRooms()
        if (r.room) setCurrentId(r.room.id)
      })
  }

  const toggleAgent = (a: CollabAgentInfo): void => {
    if (!editor) return
    const on = editor.participants.some((p) => p.agentKind === a.agentKind)
    setEditor({
      ...editor,
      participants: on
        ? editor.participants.filter((p) => p.agentKind !== a.agentKind)
        : [...editor.participants, { id: `pt-${Date.now()}-${a.agentKind}`, agentKind: a.agentKind, name: a.name, color: a.color, reasoning: 'default' }]
    })
  }

  return (
    <div className="page collab-page">
      <header className="page-head collab-head">
        <div className="collab-head-left">
          {rooms.length > 0 && (
            <Dropdown
              width={200}
              value={currentId}
              options={rooms.map((r) => ({ value: r.id, label: r.name }))}
              onChange={(v) => setCurrentId(v)}
            />
          )}
          <button onClick={() => setEditor(newForm())}>
            <Plus size={13} aria-hidden /> 新建房间
          </button>
          {room && (
            <>
              <button
                onClick={() =>
                  setEditor({
                    id: room.id,
                    name: room.name,
                    workspace: room.workspace,
                    participants: room.participants,
                    timeoutMin: Math.round(room.timeoutMs / 6000) / 10
                  })
                }
              >
                编辑
              </button>
              <button
                className="danger-btn"
                onClick={() => {
                  void window.api.collabDeleteRoom(room.id).then(() => refreshRooms())
                }}
              >
                <Trash2 size={13} aria-hidden /> 删除
              </button>
            </>
          )}
        </div>
        {room && (
          <span className="muted small mono" title="Agent 的工作目录">
            {room.workspace}
          </span>
        )}
      </header>

      {editor && (
        <section className="panel collab-editor">
          <h3>{editor.id ? '编辑房间' : '新建房间'}</h3>
          <div className="form-row">
            <label>房间名</label>
            <input
              type="text"
              value={editor.name}
              placeholder="如：重构支付模块（同时是各 Agent 会话的显示名前缀）"
              onChange={(e) => setEditor({ ...editor, name: e.target.value })}
            />
          </div>
          <div className="form-row">
            <label>工作目录</label>
            <input
              type="text"
              className="mono"
              value={editor.workspace}
              placeholder="Agent 在此目录下执行，如 C:\proj\myapp"
              onChange={(e) => setEditor({ ...editor, workspace: e.target.value })}
            />
          </div>
          <div className="form-row">
            <label>参与者</label>
            <div className="collab-presets">
              {agents.map((a) => {
                const on = editor.participants.some((p) => p.agentKind === a.agentKind)
                return (
                  <button
                    key={a.agentKind}
                    className={`model-chip ${on ? 'on' : ''}`}
                    style={on ? { borderColor: a.color } : undefined}
                    title={a.ready ? undefined : a.reason}
                    onClick={() => a.ready && toggleAgent(a)}
                    disabled={!a.ready}
                  >
                    <span className="chip-dot" style={{ background: on ? a.color : '#475569' }} />
                    {a.name}
                    {!a.ready && <span className="muted small">（{a.reason}）</span>}
                  </button>
                )
              })}
            </div>
          </div>
          {editor.participants.length > 0 && (
            <div className="collab-settings">
              {editor.participants.map((p) => (
                <div key={p.id} className="collab-setting-row">
                  <span className="collab-setting-name" style={{ color: p.color }}>
                    {p.name}
                  </span>
                  <input
                    type="text"
                    placeholder="默认模型"
                    value={p.model ?? ''}
                    onChange={(e) =>
                      setEditor({
                        ...editor,
                        participants: editor.participants.map((x) => (x.id === p.id ? { ...x, model: e.target.value } : x))
                      })
                    }
                  />
                  <select
                    value={p.reasoning ?? 'default'}
                    onChange={(e) =>
                      setEditor({
                        ...editor,
                        participants: editor.participants.map((x) =>
                          x.id === p.id ? { ...x, reasoning: e.target.value as ReasoningLevel } : x
                        )
                      })
                    }
                  >
                    {REASONING_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </div>
              ))}
              <p className="muted small">
                模型留空用 Agent 默认；随时改，下次 @ 生效。模型/强度覆盖仅部分 Agent 支持（如 Codex）。
              </p>
            </div>
          )}
          <div className="form-row">
            <label>超时（分钟）</label>
            <input
              type="number"
              min={1}
              max={60}
              className="collab-num"
              value={editor.timeoutMin}
              onChange={(e) => setEditor({ ...editor, timeoutMin: Number(e.target.value) })}
            />
          </div>
          <div className="collab-editor-actions">
            <button className="primary" onClick={saveRoom}>
              保存房间
            </button>
            <button onClick={() => setEditor(null)}>取消</button>
          </div>
        </section>
      )}

      {room && !editor && (
        <>
          <div className="collab-members">
            <span className="muted small">参与者</span>
            {room.participants.map((p) => (
              <span key={p.id} className="collab-member" style={{ borderColor: p.color }}>
                <span className="chip-dot" style={{ background: p.color }} />
                {p.name}
                {p.model && <span className="muted small">{p.model}</span>}
              </span>
            ))}
            <span className="muted small collab-hint">
              输入 @ 召唤对应 Agent；可同时 @ 多个（按顺序执行）；每个 Agent 在房间内有自己的持久会话
            </span>
          </div>

          <div className="collab-list" ref={listRef}>
            {messages.length === 0 && (
              <p className="muted collab-empty">
                还没有消息。试着发一条：@{room.participants[0]?.name ?? 'Agent'} 看看当前目录的结构，提出建议
              </p>
            )}
            {messages.map((m) => (
              <MessageBubble key={m.id} m={m} room={room} />
            ))}
          </div>

          <div className="collab-input">
            <div className="collab-input-box">
              <textarea
                value={input}
                placeholder="发消息，@ 名字召唤 Agent…"
                rows={2}
                onChange={(e) => {
                  setInput(e.target.value)
                  setMentionOpen(/@([\w.-]*)$/.test(e.target.value))
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    send()
                  }
                }}
              />
              {mentionOpen && mentionQuery != null && room.participants.length > 0 && (
                <div className="collab-mention">
                  {room.participants
                    .filter((p) => p.name.toLowerCase().includes(mentionQuery.toLowerCase()))
                    .map((p) => (
                      <button key={p.id} onClick={() => insertMention(p)}>
                        <span className="chip-dot" style={{ background: p.color }} />
                        {p.name}
                      </button>
                    ))}
                </div>
              )}
            </div>
            <button className="primary" onClick={send} disabled={running || !input.trim()}>
              {running ? (
                <>
                  <LoaderCircle className="spin" size={13} aria-hidden /> 工作中
                </>
              ) : (
                '发送'
              )}
            </button>
          </div>
          {error && <div className="collab-error small">{error}</div>}
        </>
      )}

      {rooms.length === 0 && !editor && (
        <section className="panel collab-welcome">
          <h3>Agent 协作房间</h3>
          <p className="muted">
            把本机的多个 Agent 拉进同一间房：你（或 Agent）用 <strong>@名字</strong> 下发任务，
            Agent 在房间的工作目录里执行，把最终结果带回群里。每个 Agent 在房间内有自己的持久会话，
            每条回复自动附带本次运行的 token 消耗与成本估算。
          </p>
          {agents.filter((a) => a.ready).length === 0 && (
            <p className="warn small">当前没有就绪的 Agent：需要先安装并在数据源页扫描到，才能加入房间。</p>
          )}
          <button className="primary" onClick={() => setEditor(newForm())}>
            <Plus size={13} aria-hidden /> 新建第一个房间
          </button>
        </section>
      )}
    </div>
  )
}

function MessageBubble(props: { m: CollabMessage; room: CollabRoom }): React.JSX.Element {
  const { m, room } = props
  if (m.author === 'user') {
    return (
      <div className="collab-msg user">
        <div className="collab-msg-body">{m.text}</div>
      </div>
    )
  }
  const p = room.participants.find((x) => x.id === m.author)
  return (
    <div className="collab-msg agent">
      <div className="collab-msg-head">
        <span className="chip-dot" style={{ background: p?.color ?? '#6c6c7d' }} />
        <strong style={{ color: p?.color }}>{p?.name ?? m.author}</strong>
        {m.status === 'running' && (
          <span className="collab-running">
            <LoaderCircle className="spin" size={12} aria-hidden /> 正在工作…
          </span>
        )}
        {m.status === 'error' && <span className="probe-tag unrecognized">失败</span>}
        {m.status === 'timeout' && <span className="probe-tag unrecognized">超时</span>}
      </div>
      {m.text && <div className="collab-msg-body">{m.text}</div>}
      {m.error && <div className="collab-msg-error small">{m.error}</div>}
      {m.status === 'done' && (
        <div className="collab-msg-meta small">
          耗时 {formatDuration(m.durationMs ?? 0)}
          {m.promptEst != null && <> · 注入 ≈{formatTokens(m.promptEst)} tok</>}
          {m.tokens != null && m.tokens > 0 && <> · 本次 {formatTokens(m.tokens)} tokens</>}
          {m.costEstUSD != null && m.costEstUSD > 0 && <> · ≈{formatUSD(m.costEstUSD)}</>}
        </div>
      )}
    </div>
  )
}

function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`
}

function newForm(): RoomForm {
  return { name: '', workspace: '', participants: [], timeoutMin: 10 }
}
