import { useEffect, useState } from 'react'
import type { TickSummary } from '@core/engine/scheduler'
import { rangeFromPreset, type DateRange } from './lib/daterange'
import TitleBar from './components/TitleBar'
import Onboarding from './components/Onboarding'

import Overview from './pages/Overview'
import Trend from './pages/Trend'
import Sessions from './pages/Sessions'
import Sources from './pages/Sources'
import Settings from './pages/Settings'

type Page = 'overview' | 'trend' | 'sessions' | 'sources' | 'settings'

const NAV: { id: Page; label: string }[] = [
  { id: 'overview', label: '总览' },
  { id: 'trend', label: '趋势' },
  { id: 'sessions', label: '会话' },
  { id: 'sources', label: '数据源' },
  { id: 'settings', label: '设置' }
]

export default function App(): React.JSX.Element {
  const [page, setPage] = useState<Page>('overview')
  const [onboarded, setOnboarded] = useState<boolean | null>(null)
  const [lastTick, setLastTick] = useState<TickSummary | undefined>()
  const [tickVersion, setTickVersion] = useState(0)
  const [range, setRange] = useState<DateRange>(() => rangeFromPreset('today'))

  useEffect(() => {
    void window.api.getConfig().then((c) => setOnboarded(c.onboarded))
    const off = window.api.onTick((summary) => {
      setLastTick(summary)
      setTickVersion((v) => v + 1)
    })
    return off
  }, [])

  if (onboarded === null) {
    return <div className="boot">正在初始化…</div>
  }

  const RANGE_PAGES: Page[] = ['overview', 'trend', 'sessions']

  return (
    <div className="app-frame">
      <TitleBar
        showRangePicker={RANGE_PAGES.includes(page)}
        range={range}
        onRangeChange={setRange}
        onBrandClick={() => setPage('overview')}
      />
      <div className="shell">
        <aside className="sidebar">
        <nav className="nav">
          {NAV.map((n) => (
            <button
              key={n.id}
              className={`nav-item ${page === n.id ? 'active' : ''}`}
              onClick={() => setPage(n.id)}
            >
              {n.label}
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          {lastTick ? (
            <span title={`上次采集 ${lastTick.durationMs}ms`}>
              采集正常 · {new Date(lastTick.startedAt).toLocaleTimeString()}
            </span>
          ) : (
            <span>等待首次采集…</span>
          )}
        </div>
      </aside>
      <main className="content">
        {page === 'overview' && <Overview range={range} tickVersion={tickVersion} />}
        {page === 'trend' && <Trend range={range} tickVersion={tickVersion} />}
        {page === 'sessions' && <Sessions range={range} tickVersion={tickVersion} />}
        {page === 'sources' && <Sources />}
        {page === 'settings' && <Settings onReplayOnboarding={() => setOnboarded(false)} />}
      </main>
      </div>
      {!onboarded && (
        <Onboarding
          onDone={() => {
            setOnboarded(true)
          }}
        />
      )}
    </div>
  )
}
