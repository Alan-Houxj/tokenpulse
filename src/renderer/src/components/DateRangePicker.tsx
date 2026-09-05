import { useEffect, useMemo, useRef, useState } from 'react'
import {
  PRESETS,
  customRange,
  dayInputValue,
  rangeFromPreset,
  todayMidnight,
  type DateRange,
  type PresetId
} from '../lib/daterange'

const DAY = 86_400_000
const WEEK_LABELS = ['一', '二', '三', '四', '五', '六', '日']

type Mode = 'range' | 'single'

interface Picking {
  start?: number
  end?: number
}

/**
 * 双日历日期范围选择器。
 * - 左右并排双月历，联动翻页，禁选未来
 * - 时间段模式：起点→终点，悬停预高亮，可同日（0 天区间）
 * - 单日模式：点击即选中并关闭
 * - 快捷档：今日/近三天/近一周/近一月（含今天），点击后日历跳转并高亮
 * - 面板底部：确认 / 清空
 */
export default function DateRangePicker(props: {
  range: DateRange
  onChange: (r: DateRange) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<Mode>('range')
  const [viewMonth, setViewMonth] = useState(() => startOfMonth(props.range.from))
  const [picking, setPicking] = useState<Picking>({})
  const [hoverDay, setHoverDay] = useState<number | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  const today0 = todayMidnight()
  const maxViewMonth = startOfMonth(today0) // 左历最多翻到当前月（右历显示下月，未来格子全禁）

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  // 打开面板时：跳到当前范围所在月，并恢复进行中状态
  useEffect(() => {
    if (open) {
      setViewMonth(startOfMonth(props.range.from))
      setPicking({ start: dayStart(props.range.from), end: dayStart(props.range.to - DAY) })
      setHoverDay(null)
    }
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  const apply = (r: DateRange): void => {
    props.onChange(r)
    setOpen(false)
  }

  const onDayClick = (ts: number): void => {
    if (mode === 'single') {
      const d = dayInputValue(ts)
      apply(customRange(d, d))
      return
    }
    if (picking.start == null || (picking.start != null && picking.end != null)) {
      // 新一轮选择（或重选）
      setPicking({ start: ts })
      return
    }
    if (ts < picking.start) {
      setPicking({ start: ts })
      return
    }
    setPicking({ start: picking.start, end: ts }) // 含同日（0 天区间）
  }

  const confirmPicking = (): void => {
    if (picking.start == null) return
    const s = picking.start
    const e = picking.end ?? picking.start
    apply(customRange(dayInputValue(s), dayInputValue(e)))
  }

  const quick = (id: PresetId): void => {
    const r = rangeFromPreset(id)
    props.onChange(r)
    setPicking({ start: dayStart(r.from), end: dayStart(r.to - DAY) })
    setViewMonth(startOfMonth(r.from))
  }

  // 高亮区间（进行中优先，悬停预览）
  const preview = useMemo((): { from: number; to: number } | null => {
    if (picking.start == null) return null
    const s = picking.start
    const e = picking.end ?? (hoverDay != null && hoverDay >= s ? hoverDay : s)
    return { from: s, to: e }
  }, [picking, hoverDay])

  const triggerLabel =
    props.range.preset !== 'custom'
      ? (PRESETS.find((p) => p.id === props.range.preset)?.label ?? '选择日期')
      : props.range.label

  return (
    <div className={`drp ${open ? 'open' : ''}`} ref={rootRef}>
      <button type="button" className="dropdown-trigger drp-trigger" onClick={() => setOpen((o) => !o)}>
        <svg width="12" height="12" viewBox="0 0 14 14" aria-hidden className="drp-cal-icon">
          <rect x="1" y="2.5" width="12" height="10.5" rx="2" stroke="currentColor" strokeWidth="1.2" fill="none" />
          <path d="M1 5.5h12M4.5 1v3M9.5 1v3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
        <span className="dropdown-value">{triggerLabel}</span>
        <svg className={`dropdown-chevron ${open ? 'up' : ''}`} width="10" height="6" viewBox="0 0 10 6" aria-hidden>
          <path d="M1 1l4 4 4-4" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div className="drp-panel">
          <div className="drp-mode">
            <div className="seg">
              <button
                className={`seg-item ${mode === 'range' ? 'active' : ''}`}
                onClick={() => setMode('range')}
              >
                时间段
              </button>
              <button
                className={`seg-item ${mode === 'single' ? 'active' : ''}`}
                onClick={() => setMode('single')}
              >
                单日
              </button>
            </div>
            <span className="muted small">
              {mode === 'range' ? '点击起点与终点（可同一天）' : '点击日期即选中'}
            </span>
          </div>

          <div className="drp-calendars">
            <Calendar
              monthStart={viewMonth}
              prevDisabled={false}
              nextDisabled={viewMonth >= maxViewMonth}
              onPrev={() => setViewMonth((m) => shiftMonth(m, -1))}
              onNext={() => setViewMonth((m) => shiftMonth(m, 1))}
              today0={today0}
              preview={preview}
              hoverDay={hoverDay}
              onHover={setHoverDay}
              onPick={onDayClick}
            />
            <Calendar
              monthStart={shiftMonth(viewMonth, 1)}
              prevDisabled={false}
              nextDisabled={viewMonth >= maxViewMonth}
              onPrev={() => setViewMonth((m) => shiftMonth(m, -1))}
              onNext={() => setViewMonth((m) => shiftMonth(m, 1))}
              today0={today0}
              preview={preview}
              hoverDay={hoverDay}
              onHover={setHoverDay}
              onPick={onDayClick}
            />
          </div>

          <div className="drp-footer">
            <div className="drp-quick">
              {PRESETS.map((p) => (
                <button key={p.id} className="drp-quick-btn" onClick={() => quick(p.id)}>
                  {p.label}
                </button>
              ))}
            </div>
            <div className="drp-actions">
              <button className="drp-clear" onClick={() => setPicking({})}>
                清空
              </button>
              <button className="primary" disabled={picking.start == null} onClick={confirmPicking}>
                确认
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function Calendar(props: {
  monthStart: number
  prevDisabled: boolean
  nextDisabled: boolean
  onPrev: () => void
  onNext: () => void
  today0: number
  preview: { from: number; to: number } | null
  hoverDay: number | null
  onHover: (ts: number | null) => void
  onPick: (ts: number) => void
}): React.JSX.Element {
  const y = new Date(props.monthStart).getFullYear()
  const m = new Date(props.monthStart).getMonth()
  // 周一起始的网格首格
  const first = new Date(y, m, 1)
  const offset = (first.getDay() + 6) % 7
  const gridStart = new Date(y, m, 1 - offset).getTime()

  const cells: number[] = []
  for (let i = 0; i < 42; i++) cells.push(gridStart + i * DAY)

  return (
    <div className="cal">
      <div className="cal-head">
        <button className="cal-nav" disabled={props.prevDisabled} onClick={props.onPrev} aria-label="上一月">
          ‹
        </button>
        <span className="cal-title">
          {y} 年 {m + 1} 月
        </span>
        <button className="cal-nav" disabled={props.nextDisabled} onClick={props.onNext} aria-label="下一月">
          ›
        </button>
      </div>
      <div className="cal-grid">
        {WEEK_LABELS.map((w) => (
          <span key={w} className="cal-week">
            {w}
          </span>
        ))}
        {cells.map((ts) => {
          const day = new Date(ts)
          const inMonth = day.getMonth() === m
          const isFuture = ts > props.today0
          const isToday = ts === props.today0
          const p = props.preview
          const inPreview = p != null && ts >= p.from && ts <= p.to
          const isEdge = p != null && (ts === p.from || ts === p.to)
          const disabled = isFuture
          return (
            <button
              key={ts}
              type="button"
              className={[
                'cal-day',
                inMonth ? '' : 'out',
                isFuture ? 'future' : '',
                isToday ? 'today' : '',
                inPreview ? 'in-range' : '',
                isEdge ? 'edge' : ''
              ]
                .filter(Boolean)
                .join(' ')}
              disabled={disabled}
              onMouseEnter={() => !disabled && props.onHover(ts)}
              onMouseLeave={() => props.onHover(null)}
              onClick={() => !disabled && props.onPick(ts)}
            >
              {day.getDate()}
            </button>
          )
        })}
      </div>
    </div>
  )
}

function startOfMonth(ts: number): number {
  const d = new Date(ts)
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime()
}

function shiftMonth(monthStart: number, delta: number): number {
  const d = new Date(monthStart)
  return new Date(d.getFullYear(), d.getMonth() + delta, 1).getTime()
}

function dayStart(ts: number): number {
  const d = new Date(ts)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}
