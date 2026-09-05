import { useEffect, useMemo, useState } from 'react'
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip as ReTooltip,
  XAxis,
  YAxis
} from 'recharts'
import type { TrendPointByModel } from '@core/model/types'
import { bucketForRange, type DateRange } from '../lib/daterange'
import { formatTokens, formatUSD } from '../lib/format'

/** 图表分类色板（Tremor 暗色 400 级） */
const MODEL_COLORS = ['#60a5fa', '#34d399', '#a78bfa', '#fbbf24', '#22d3ee', '#f472b6', '#f87171', '#e8eaed']

/** 趋势：分模型堆叠柱（Grafana 式离散桶），chips 筛选 */
export default function Trend(props: {
  range: DateRange
  tickVersion: number
}): React.JSX.Element {
  const [byModel, setByModel] = useState<TrendPointByModel[]>([])
  const [enabled, setEnabled] = useState<Set<string> | null>(null) // null = 全部启用
  const [loading, setLoading] = useState(true)

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
    const buckets = new Map<number, Record<string, number | string>>()
    const ensure = (ts: number): Record<string, number | string> => {
      let row = buckets.get(ts)
      if (!row) {
        row = { label: bucketLabel(ts) }
        buckets.set(ts, row)
      }
      return row
    }
    for (const p of byModel) {
      const row = ensure(p.bucketStart)
      if (effectiveEnabled.has(p.model)) {
        row[p.model] = Number(row[p.model] ?? 0) + p.total
      }
    }
    return [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([, row]) => row)
  }, [byModel, effectiveEnabled])

  const total = byModel.filter((p) => effectiveEnabled.has(p.model)).reduce((s, p) => s + p.total, 0)
  const cost = byModel.filter((p) => effectiveEnabled.has(p.model)).reduce((s, p) => s + p.costEstUSD, 0)
  const otherTotal = byModel.filter((p) => !effectiveEnabled.has(p.model)).reduce((s, p) => s + p.total, 0)

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
          <div className="stat-value">{formatUSD(cost)}</div>
          <div className="stat-sub">API 等价估算</div>
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
          <button className="model-chip" onClick={() => setEnabled(null)}>
            全选
          </button>
        </div>
      )}

      <section className="panel">
        <h3>
          {bucket === 'hour' ? '按小时' : '按天'}消耗分布
          <span className="muted small" style={{ marginLeft: 10, fontWeight: 400 }}>
            点上方标签筛选模型
          </span>
        </h3>
        {loading ? (
          <p className="muted">加载中…</p>
        ) : modelData.length === 0 || models.length === 0 ? (
          <p className="muted">该区间暂无数据</p>
        ) : (
          <div className="chart-wrap">
            <ResponsiveContainer width="100%" height={380}>
              <BarChart data={modelData} margin={{ top: 8, right: 12, bottom: 0, left: 0 }} barCategoryGap="18%">
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
                  width={52}
                  tickFormatter={(v: number) => formatTokens(v)}
                />
                <ReTooltip
                  cursor={{ fill: 'rgba(255,255,255,0.04)' }}
                  formatter={(value) => (value == null ? '—' : formatTokens(Number(value)))}
                  contentStyle={{
                    background: '#1c2027',
                    border: '1px solid rgba(255,255,255,0.1)',
                    borderRadius: 8,
                    boxShadow: '0 8px 24px rgba(0,0,0,0.45)',
                    fontSize: 13
                  }}
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
                      />
                    )
                  })}
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </section>
    </div>
  )
}
