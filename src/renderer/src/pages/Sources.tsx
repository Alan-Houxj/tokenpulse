import { useEffect, useState } from 'react'
import type { AgentId, ProbeResult } from '@core/model/types'
import { displayPath, formatBytes, formatTs } from '../lib/format'

const AGENTS: { id: AgentId; label: string }[] = [
  { id: 'claude-code', label: 'Claude Code' },
  { id: 'codex', label: 'Codex' },
  { id: 'gemini-cli', label: 'Gemini CLI' },
  { id: 'qwen', label: 'Qwen Code' },
  { id: 'zcode', label: 'ZCode' }
]

const STATUS_LABEL: Record<ProbeResult['status'], string> = {
  ok: '正常',
  absent: '未安装',
  empty: '为空',
  unrecognized: '格式不识别'
}

/** 数据源页：四态探测 + 重新扫描 + 自定义路径即时校验 */
export default function Sources(): React.JSX.Element {
  const [probes, setProbes] = useState<ProbeResult[] | null>(null)
  const [scanning, setScanning] = useState(false)
  const [customAgent, setCustomAgent] = useState<AgentId>('claude-code')
  const [customPath, setCustomPath] = useState('')
  const [validateResult, setValidateResult] = useState<ProbeResult | null>(null)
  const [validating, setValidating] = useState(false)
  const [savedHint, setSavedHint] = useState('')

  const rescan = (): void => {
    setScanning(true)
    void window.api.probeAll().then((p) => {
      setProbes(p)
      setScanning(false)
    })
  }

  useEffect(rescan, [])

  const validate = (): void => {
    if (!customPath.trim()) return
    setValidating(true)
    setValidateResult(null)
    void window.api.validateRoot(customAgent, customPath.trim()).then((r) => {
      setValidateResult(r)
      setValidating(false)
    })
  }

  const saveRoot = (): void => {
    void window.api.getConfig().then((c) => {
      const roots = { ...c.roots }
      const existing = roots[customAgent] ?? []
      if (!existing.includes(customPath.trim())) {
        roots[customAgent] = [...existing, customPath.trim()]
      }
      void window.api.setConfig({ roots }).then(() => {
        setSavedHint(`已保存到配置（重启应用后生效扫描 ${customPath.trim()}）`)
        rescan()
      })
    })
  }

  return (
    <div className="page">
      <header className="page-head">
        <button onClick={rescan} disabled={scanning}>
          {scanning ? '扫描中…' : '重新扫描'}
        </button>
      </header>

      <section className="panel">
        {probes === null && <p className="muted">扫描中…</p>}
        {probes?.map((p) => (
          <div key={p.agent} className="source-row">
            <div className="source-title">
              <strong>{p.displayName}</strong>
              <span className={`probe-tag ${p.status}`}>
                {STATUS_LABEL[p.status]}
              </span>
            </div>
            <div className="muted small mono">{displayPath(p.root)}</div>
            {p.status === 'ok' && (
              <div className="muted small">
                {p.fileCount} 个数据文件 · {formatBytes(p.sizeBytes)}
                {p.earliest != null && <> · 数据范围 {formatTs(p.earliest)} → {formatTs(p.latest)}</>}
                {p.detail && <> · {p.detail}</>}
              </div>
            )}
            {p.status !== 'ok' && p.detail && <div className="muted small">{p.detail}</div>}
          </div>
        ))}
      </section>

      <section className="panel">
        <h3>自定义数据路径（即时校验）</h3>
        <p className="muted small">
          数据不在默认位置（便携版 Agent、自定义 HOME 等）时在这里补充。校验通过后保存，重启应用生效。
        </p>
        <div className="custom-root-form">
          <select value={customAgent} onChange={(e) => setCustomAgent(e.target.value as AgentId)}>
            {AGENTS.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
              </option>
            ))}
          </select>
          <input
            type="text"
            placeholder="例如 D:\\PortableClaude\\.claude"
            value={customPath}
            onChange={(e) => {
              setCustomPath(e.target.value)
              setValidateResult(null)
              setSavedHint('')
            }}
            onKeyDown={(e) => e.key === 'Enter' && validate()}
          />
          <button onClick={validate} disabled={validating || !customPath.trim()}>
            {validating ? '校验中…' : '校验'}
          </button>
        </div>
        {validateResult && (
          <div className={`validate-result ${validateResult.status}`}>
            {validateResult.status === 'ok'
              ? `✓ 有效：发现 ${validateResult.fileCount} 个数据文件（${formatBytes(validateResult.sizeBytes)}）`
              : validateResult.status === 'empty'
                ? '⚠ 目录有效但暂无数据文件'
                : `✗ ${validateResult.detail ?? '未识别出记录文件'}`}
            {validateResult.status === 'ok' && (
              <button className="small-btn" onClick={saveRoot}>
                保存到配置
              </button>
            )}
          </div>
        )}
        {savedHint && <div className="ok-text small">{savedHint}</div>}
      </section>
    </div>
  )
}
