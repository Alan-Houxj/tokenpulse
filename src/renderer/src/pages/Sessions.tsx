import { useEffect, useState } from 'react'
import type { AgentId, SessionRow } from '@core/model/types'
import type { DateRange } from '../lib/daterange'
import { formatTokens, formatTs, formatUSD } from '../lib/format'
import Dropdown, { type DropdownOption } from '../components/Dropdown'

const AGENT_OPTIONS: DropdownOption<string>[] = [
  { value: '', label: '全部 Agent' },
  { value: 'claude-code', label: 'Claude Code' },
  { value: 'codex', label: 'Codex' },
  { value: 'gemini-cli', label: 'Gemini CLI' },
  { value: 'qwen', label: 'Qwen Code' },
  { value: 'zcode', label: 'ZCode' }
]

/** 会话明细：Agent / 模型筛选（日期在顶栏） */
export default function Sessions(props: {
  range: DateRange
  tickVersion: number
}): React.JSX.Element {
  const [rows, setRows] = useState<SessionRow[] | null>(null)
  const [offset, setOffset] = useState(0)
  const [models, setModels] = useState<string[]>([])
  const [agentFilter, setAgentFilter] = useState('')
  const [modelFilter, setModelFilter] = useState('')

  useEffect(() => {
    void window.api.getModels().then(setModels)
  }, [props.tickVersion])

  useEffect(() => {
    setOffset(0)
  }, [agentFilter, modelFilter, props.range])

  useEffect(() => {
    void window.api
      .getSessions(200, offset, { from: props.range.from, to: props.range.to }, {
        agent: agentFilter || undefined,
        model: modelFilter || undefined
      })
      .then(setRows)
  }, [props.range, props.tickVersion, offset, agentFilter, modelFilter])

  return (
    <div className="page">
      <header className="page-head">
        <Dropdown
          width={140}
          value={agentFilter}
          options={AGENT_OPTIONS}
          onChange={setAgentFilter}
        />
        <Dropdown
          width={170}
          value={modelFilter}
          placeholder="全部模型"
          options={[
            { value: '', label: '全部模型' },
            ...models.map((m) => ({ value: m, label: m }))
          ]}
          onChange={setModelFilter}
        />
        <div className="pager">
          <button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 200))}>
            上一页
          </button>
          <button
            disabled={rows != null && rows.length < 200}
            onClick={() => setOffset(offset + 200)}
          >
            下一页
          </button>
        </div>
      </header>

      <section className="panel">
        {rows === null ? (
          <p className="muted">加载中…</p>
        ) : rows.length === 0 ? (
          <p className="muted">当前筛选条件下暂无会话</p>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>Agent</th>
                <th>会话</th>
                <th>项目</th>
                <th>模型</th>
                <th>最近活动</th>
                <th className="num">Token 合计</th>
                <th className="num">≈成本</th>
                <th>构成 (in/out/cache)</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={`${r.agent}:${r.sessionId}`}>
                  <td className="text">{agentShort(r.agent)}</td>
                  <td className="mono small">{r.sessionId.slice(0, 12)}…</td>
                  <td className="small" title={r.projectPath}>
                    {r.projectPath ? lastSegment(r.projectPath) : '—'}
                  </td>
                  <td className="mono small">{r.models.join(', ')}</td>
                  <td className="small">{formatTs(r.lastTs)}</td>
                  <td className="num">{formatTokens(r.totals.total)}</td>
                  <td className="num cost-cell">{formatUSD(r.totals.costEstUSD)}</td>
                  <td className="small">
                    {formatTokens(r.totals.input)} / {formatTokens(r.totals.output)} /{' '}
                    {formatTokens(r.totals.cacheRead + r.totals.cacheWrite)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  )
}

function agentShort(agent: AgentId | string): string {
  const map: Record<string, string> = {
    'claude-code': 'Claude',
    codex: 'Codex',
    'gemini-cli': 'Gemini',
    qwen: 'Qwen',
    zcode: 'ZCode'
  }
  return map[agent] ?? agent
}

function lastSegment(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/').filter(Boolean)
  return parts[parts.length - 1] ?? path
}
