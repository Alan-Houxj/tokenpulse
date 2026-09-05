import { useEffect, useState } from 'react'
import type { OverviewSummary } from '@core/model/types'
import type { DateRange } from '../lib/daterange'
import { formatTokens, formatUSD } from '../lib/format'

/** 总览：跟随日期范围的汇总 + Agent/模型分布 */
export default function Overview(props: {
  range: DateRange
  tickVersion: number
}): React.JSX.Element {
  const [summary, setSummary] = useState<OverviewSummary | null>(null)

  useEffect(() => {
    void window.api.getOverview(props.range.from, props.range.to).then(setSummary)
  }, [props.range, props.tickVersion])

  const maxAgentTotal = Math.max(1, ...(summary?.byAgent.map((a) => a.totals.total) ?? [1]))

  return (
    <div className="page">
      <div className="stat-cards">
        <div className="stat-card highlight">
          <div className="stat-title">{props.range.label} 消耗</div>
          <div className="stat-value">{summary ? formatTokens(summary.totals.total) : '…'}</div>
          <div className="stat-sub" title="按价格表估算的 API 等价成本，非订阅账单">
            tokens · ≈{summary ? formatUSD(summary.totals.costEstUSD) : '…'}（API 等价估算）
          </div>
          {summary && (
            <div className="stat-breakdown muted small">
              in {formatTokens(summary.totals.input)} / out {formatTokens(summary.totals.output)} /
              cache {formatTokens(summary.totals.cacheRead + summary.totals.cacheWrite)}
            </div>
          )}
          {summary && summary.totals.eventCount > 0 && (
            <div className="stat-breakdown muted small">
              {summary.totals.eventCount} 次模型请求
            </div>
          )}
        </div>
      </div>

      <section className="panel">
        <h3>按 Agent 分布（{props.range.label}）</h3>
        {summary && summary.byAgent.length > 0 ? (
          <div className="agent-bars">
            {summary.byAgent.map((a) => (
              <div key={a.agent} className="agent-bar-row">
                <span className="agent-name">{a.displayName}</span>
                <div className="agent-bar-track">
                  <div
                    className="agent-bar-fill"
                    style={{ width: `${(a.totals.total / maxAgentTotal) * 100}%` }}
                  />
                </div>
                <span className="agent-val">
                  {formatTokens(a.totals.total)} · {formatUSD(a.totals.costEstUSD)}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <p className="muted">该区间暂无数据。切换日期范围，或启动对应的 Agent 开始工作（约 5 秒内出现）。</p>
        )}
      </section>

      <section className="panel">
        <h3>按模型（{props.range.label}）</h3>
        {summary && summary.byModel.length > 0 ? (
          <table className="data-table">
            <thead>
              <tr>
                <th>模型</th>
                <th className="num">请求</th>
                <th className="num">输入</th>
                <th className="num">输出</th>
                <th className="num">缓存读</th>
                <th className="num">缓存写</th>
                <th className="num">合计</th>
                <th className="num">≈成本</th>
              </tr>
            </thead>
            <tbody>
              {summary.byModel.map((m) => (
                <tr key={m.model}>
                  <td className="mono text">{m.model}</td>
                  <td className="num">{m.totals.eventCount}</td>
                  <td className="num">{formatTokens(m.totals.input)}</td>
                  <td className="num">{formatTokens(m.totals.output)}</td>
                  <td className="num">{formatTokens(m.totals.cacheRead)}</td>
                  <td className="num">{formatTokens(m.totals.cacheWrite)}</td>
                  <td className="num">{formatTokens(m.totals.total)}</td>
                  <td className="num cost-cell">{formatUSD(m.totals.costEstUSD)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="muted">暂无数据</p>
        )}
        {summary && summary.unpricedModels.length > 0 && (
          <p className="warn small">
            以下模型缺价格表（成本按 0 计）：
            {summary.unpricedModels.map((m) => ` ${m}`)}。可在「设置」页补充价格。
          </p>
        )}
      </section>
    </div>
  )
}
