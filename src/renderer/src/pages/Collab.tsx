import { useEffect, useMemo, useRef, useState } from 'react'
import { LoaderCircle, Plus, Trash2 } from 'lucide-react'
import type { CollabMessage, CollabRoom, Participant } from '@core/collab/types'
import Dropdown from '../components/Dropdown'
import { formatTokens, formatUSD } from '../lib/format'

/** 房间编辑器表单态 */
interface RoomForm {
  id?: string
  name: string
  workspace: string
  participants: Participant[]
  contextMessages: number
  timeoutMin: number
}

/** 协作页：多 Agent 协同 IM（@ 提及召唤，Agent 最终输出回房） */
export default function Collab(): React.JSX.Element {
  const [presets, setPresets] = useState<Participant[]>([])
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
    void window.api.collabPresets().then(setPresets)
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

  // 新消息到底部
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight })
  }, [messages])

  const mentionQuery = useMemo(() => {
    // 输入结尾处于 "@词" 状态时弹提及面板
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
        contextMessages: editor.contextMessages,
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
                    contextMessages: room.contextMessages,
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
              placeholder="如：重构支付模块"
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
              {presets.map((s) => {
                const on = editor.participants.some((p) => p.name === s.name)
                return (
                  <button
                    key={s.id}
                    className={`model-chip ${on ? 'on' : ''}`}
                    style={on ? { borderColor: s.color } : undefined}
                    onClick={() =>
                      setEditor({
                        ...editor,
                        participants: on
                          ? editor.participants.filter((p) => p.name !== s.name)
                          : [...editor.participants, { ...s, id: `pt-${Date.now()}-${s.name}` }]
                      })
                    }
                  >
                    <span className="chip-dot" style={{ background: on ? s.color : '#475569' }} />
                    {s.name}
                  </button>
                )
              })}
            </div>
          </div>
          <div className="form-row">
            <label>自定义参与者</label>
            <button onClick={() => setEditor({ ...editor, participants: [...editor.participants, newParticipant()] })}>
              <Plus size={13} aria-hidden /> 添加
            </button>
          </div>
          {editor.participants
            .filter((p) => p.agentKind === 'custom' || !presets.some((s) => s.name === p.name))
            .map((p, i) => (
              <div key={p.id} className="collab-custom-row">
                <input
                  type="text"
                  placeholder="名字"
                  value={p.name}
                  onChange={(e) => updateCustom(editor, setEditor, p.id, { name: e.target.value }, i)}
                />
                <input
                  type="text"
                  className="mono"
                  placeholder="命令（无 {prompt} 则输入走 stdin）"
                  value={p.command}
                  onChange={(e) => updateCustom(editor, setEditor, p.id, { command: e.target.value }, i)}
                />
                <button
                  className="small-btn danger"
                  onClick={() =>
                    setEditor({ ...editor, participants: editor.participants.filter((x) => x.id !== p.id) })
                  }
                >
                  移除
                </button>
              </div>
            ))}
          <div className="form-row">
            <label>上下文条数</label>
            <input
              type="number"
              min={2}
              max={100}
              className="collab-num"
              value={editor.contextMessages}
              onChange={(e) => setEditor({ ...editor, contextMessages: Number(e.target.value) })}
            />
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
              </span>
            ))}
            <span className="muted small collab-hint">
              输入 @ 召唤对应 Agent；可同时 @ 多个（按顺序执行）；Agent 之间的 @ 不会自动触发
            </span>
          </div>

          <div className="collab-list" ref={listRef}>
            {messages.length === 0 && (
              <p className="muted collab-empty">
                还没有消息。试着发一条：@{room.participants[0]?.name ?? 'Agent'} 看看当前目录的结构，提出重构建议
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
                placeholder={`发消息，@ 名字召唤 Agent…`}
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
            Agent 在房间的工作目录里执行，把最终结果带回群里。每条回复自动附带本次运行的 token 消耗与成本估算。
          </p>
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
          {m.tokens != null && m.tokens > 0 && <> · {formatTokens(m.tokens)} tokens</>}
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
  return { name: '', workspace: '', participants: [], contextMessages: 20, timeoutMin: 10 }
}

function newParticipant(): Participant {
  return {
    id: `pt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    name: '',
    agentKind: 'custom',
    color: '#fbbf24',
    command: ''
  }
}

function updateCustom(
  editor: RoomForm,
  setEditor: (f: RoomForm) => void,
  id: string,
  patch: Partial<Participant>,
  _i: number
): void {
  setEditor({ ...editor, participants: editor.participants.map((p) => (p.id === id ? { ...p, ...patch } : p)) })
}
