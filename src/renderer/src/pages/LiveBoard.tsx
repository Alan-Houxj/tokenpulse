import { useEffect, useMemo, useRef, useState } from 'react'
import type { AgentId, LiveAgentCard, LiveTimelineItem } from '@core/model/types'
import { formatTokens, formatUSD } from '../lib/format'

type FilterId = 'all' | 'running' | 'idle' | 'error'

const FILTERS: { id: FilterId; label: string }[] = [
  { id: 'all', label: '全部' },
  { id: 'running', label: '运行中' },
  { id: 'idle', label: '空闲' },
  { id: 'error', label: '异常' }
]

const STATUS_META: Record<LiveAgentCard['status'], { label: string; dot: string }> = {
  thinking: { label: '思考中', dot: 'dot-thinking' },
  waiting: { label: '等待模型', dot: 'dot-waiting' },
  tool: { label: '调用工具', dot: 'dot-tool' },
  idle: { label: '空闲', dot: 'dot-idle' },
  error: { label: '异常', dot: 'dot-error' }
}

const isRunning = (s: LiveAgentCard['status']): boolean => s === 'thinking' || s === 'waiting' || s === 'tool'

/** 卡片排序权重：运行系 → 空闲 → 异常（置底红标） */
const statusRank = (s: LiveAgentCard['status']): number =>
  isRunning(s) ? 0 : s === 'idle' ? 1 : 2

export default function LiveBoard(props: {
  tickVersion: number
  onJumpToSessions: (agent: AgentId) => void
}): React.JSX.Element {
  const [cards, setCards] = useState<LiveAgentCard[] | null>(null)
  const [filter, setFilter] = useState<FilterId>('all')
  const [selected, setSelected] = useState<LiveAgentCard | null>(null)
  const [timeline, setTimeline] = useState<LiveTimelineItem[] | null>(null)
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; card: LiveAgentCard } | null>(null)
  // 1 秒本地节拍：时长与 token 平滑递增（不等 5 秒轮询跳变）
  const [nowTick, setNowTick] = useState(() => Date.now())
  const boardRef = useRef<HTMLDivElement>(null)
  // 累计 token 单调保持：外推重置若低于已显示值则不回退（累计语义只涨不减）；
  // 任务切换（taskStart 变化）时重置归零
  const shownTokensRef = useRef(new Map<string, { taskStart: number; tokens: number }>())

  useEffect(() => {
    void window.api.getLiveAgents().then((next) => {
      // 清理已消失卡片的记录，防止 Map 无限增长
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

  // 右键菜单：点外部 / Escape 关闭
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

  const filtered = useMemo(() => {
    if (!cards) return []
    if (filter === 'all') return cards
    if (filter === 'running') return cards.filter((c) => isRunning(c.status))
    if (filter === 'idle') return cards.filter((c) => c.status === 'idle')
    return cards.filter((c) => c.status === 'error')
  }, [cards, filter])

  // 按项目分组；有运行中 Agent 的组置顶；组内按状态排序、再按最近活动
  const groups = useMemo(() => {
    const m = new Map<string, LiveAgentCard[]>()
    for (const c of filtered) {
      const list = m.get(c.projectName) ?? []
      list.push(c)
      m.set(c.projectName, list)
    }
    return [...m.entries()]
      .map(([name, list]) => ({
        name,
        list: [...list].sort(
          (a, b) => statusRank(a.status) - statusRank(b.status) || b.lastActivityTs - a.lastActivityTs
        )
      }))
      .sort((a, b) => {
        const aRun = a.list.some((c) => isRunning(c.status)) ? 0 : 1
        const bRun = b.list.some((c) => isRunning(c.status)) ? 0 : 1
        return aRun - bRun
      })
  }, [filtered])

  const runningCount = cards?.filter((c) => isRunning(c.status)).length ?? 0

  return (
    <div className="page live-page" ref={boardRef}>
      <header className="live-head">
        <h1 className="live-title">Agent 实时看板</h1>
        <span className="live-count">
          共 {cards?.length ?? 0} 个 Agent · {runningCount} 个运行中
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
        <div className="live-groups">
          {groups.map((g) => (
            <section key={g.name} className="live-group">
              <h2 className="live-group-title">{g.name}</h2>
              <div className="live-grid">
                {g.list.map((c) => (
                  <AgentCard
                    key={`${c.agent}:${c.sessionId}`}
                    card={c}
                    now={nowTick}
                    shownTokensRef={shownTokensRef.current}
                    onClick={() => setSelected(c)}
                    onContextMenu={(x, y) => setCtxMenu({ x, y, card: c })}
                  />
                ))}
              </div>
            </section>
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
            复制 Agent ID
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

function AgentCard(props: {
  card: LiveAgentCard
  now: number
  shownTokensRef: Map<string, { taskStart: number; tokens: number }>
  onClick: () => void
  onContextMenu: (x: number, y: number) => void
}): React.JSX.Element {
  const c = props.card
  const meta = STATUS_META[c.status]
  // 平滑递增：时长 = now - 任务起点；token = 采集值 + 速率 × 经过时间
  const elapsedMs = Math.max(0, props.now - c.taskStartTs)
  const key = `${c.agent}:${c.sessionId}`
  const computed =
    c.taskTokens + Math.round((c.rateTokensPerSec * Math.max(0, props.now - c.polledAt)) / 1000)
  // 单调保持（任务内）：轮询重置值低于已显示值时不回退；新任务（起点变化）归零重计
  const prev = props.shownTokensRef.get(key)
  const inSameTask = prev != null && prev.taskStart === c.taskStartTs
  const shown = inSameTask ? Math.max(computed, prev.tokens) : computed
  props.shownTokensRef.set(key, { taskStart: c.taskStartTs, tokens: shown })
  const smoothTokens = shown
  const showProgress = c.status === 'thinking' || c.status === 'waiting' || c.status === 'tool'

  return (
    <div
      className={`live-card ${c.status === 'error' ? 'has-error' : ''}`}
      onClick={props.onClick}
      onContextMenu={(e) => {
        e.preventDefault()
        props.onContextMenu(e.clientX, e.clientY)
      }}
    >
      <div className="live-card-head">
        <span className="live-agent-name">
          <span className={`live-dot ${meta.dot}`} aria-hidden />
          {agentLabel(c.agent)}
        </span>
        <span className="live-project-tag" title={c.projectPath}>
          {c.projectName}
        </span>
        {c.anomaly && (
          <span className="live-anomaly-badge" title={c.anomaly} aria-label="异常" />
        )}
      </div>

      <p className="live-action" title={c.action}>
        {c.action}
      </p>

      <div className="live-meta">
        <span className="live-meta-model">{c.model ?? '—'}</span>
        <span className="live-meta-num">{formatElapsed(elapsedMs)}</span>
        <span className="live-meta-num">{formatTokens(smoothTokens)}</span>
      </div>

      {showProgress && (
        <div className="live-progress">
          <div className="live-progress-bar" />
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
          <span>
            {agentLabel(props.card.agent)} · 实时请求流水
          </span>
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
