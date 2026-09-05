import { useEffect, useMemo, useRef, useState } from 'react'
import type { AgentId, LiveAgentCard, LiveStatus, LiveTimelineItem } from '@core/model/types'
import { formatTokens, formatUSD } from '../lib/format'

type FilterId = 'all' | 'running' | 'idle' | 'error'

const FILTERS: { id: FilterId; label: string }[] = [
  { id: 'all', label: '全部' },
  { id: 'running', label: '运行中' },
  { id: 'idle', label: '空闲' },
  { id: 'error', label: '异常' }
]

const STATUS_META: Record<LiveStatus, { label: string; dot: string }> = {
  thinking: { label: '思考中', dot: 'dot-thinking' },
  waiting: { label: '等待模型', dot: 'dot-waiting' },
  tool: { label: '调用工具', dot: 'dot-tool' },
  idle: { label: '空闲', dot: 'dot-idle' },
  error: { label: '异常', dot: 'dot-error' }
}

const isRunning = (s: LiveStatus): boolean => s === 'thinking' || s === 'waiting' || s === 'tool'

/** 聚合状态：任一异常 → 异常；否则任一运行 → 运行；否则空闲 */
function rollupStatus(list: LiveAgentCard[]): LiveStatus {
  if (list.some((c) => c.status === 'error')) return 'error'
  if (list.some((c) => isRunning(c.status))) return 'thinking'
  return 'idle'
}

const rollupRank = (s: LiveStatus): number => (s === 'error' ? 2 : isRunning(s) ? 0 : 1)

/** 一个 Agent（种类）一张卡，多会话折叠在卡内 */
interface AgentGroup {
  agent: AgentId
  list: LiveAgentCard[] // 主会话（最近活动）在首位
  status: LiveStatus
}

export default function LiveBoard(props: {
  tickVersion: number
  onJumpToSessions: (agent: AgentId) => void
}): React.JSX.Element {
  const [cards, setCards] = useState<LiveAgentCard[] | null>(null)
  const [filter, setFilter] = useState<FilterId>('all')
  const [expanded, setExpanded] = useState<Set<AgentId>>(new Set())
  const [selected, setSelected] = useState<LiveAgentCard | null>(null)
  const [timeline, setTimeline] = useState<LiveTimelineItem[] | null>(null)
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; card: LiveAgentCard } | null>(null)
  // 1 秒本地节拍：时长与 token 平滑递增
  const [nowTick, setNowTick] = useState(() => Date.now())
  const shownTokensRef = useRef(new Map<string, { taskStart: number; tokens: number }>())

  useEffect(() => {
    void window.api.getLiveAgents().then((next) => {
      const liveKeys = new Set(next.map((c) => `${c.agent}:${c.sessionId}`))
      for (const k of shownTokensRef.current.keys()) {
        if (!liveKeys.has(k)) shownTokensRef.current.delete(k)
      }
      setCards(next)
    })
  }, [props.tickVersion])

  useEffect(() => {
    const t = setInterval(() => setNowTick(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])

  useEffect(() => {
    if (!selected) return
    setTimeline(null)
    void window.api.getLiveTimeline(selected.agent, selected.sessionId).then(setTimeline)
  }, [selected])

  useEffect(() => {
    if (!ctxMenu) return
    const close = (): void => setCtxMenu(null)
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setCtxMenu(null)
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', onKey)
    }
  }, [ctxMenu])

  const groups = useMemo<AgentGroup[]>(() => {
    if (!cards) return []
    const m = new Map<AgentId, LiveAgentCard[]>()
    for (const c of cards) {
      const list = m.get(c.agent) ?? []
      list.push(c)
      m.set(c.agent, list)
    }
    return [...m.entries()]
      .map(([agent, list]) => {
        const sorted = [...list].sort((a, b) => b.lastActivityTs - a.lastActivityTs)
        return { agent, list: sorted, status: rollupStatus(sorted) }
      })
      .sort((a, b) => rollupRank(a.status) - rollupRank(b.status))
  }, [cards])

  const filtered = useMemo(() => {
    if (filter === 'all') return groups
    return groups.filter((g) => (filter === 'running' ? isRunning(g.status) : g.status === filter))
  }, [groups, filter])

  const runningAgents = groups.filter((g) => isRunning(g.status)).length
  const totalSessions = cards?.length ?? 0

  return (
    <div className="page live-page">
      <header className="live-head">
        <h1 className="live-title">Agent 实时看板</h1>
        <span className="live-count">
          {groups.length} 种 Agent · {totalSessions} 个会话 · {runningAgents} 个运行中
        </span>
      </header>

      <div className="live-filters">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            className={`live-filter ${filter === f.id ? 'on' : ''}`}
            onClick={() => setFilter(f.id)}
          >
            {f.label}
          </button>
        ))}
      </div>

      {cards != null && cards.length === 0 ? (
        <EmptyState />
      ) : (
        <div className="live-grid live-grid-agents">
          {filtered.map((g) => (
            <AgentGroupCard
              key={g.agent}
              group={g}
              now={nowTick}
              shownTokensRef={shownTokensRef.current}
              expanded={expanded.has(g.agent)}
              onToggle={() => {
                setExpanded((prev) => {
                  const next = new Set(prev)
                  if (next.has(g.agent)) next.delete(g.agent)
                  else next.add(g.agent)
                  return next
                })
              }}
              onOpenSession={(c) => setSelected(c)}
              onContextMenu={(x, y, c) => setCtxMenu({ x, y, card: c })}
            />
          ))}
        </div>
      )}

      {selected && (
        <TimelinePanel
          card={selected}
          timeline={timeline}
          onClose={() => setSelected(null)}
          onJump={() => {
            const agent = selected.agent
            setSelected(null)
            props.onJumpToSessions(agent)
          }}
        />
      )}

      {ctxMenu && (
        <div className="ctx-menu" style={{ left: ctxMenu.x, top: ctxMenu.y }}>
          <button
            className="ctx-item"
            onClick={() => {
              void window.api.getLiveAgents().then(setCards)
              setCtxMenu(null)
            }}
          >
            刷新状态
          </button>
          <button
            className="ctx-item"
            onClick={() => {
              void window.api.copyText(ctxMenu.card.sessionId)
              setCtxMenu(null)
            }}
          >
            复制会话 ID
          </button>
          {ctxMenu.card.logFilePath && (
            <button
              className="ctx-item"
              onClick={() => {
                void window.api.showLogInFolder(ctxMenu.card.logFilePath!)
                setCtxMenu(null)
              }}
            >
              查看日志文件
            </button>
          )}
        </div>
      )}
    </div>
  )
}

/** 平滑 token（任务内单调保持，任务切换归零） */
function smoothTokensOf(
  c: LiveAgentCard,
  now: number,
  shown: Map<string, { taskStart: number; tokens: number }>
): number {
  const key = `${c.agent}:${c.sessionId}`
  const computed =
    c.taskTokens + Math.round((c.rateTokensPerSec * Math.max(0, now - c.polledAt)) / 1000)
  const prev = shown.get(key)
  const inSameTask = prev != null && prev.taskStart === c.taskStartTs
  const val = inSameTask ? Math.max(computed, prev.tokens) : computed
  shown.set(key, { taskStart: c.taskStartTs, tokens: val })
  return val
}

function AgentGroupCard(props: {
  group: AgentGroup
  now: number
  shownTokensRef: Map<string, { taskStart: number; tokens: number }>
  expanded: boolean
  onToggle: () => void
  onOpenSession: (c: LiveAgentCard) => void
  onContextMenu: (x: number, y: number, c: LiveAgentCard) => void
}): React.JSX.Element {
  const g = props.group
  const meta = STATUS_META[g.status]
  const main = g.list[0]! // 主会话 = 最近活动
  const totalTokens = g.list.reduce(
    (s, c) => s + smoothTokensOf(c, props.now, props.shownTokensRef),
    0
  )
  const elapsedMs = Math.max(0, props.now - main.taskStartTs)
  const hasError = g.status === 'error'
  const multi = g.list.length > 1

  return (
    <div className={`live-card live-card-agent ${hasError ? 'has-error' : ''}`}>
      <div
        className="live-card-head"
        onClick={multi ? props.onToggle : () => props.onOpenSession(main)}
        style={multi ? { cursor: 'pointer' } : undefined}
      >
        <span className="live-agent-name">
          <span className={`live-dot ${meta.dot}`} aria-hidden />
          {agentLabel(g.agent)}
        </span>
        {multi ? (
          <span className="live-project-tag">
            {props.expanded ? '▾' : '▸'} {g.list.length} 个会话
          </span>
        ) : (
          <span className="live-project-tag" title={main.projectPath}>
            {main.projectName}
          </span>
        )}
        {hasError && (
          <span
            className="live-anomaly-badge"
            title={g.list.find((c) => c.anomaly)?.anomaly}
          />
        )}
      </div>

      <p className="live-action" title={main.action}>
        {main.action}
        {multi && <span className="muted">（等 {g.list.length - 1} 个会话）</span>}
      </p>

      <div className="live-meta">
        <span className="live-meta-model">{main.model ?? '—'}</span>
        <span className="live-meta-num">{formatElapsed(elapsedMs)}</span>
        <span className="live-meta-num">{formatTokens(totalTokens)}</span>
      </div>

      {isRunning(g.status) && (
        <div className="live-progress">
          <div className="live-progress-bar" />
        </div>
      )}

      {/* 折叠区：多会话列表（单会话 Agent 不显示） */}
      {multi && props.expanded && (
        <div className="live-session-list">
          {g.list.map((c) => (
            <div
              key={c.sessionId}
              className={`live-session-row ${c.status === 'error' ? 'err' : ''}`}
              onClick={() => props.onOpenSession(c)}
              onContextMenu={(e) => {
                e.preventDefault()
                e.stopPropagation()
                props.onContextMenu(e.clientX, e.clientY, c)
              }}
              title={c.projectPath}
            >
              <span className={`live-dot sm ${STATUS_META[c.status].dot}`} aria-hidden />
              <span className="live-session-project">{c.projectName}</span>
              <span className="live-session-action">{c.action}</span>
              <span className="live-session-tokens">
                {formatTokens(smoothTokensOf(c, props.now, props.shownTokensRef))}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function TimelinePanel(props: {
  card: LiveAgentCard
  timeline: LiveTimelineItem[] | null
  onClose: () => void
  onJump: () => void
}): React.JSX.Element {
  return (
    <>
      <div className="live-panel-mask" onClick={props.onClose} />
      <aside className="live-panel">
        <header className="live-panel-head">
          <span>{agentLabel(props.card.agent)} · 实时请求流水</span>
          <button className="live-panel-close" onClick={props.onClose} aria-label="关闭">
            ✕
          </button>
        </header>
        <div className="live-timeline">
          {props.timeline === null && <p className="muted">加载中…</p>}
          {props.timeline != null && props.timeline.length === 0 && (
            <p className="muted">暂无请求记录</p>
          )}
          {props.timeline?.map((t, i) => (
            <div key={i} className="live-timeline-item">
              <span className="live-tl-ts">
                {new Date(t.ts).toLocaleTimeString(undefined, { hour12: false })}
              </span>
              <span className="live-tl-model">{t.model}</span>
              <span className="live-tl-tokens">
                {formatTokens(t.tokens)}
                {t.durationMs != null && ` · ${(t.durationMs / 1000).toFixed(1)}s`}
                {` · ≈${formatUSD(t.costEstUSD)}`}
              </span>
            </div>
          ))}
        </div>
        <footer className="live-panel-foot">
          <button className="primary" onClick={props.onJump}>
            查看完整会话
          </button>
        </footer>
      </aside>
    </>
  )
}

function EmptyState(): React.JSX.Element {
  return (
    <div className="live-empty">
      <svg width="48" height="48" viewBox="0 0 48 48" aria-hidden>
        <path
          d="M4 24h8l5-14 8 28 6-20 4 10h9"
          fill="none"
          stroke="#6c6c7d"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <p className="live-empty-title">暂无活动 Agent</p>
      <p className="live-empty-sub">所有 Agent 当前处于空闲状态</p>
    </div>
  )
}

function agentLabel(agent: string): string {
  const map: Record<string, string> = {
    'claude-code': 'Claude Code',
    codex: 'Codex',
    'gemini-cli': 'Gemini CLI',
    qwen: 'Qwen Code',
    zcode: 'ZCode'
  }
  return map[agent] ?? agent
}

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const pad = (x: number): string => `${x}`.padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`
}
