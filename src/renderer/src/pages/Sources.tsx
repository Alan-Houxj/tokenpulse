import { useEffect, useState } from 'react'
import { Info, LoaderCircle } from 'lucide-react'
import type { AgentId, ProbeResult } from '@core/model/types'
import Dropdown, { type DropdownOption } from '../components/Dropdown'
import { formatBytes, formatTs } from '../lib/format'

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

const INTERVAL_OPTIONS: DropdownOption<string>[] = [
  { value: '2000', label: '2 秒 · 更实时' },
  { value: '5000', label: '5 秒 · 推荐' },
  { value: '15000', label: '15 秒 · 更省' },
  { value: '60000', label: '60 秒 · 最省' }
]

/** 数据源面板（设置页二级 tab）：四态探测 + 重新扫描（动效）+ 自定义路径即时校验 + 采集 + 数据目录与引导 */
export function SourcesPanel(props: { onReplayOnboarding: () => void }): React.JSX.Element {
  const [probes, setProbes] = useState<ProbeResult[] | null>(null)
  const [scanning, setScanning] = useState(false)
  const [scanDoneAt, setScanDoneAt] = useState(0)
  const [interval, setIntervalMs] = useState(5000)
  const [intervalSaved, setIntervalSaved] = useState(false)
  const [customAgent, setCustomAgent] = useState<AgentId>('claude-code')
  const [customPath, setCustomPath] = useState('')
  const [validateResult, setValidateResult] = useState<ProbeResult | null>(null)
  const [validating, setValidating] = useState(false)
  const [savedHint, setSavedHint] = useState('')

  const rescan = (): void => {
    setScanning(true)
    setScanDoneAt(0)
    const startedAt = Date.now()
    void window.api.probeAll().then((p) => {
      // 扫描太快时动效一闪而过没有感知，保底 700ms 可见时长
      const wait = Math.max(0, 700 - (Date.now() - startedAt))
      setTimeout(
        () => {
          setProbes(p)
          setScanning(false)
          setScanDoneAt(Date.now())
          setTimeout(() => setScanDoneAt(0), 2500)
        },
        wait
      )
    })
  }

  useEffect(rescan, [])

  useEffect(() => {
    void window.api.getConfig().then((c) => setIntervalMs(c.pollIntervalMs))
  }, [])

  // 轮询间隔即时保存（面板里唯一的常规设置，不需要保存栏）
  const changeInterval = (v: number): void => {
    setIntervalMs(v)
    void window.api.setConfig({ pollIntervalMs: v }).then(() => {
      setIntervalSaved(true)
      setTimeout(() => setIntervalSaved(false), 2000)
    })
  }

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

  const okCount = probes?.filter((p) => p.status === 'ok').length ?? 0

  return (
    <>
      <header className="page-head">
        <button onClick={rescan} disabled={scanning} className={scanning ? 'scanning' : ''}>
          {scanning ? (
            <>
              <LoaderCircle className="spin" size={13} aria-hidden /> 扫描中…
            </>
          ) : scanDoneAt ? (
            `扫描完成 · ${okCount} 个源正常`
          ) : (
            '重新扫描'
          )}
        </button>
      </header>

      <section className="panel">
        {probes === null && scanning && <p className="muted">正在探测数据目录…</p>}
        {probes?.map((p) => (
          <div key={p.agent} className={`source-row${scanning ? ' rescanning' : ''}`}>
            <div className="source-title">
              <strong>{p.displayName}</strong>
              <span className={`probe-tag ${p.status}`}>{STATUS_LABEL[p.status]}</span>
            </div>
            <div className="muted small mono">{p.root}</div>
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
        <h3>
          <span className="h3-with-info">自定义数据路径（即时校验）</span>
          <span className="live-help" tabIndex={0}>
            <Info className="live-help-icon" size={16} strokeWidth={2} aria-hidden />
            <span className="live-help-tip">
              这里修改的是已支持 Agent 的数据目录位置（便携版、自定义安装路径等场景），不是新增 Agent
              类型——支持的 Agent 列表由应用内置决定。
            </span>
          </span>
        </h3>
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

      <section className="panel">
        <h3>采集</h3>
        <div className="form-row">
          <label>轮询间隔</label>
          <Dropdown
            width={150}
            value={String(interval)}
            options={INTERVAL_OPTIONS}
            onChange={(v) => changeInterval(Number(v))}
          />
          {intervalSaved && <span className="ok-text small">已保存</span>}
        </div>
        <p className="muted small">
          轮询只对数据文件做属性比对，内容未变时零读取，任何档位的 CPU 开销都可忽略。
        </p>
      </section>

      <section className="panel">
        <h3>数据目录与引导</h3>
        <div className="form-row">
          <label>应用数据目录</label>
          <span className="mono small muted">%APPDATA%\TokenPulse</span>
          <button
            className="small-btn"
            onClick={() => {
              void window.api.getUserDataDir().then((d) => window.api.openPath(d))
            }}
          >
            打开
          </button>
        </div>
        <div className="form-row">
          <label>首启引导</label>
          <button className="small-btn" onClick={props.onReplayOnboarding}>
            重看引导
          </button>
        </div>
      </section>
    </>
  )
}
