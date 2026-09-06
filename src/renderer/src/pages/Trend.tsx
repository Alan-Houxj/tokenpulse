import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Bar,
  BarChart,
  Brush,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip as ReTooltip,
  XAxis,
  YAxis
} from 'recharts'
import type { TrendPointByModel } from '@core/model/types'
import { bucketForRange, type DateRange } from '../lib/daterange'
import { formatTokens } from '../lib/format'

/** 图表分类色板（Tremor 暗色 400 级） */
const MODEL_COLORS = ['#60a5fa', '#34d399', '#a78bfa', '#fbbf24', '#22d3ee', '#f472b6', '#f87171', '#e8eaed']

type Dim = 'token' | 'money'

/** 金额精度：<$0.1 保留 4 位，否则 2 位（需求口径） */
function fmtMoney(v: number): string {
  if (v === 0) return '$0'
  return v < 0.1 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`
}

/** 浮窗悬停态：柱子锚点 + 桶信息 */
interface TipState {
  bs: number
  label: string
  x: number
  chartWidth: number
}

/** 趋势：分模型堆叠柱（Grafana 式离散桶），Token/金额维度切换，chips 筛选，结构化悬停浮窗 */
export default function Trend(props: {
  range: DateRange
  tickVersion: number
}): React.JSX.Element {
  const [byModel, setByModel] = useState<TrendPointByModel[]>([])
  const [enabled, setEnabled] = useState<Set<string> | null>(null) // null = 全部启用
  const [loading, setLoading] = useState(true)
  const [dim, setDim] = useState<Dim>('token')
  const [tip, setTip] = useState<TipState | null>(null)
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const bucket = bucketForRange(props.range)

  useEffect(() => {
    setLoading(true)
    const { from, to } = props.range
    void window.api.getTrendByModel(from, to, bucket).then((m) => {
      setByModel(m)
      setLoading(false)
    })
  }, [props.range, bucket, props.tickVersion])

  const models = useMemo(() => {
    const totals = new Map<string, number>()
    for (const p of byModel) totals.set(p.model, (totals.get(p.model) ?? 0) + p.total)
    return [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([m]) => m)
  }, [byModel])

  const effectiveEnabled = enabled ?? new Set(models)

  const bucketLabel = (ts: number): string =>
    new Date(ts).toLocaleString(undefined, {
      month: bucket === 'hour' ? undefined : 'numeric',
      day: bucket === 'hour' ? undefined : 'numeric',
      hour: bucket === 'hour' ? '2-digit' : undefined,
      minute: bucket === 'hour' ? '2-digit' : undefined
    })

  const modelData = useMemo(() => {
    // 补零桶：时间轴完整覆盖整个区间（无活动的天也占位）
    const rows: Record<string, number | string>[] = []
    const byBucket = new Map<number, Record<string, number | string>>()
    const ensure = (ts: number): Record<string, number | string> => {
      let row = byBucket.get(ts)
      if (!row) {
        row = { label: bucketLabel(ts), bs: ts }
        byBucket.set(ts, row)
        rows.push(row)
      }
      return row
    }
    // 生成本地时区对齐的完整桶序列（按日历步进，避免 DST 偏移）
    const step = bucket === 'hour' ? 3_600_000 : 86_400_000
    const cursor = new Date(props.range.from)
    if (bucket === 'hour') cursor.setMinutes(0, 0, 0)
    else cursor.setHours(0, 0, 0, 0)
    while (cursor.getTime() < props.range.to) {
      ensure(cursor.getTime())
      if (bucket === 'day') cursor.setDate(cursor.getDate() + 1)
      else cursor.setTime(cursor.getTime() + step)
    }
    for (const p of byModel) {
      const row = ensure(p.bucketStart)
      if (effectiveEnabled.has(p.model)) {
        const v = dim === 'money' ? p.costEstUSD : p.total
        row[p.model] = Number(row[p.model] ?? 0) + v
      }
    }
    return rows
  }, [byModel, effectiveEnabled, bucket, props.range, dim])

  const total = byModel.filter((p) => effectiveEnabled.has(p.model)).reduce((s, p) => s + p.total, 0)
  const cost = byModel.filter((p) => effectiveEnabled.has(p.model)).reduce((s, p) => s + p.costEstUSD, 0)
  const otherTotal = byModel.filter((p) => !effectiveEnabled.has(p.model)).reduce((s, p) => s + p.total, 0)

  const cancelHide = (): void => {
    if (hideTimer.current) {
      clearTimeout(hideTimer.current)
      hideTimer.current = null
    }
  }
  const onTipHover = (next: TipState): void => {
    cancelHide()
    setTip((prev) =>
      prev && prev.bs === next.bs && prev.x === next.x && prev.chartWidth === next.chartWidth ? prev : next
    )
  }
  const scheduleHide = (): void => {
    cancelHide()
    hideTimer.current = setTimeout(() => setTip(null), 200)
  }
  useEffect(() => cancelHide, [])

  const switchDim = (d: Dim): void => {
    setDim(d)
    setTip(null) // 维度切换时浮窗数据口径失效，直接收起
  }

  // 浮窗宽度与容器实测宽度（chart-wrap = svg 实际占位，比 viewBox 更可靠）
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const TIP_W = 252
  const chartW = wrapRef.current?.clientWidth ?? tip?.chartWidth ?? 0
  // 浮窗锚定：固定在柱子一侧，靠右边缘翻转到左侧；最终夹紧在 [0, 容器-浮窗宽]，
  // 窄窗口下翻转后为负也会被拉回，任何情况下不横向溢出图表区
  const tipX = tip
    ? Math.max(
        0,
        Math.min(
          tip.x + 14 + TIP_W > chartW ? tip.x - 14 - TIP_W : tip.x + 14,
          Math.max(0, chartW - TIP_W - 4)
        )
      )
    : 0

  // 当前悬停桶的明细（按图例顺序，只含有数据的已启用模型）
  const tipPoints = useMemo(
    () =>
      tip == null
        ? []
        : byModel.filter((p) => p.bucketStart === tip.bs && effectiveEnabled.has(p.model) && p.total > 0),
    [tip, byModel, effectiveEnabled]
  )

  return (
    <div className="page">
      <div className="stat-cards two">
        <div className="stat-card">
          <div className="stat-title">区间消耗</div>
          <div className="stat-value">{formatTokens(total)}</div>
          {otherTotal > 0 && (
            <div className="stat-sub muted small">另有未展开模型 {formatTokens(otherTotal)}</div>
          )}
        </div>
        <div className="stat-card">
          <div className="stat-title">区间估算成本</div>
          <div className="stat-value">{fmtMoney(cost)}</div>
        </div>
      </div>

      {models.length > 0 && (
        <div className="model-chips">
          {models.map((m, i) => {
            const on = effectiveEnabled.has(m)
            const color = MODEL_COLORS[i % MODEL_COLORS.length]
            return (
              <button
                key={m}
                className={`model-chip ${on ? 'on' : ''}`}
                style={on ? { borderColor: color } : undefined}
                onClick={() => {
                  const next = new Set(effectiveEnabled)
                  if (on) next.delete(m)
                  else next.add(m)
                  setEnabled(next)
                }}
              >
                <span className="chip-dot" style={{ background: on ? color : '#475569' }} />
                {m}
              </button>
            )
          })}
          <button className="model-chip model-chip-all" onClick={() => setEnabled(null)}>
            全选
          </button>
        </div>
      )}

      <section className="panel">
        <div className="trend-chart-head">
          <div className="trend-chart-title">
            <h3>{bucket === 'hour' ? '按小时' : '按天'}消耗分布</h3>
            <span className="trend-unit">单位：{dim === 'token' ? 'tokens' : '美元（估算）'}</span>
          </div>
          <div className="chart-seg">
            <button className={dim === 'token' ? 'on' : ''} onClick={() => switchDim('token')}>
              Token 消耗
            </button>
            <button className={dim === 'money' ? 'on' : ''} onClick={() => switchDim('money')}>
              金额消耗
            </button>
          </div>
        </div>
        {loading ? (
          <p className="muted">加载中…</p>
        ) : modelData.length === 0 || models.length === 0 ? (
          <p className="muted">该区间暂无数据</p>
        ) : (
          <div className="chart-wrap" ref={wrapRef}>
            <ResponsiveContainer width="100%" height={380}>
              <BarChart
                data={modelData}
                margin={{ top: 8, right: 12, bottom: 0, left: 0 }}
                barCategoryGap="18%"
                onMouseLeave={scheduleHide}
              >
                <CartesianGrid horizontal vertical={false} stroke="rgba(255,255,255,0.06)" />
                <XAxis
                  dataKey="label"
                  tick={{ fill: '#6b7280', fontSize: 11 }}
                  tickLine={false}
                  axisLine={false}
                  minTickGap={24}
                  dy={6}
                />
                <YAxis
                  tick={{ fill: '#6b7280', fontSize: 11 }}
                  tickLine={false}
                  axisLine={false}
                  width={dim === 'money' ? 64 : 52}
                  tickFormatter={(v: number) => (dim === 'money' ? fmtMoney(v) : formatTokens(v))}
                />
                <ReTooltip
                  cursor={{ fill: 'rgba(255,255,255,0.04)' }}
                  isAnimationActive={false}
                  content={<TipPump onHover={onTipHover} onInactive={scheduleHide} />}
                />
                {models
                  .filter((m) => effectiveEnabled.has(m))
                  .map((m) => {
                    const color = MODEL_COLORS[models.indexOf(m) % MODEL_COLORS.length]
                    return (
                      <Bar
                        key={m}
                        dataKey={m}
                        name={m}
                        stackId="models"
                        fill={color}
                        fillOpacity={0.85}
                        maxBarSize={36}
                        animationDuration={300}
                      />
                    )
                  })}
                {/* 拖拽窗口：默认全选，可左右拉动聚焦区间 */}
                {modelData.length > 12 && (
                  <Brush
                    dataKey="label"
                    height={22}
                    travellerWidth={8}
                    stroke="#5b8cff"
                    fill="rgba(255,255,255,0.03)"
                    tickFormatter={() => ''}
                  />
                )}
              </BarChart>
            </ResponsiveContainer>

            {tip != null && tipPoints.length > 0 && (
              <div
                className={`trend-tip${tipPoints.length > 4 ? ' compact' : ''}`}
                style={{ left: tipX, top: 8 }}
                role="tooltip"
              >
                <div className="trend-tip-head">
                  {tip.label} · {dim === 'token' ? 'Token 消耗' : '金额消耗'}
                </div>
                {tipPoints.map((p) => {
                  const idx = models.indexOf(p.model)
                  const color = MODEL_COLORS[idx % MODEL_COLORS.length]
                  const cacheTok = p.cacheRead + p.cacheWrite
                  // 为 0 的明细行不显示（纯输出调用不显示「输入」行）
                  const details = [
                    { k: '输入', tok: p.input, usd: p.costInput },
                    { k: '输出', tok: p.output, usd: p.costOutput },
                    { k: 'KV 缓存', tok: cacheTok, usd: p.costCache }
                  ].filter((d) => d.tok > 0)
                  return (
                    <div key={p.model} className="trend-tip-model">
                      <div className="trend-tip-main">
                        <span className="trend-tip-dot" style={{ background: color }} />
                        <span className="trend-tip-name">{p.model}</span>
                        <span className="trend-tip-val">
                          {dim === 'token' ? formatTokens(p.total) : `${fmtMoney(p.costEstUSD)} (${formatTokens(p.total)})`}
                        </span>
                      </div>
                      {details.map((d) => (
                        <div key={d.k} className="trend-tip-sub">
                          <span className="trend-tip-sub-k">{d.k}</span>
                          <span className="trend-tip-sub-v">
                            {dim === 'token' ? formatTokens(d.tok) : fmtMoney(d.usd)}
                          </span>
                        </div>
                      ))}
                    </div>
                  )
                })}
                <div className="trend-tip-total">
                  <span>合计</span>
                  <span>
                    {dim === 'token'
                      ? formatTokens(tipPoints.reduce((s, p) => s + p.total, 0))
                      : fmtMoney(tipPoints.reduce((s, p) => s + p.costEstUSD, 0))}
                  </span>
                </div>
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  )
}

/** Recharts 数据泵：不做渲染，只把当前悬停柱的锚点与桶信息回调给外层自绘浮窗 */
function TipPump(props: {
  active?: boolean
  payload?: { payload?: { bs?: number } }[]
  label?: string
  coordinate?: { x: number; y: number }
  viewBox?: { width?: number }
  onHover: (t: TipState) => void
  onInactive: () => void
}): null {
  const { active, payload, label, coordinate, viewBox, onHover, onInactive } = props
  useEffect(() => {
    if (active && payload && payload.length > 0 && coordinate && payload[0]?.payload?.bs != null) {
      onHover({
        bs: Number(payload[0].payload.bs),
        label: String(label ?? ''),
        x: coordinate.x,
        chartWidth: viewBox?.width ?? 0
      })
    } else if (!active) {
      onInactive() // 悬停离开柱子（仍在图内空白区）→ 延迟隐藏
    }
  })
  return null
}
