import { useEffect, useState } from 'react'
import type { OverviewSummary, TokenTotals } from '@core/model/types'
import type { DateRange } from '../lib/daterange'
import { dayInputValue } from '../lib/daterange'
import { formatTokens, formatUSD } from '../lib/format'

/** 总览：Bento 指标卡（总消耗/模型请求/API 等价估算）+ Agent/模型分布表 */
export default function Overview(props: {
  range: DateRange
  tickVersion: number
}): React.JSX.Element {
  const [summary, setSummary] = useState<OverviewSummary | null>(null)

  useEffect(() => {
    void window.api.getOverview(props.range.from, props.range.to).then(setSummary)
  }, [props.range, props.tickVersion])

  // 表格标题日期：区间首日 ~ 末日（含），同日折叠为单日
  const firstDay = dayInputValue(props.range.from)
  const lastDay = dayInputValue(props.range.to - 1)
  const dateLabel = firstDay === lastDay ? firstDay : `${firstDay} ~ ${lastDay}`

  const totals = summary?.totals
  const barRows: { name: string; fill: string; value: number }[] = totals
    ? [
        { name: '输入', fill: 'fill-in', value: totals.input },
        { name: '输出', fill: 'fill-out', value: totals.output },
        { name: 'KV Cache', fill: 'fill-cache', value: totals.cacheRead + totals.cacheWrite }
      ]
    : []

  return (
    <div className="page overview">
      <div className="bento">
        <div className="bento-card bento-main">
          <div className="bento-label">总消耗</div>
          <div className="bento-value">
            <span className="bento-num">{totals ? formatTokens(totals.total) : '…'}</span>
            <span className="bento-unit">tokens</span>
          </div>
          {totals && (
            <div className="bento-bars">
              {barRows.map((row) => (
                <div key={row.name} className="bento-bar-row">
                  <span className="bento-bar-name">{row.name}</span>
                  <div className="bento-bar-track">
                    <div
                      className={`bento-bar-fill ${row.fill}`}
                      style={{ width: `${(row.value / Math.max(1, totals.total)) * 100}%` }}
                    />
                  </div>
                  <span className="bento-bar-val">{formatTokens(row.value)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="bento-card">
          <div className="bento-label">模型请求</div>
          <div className="bento-value">
            <span className="bento-num">{totals ? totals.eventCount.toLocaleString('en-US') : '…'}</span>
            <span className="bento-unit">次</span>
          </div>
        </div>
        <div className="bento-card">
          <div className="bento-label">API 等价估算</div>
          <div className="bento-value">
            <span className="bento-num">{totals ? formatUSD(totals.costEstUSD) : '…'}</span>
            <span className="bento-unit">USD</span>
          </div>
        </div>
      </div>

      <section className="panel">
        <h3>按 Agent 分布 ({dateLabel})</h3>
        {summary && summary.byAgent.length > 0 ? (
          <table className="data-table">
            <thead>
              <tr>
                <th>Agent</th>
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
              {summary.byAgent.map((a) => (
                <DistRow key={a.agent} name={a.displayName} totals={a.totals} nameCell="text" />
              ))}
            </tbody>
          </table>
        ) : (
          <p className="muted">该区间暂无数据。切换日期范围，或启动对应的 Agent 开始工作（约 5 秒内出现）。</p>
        )}
      </section>

      <section className="panel">
        <h3>按模型 ({dateLabel})</h3>
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
                <DistRow key={m.model} name={m.model} totals={m.totals} nameCell="mono text" />
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

/** Agent 表与模型表共用的分布行：列结构完全一致 */
function DistRow(props: { name: string; totals: TokenTotals; nameCell: string }): React.JSX.Element {
  const t = props.totals
  const num = (v: number, text: string) => (
    <td className={`num${v === 0 ? ' zero' : ''}`}>{text}</td>
  )
  return (
    <tr>
      <td className={props.nameCell}>{props.name}</td>
      {num(t.eventCount, t.eventCount.toLocaleString('en-US'))}
      {num(t.input, formatTokens(t.input))}
      {num(t.output, formatTokens(t.output))}
      {num(t.cacheRead, formatTokens(t.cacheRead))}
      {num(t.cacheWrite, formatTokens(t.cacheWrite))}
      {num(t.total, formatTokens(t.total))}
      <td className={`num cost-cell${t.costEstUSD === 0 ? ' zero' : ''}`}>
        {formatUSD(t.costEstUSD)}
      </td>
    </tr>
  )
}
