import { useEffect, useState } from 'react'
import type { ProbeResult } from '@core/model/types'
import { formatBytes, formatTs } from '../lib/format'

const STATUS_META: Record<
  ProbeResult['status'],
  { icon: string; label: string; cls: string }
> = {
  ok: { icon: '✓', label: '已检测到', cls: 'ok' },
  absent: { icon: '✗', label: '未安装', cls: 'muted' },
  empty: { icon: '⚠', label: '目录为空', cls: 'warn' },
  unrecognized: { icon: '✗', label: '格式不识别', cls: 'err' }
}

/** 首启引导：逐源展示探测结果（开箱即用的"确认感"环节） */
export default function Onboarding(props: { onDone: () => void }): React.JSX.Element {
  const [probes, setProbes] = useState<ProbeResult[] | null>(null)

  useEffect(() => {
    void window.api.probeAll().then(setProbes)
  }, [])

  const detected = probes?.filter((p) => p.status === 'ok') ?? []
  const hasAny = detected.length > 0

  return (
    <div className="overlay">
      <div className="onboarding">
        <h1>
          <span className="brand-dot" aria-hidden /> AgentMeter
        </h1>
        <p className="subtitle">本地 · 零配置 · 多 Agent token 监控</p>

        <div className="probe-list">
          {probes === null && <p className="muted">正在探测数据源…</p>}
          {probes?.map((p) => {
            const meta = STATUS_META[p.status]
            return (
              <div key={p.agent} className={`probe-row ${meta.cls}`}>
                <span className={`probe-status ${meta.cls}`} aria-hidden>
                  {meta.icon}
                </span>
                <div className="probe-main">
                  <div className="probe-title">
                    {p.displayName} <span className={`probe-tag ${meta.cls}`}>{meta.label}</span>
                  </div>
                  <div className="probe-detail muted">
                    {p.root}
                    {p.status === 'ok' && (
                      <>
                        {' '}· {p.fileCount} 个文件 · {formatBytes(p.sizeBytes)}
                        {p.latest != null && <> · 最近活动 {formatTs(p.latest)}</>}
                      </>
                    )}
                    {p.status !== 'ok' && p.detail && <> · {p.detail}</>}
                  </div>
                </div>
              </div>
            )
          })}
        </div>

        {probes != null && !hasAny && (
          <div className="onboarding-empty">
            <p>未检测到任何支持的 Agent。安装任一支持的 Agent 后重开本应用即可自动识别：</p>
            <p className="muted small">
              Claude Code · Codex CLI · Gemini CLI · Qwen Code · ZCode
              <br />
              也可以到「数据源」页手动指定已有数据的目录。
            </p>
          </div>
        )}

        <div className="onboarding-actions">
          <button className="primary" disabled={probes === null} onClick={() => {
            void window.api.completeOnboarding()
            props.onDone()
          }}>
            {hasAny ? `进入仪表盘（后台回填 ${detected.length} 个数据源的历史）` : '进入仪表盘'}
          </button>
          <span className="muted small">
            {hasAny ? '历史数据回填在后台进行，无需等待' : '随时可在「数据源」页重新扫描'}
          </span>
        </div>
      </div>
    </div>
  )
}
