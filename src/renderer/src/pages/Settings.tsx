import { useEffect, useMemo, useState } from 'react'
import type { AgentMeterConfig } from '@core/config'
import Dropdown, { type DropdownOption } from '../components/Dropdown'

interface PriceRow {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

type PriceTable = Record<string, PriceRow>

const FIELDS: { key: keyof PriceRow; label: string }[] = [
  { key: 'input', label: '输入' },
  { key: 'output', label: '输出' },
  { key: 'cacheRead', label: '缓存读' },
  { key: 'cacheWrite', label: '缓存写' }
]

const INTERVAL_OPTIONS: DropdownOption<string>[] = [
  { value: '2000', label: '2 秒 · 更实时' },
  { value: '5000', label: '5 秒 · 推荐' },
  { value: '15000', label: '15 秒 · 更省' },
  { value: '60000', label: '60 秒 · 最省' }
]

/** 设置页：轮询间隔 + 价格表（内置可覆盖 + 自定义新建）+ 数据目录 */
export default function Settings(props: { onReplayOnboarding: () => void }): React.JSX.Element {
  const [config, setConfig] = useState<AgentMeterConfig | null>(null)
  const [builtin, setBuiltin] = useState<PriceTable>({})
  const [interval, setIntervalMs] = useState(5000)
  const [overrides, setOverrides] = useState<Record<string, PriceRow | null>>({})
  const [saved, setSaved] = useState('')
  // 新建自定义档的表单状态
  const [newName, setNewName] = useState('')
  const [newPrice, setNewPrice] = useState<PriceRow>({ input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 })

  useEffect(() => {
    void window.api.getConfig().then((c) => {
      setConfig(c)
      setIntervalMs(c.pollIntervalMs)
      setOverrides(c.priceOverrides ?? {})
    })
    void window.api.getBuiltinPrices().then(setBuiltin)
  }, [])

  /** 自定义档 = 覆盖表中非 null 且不属于内置的键 */
  const customKeys = useMemo(
    () =>
      Object.entries(overrides)
        .filter(([k, v]) => v !== null && !(k in builtin))
        .map(([k]) => k)
        .sort(),
    [overrides, builtin]
  )

  const save = (): void => {
    const cleaned: Record<string, PriceRow | null> = {}
    for (const [k, v] of Object.entries(overrides)) {
      if (v === null) {
        cleaned[k] = null // 停用的内置档
        continue
      }
      const b = builtin[k]
      const isUnchangedBuiltin =
        b != null &&
        b.input === v.input && b.output === v.output && b.cacheRead === v.cacheRead && b.cacheWrite === v.cacheWrite
      if (!isUnchangedBuiltin) cleaned[k] = v
    }
    void window.api.setConfig({ pollIntervalMs: interval, priceOverrides: cleaned }).then((c) => {
      setConfig(c)
      setOverrides(c.priceOverrides ?? {})
      setSaved('已保存（价格对全部历史立即重算生效）')
      setTimeout(() => setSaved(''), 4000)
    })
  }

  const addCustom = (): void => {
    const key = newName.trim().toLowerCase()
    if (!key || key in builtin) return
    setOverrides((o) => ({ ...o, [key]: { ...newPrice } }))
    setNewName('')
  }

  return (
    <div className="page">
      <section className="panel">
        <h3>采集</h3>
        <div className="form-row">
          <label>轮询间隔</label>
          <Dropdown
            width={150}
            value={String(interval)}
            options={INTERVAL_OPTIONS}
            onChange={(v) => setIntervalMs(Number(v))}
          />
        </div>
        <p className="muted small">
          轮询只对数据文件做属性比对，内容未变时零读取，任何档位的 CPU 开销都可忽略。
        </p>
      </section>

      <section className="panel">
        <h3>自定义模型价格（USD / 1M tokens）</h3>
        <p className="muted small">
          新建价格档位：模型名 + 四类单价。命中规则：采集到的模型名去日期后缀并转小写后与此处一致即命中
          （如 kimi-k2-20260905 → kimi-k2）。例如 kimi-k2、deepseek-v4。
        </p>
        <div className="custom-model-form">
          <input
            type="text"
            placeholder="模型名，如 kimi-k2"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addCustom()}
          />
          {FIELDS.map((f) => (
            <input
              key={f.key}
              className="price-input wide"
              type="number"
              step="0.01"
              min="0"
              title={f.label}
              placeholder={f.label}
              value={newPrice[f.key]}
              onChange={(e) => setNewPrice((p) => ({ ...p, [f.key]: Number(e.target.value) }))}
            />
          ))}
          <button onClick={addCustom} disabled={!newName.trim()}>
            添加
          </button>
        </div>
        {customKeys.length > 0 && (
          <table className="data-table compact">
            <thead>
              <tr>
                <th>模型档位</th>
                <th>输入</th>
                <th>输出</th>
                <th>缓存读</th>
                <th>缓存写</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {customKeys.map((k) => (
                <tr key={k} className="overridden">
                  <td className="mono">{k}</td>
                  {FIELDS.map((f) => (
                    <td key={f.key}>
                      <input
                        className="price-input"
                        type="number"
                        step="0.01"
                        min="0"
                        value={overrides[k]![f.key]}
                        onChange={(e) =>
                          setOverrides((o) => ({ ...o, [k]: { ...o[k]!, [f.key]: Number(e.target.value) } }))
                        }
                      />
                    </td>
                  ))}
                  <td>
                    <button
                      className="small-btn danger"
                      title="删除该档位"
                      onClick={() => {
                        setOverrides((o) => {
                          const n = { ...o }
                          delete n[k]
                          return n
                        })
                      }}
                    >
                      删除
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="panel">
        <h3>内置价格表（USD / 1M tokens，可修改 / 停用）</h3>
        <p className="muted small">
          修改后保存即为覆盖；停用后该档模型按"缺价"处理（成本记 0 并在总览提示）。订阅制用户看到的成本是「API 等价估算」，不是账单。
        </p>
        <table className="data-table compact">
          <thead>
            <tr>
              <th>模型档位</th>
              <th>输入</th>
              <th>输出</th>
              <th>缓存读</th>
              <th>缓存写</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {Object.keys(builtin)
              .sort()
              .map((m) => {
                const o = overrides[m]
                const isDisabled = o === null
                const isOverride = o != null && o !== null
                const row = (isOverride ? (o as PriceRow) : builtin[m]!) as PriceRow
                return (
                  <tr key={m} className={isDisabled ? 'row-disabled' : isOverride ? 'overridden' : ''}>
                    <td className="mono">{m}</td>
                    {FIELDS.map((f) => (
                      <td key={f.key}>
                        <input
                          className="price-input"
                          type="number"
                          step="0.01"
                          min="0"
                          disabled={isDisabled}
                          value={row[f.key]}
                          onChange={(e) => {
                            const v = Number(e.target.value)
                            setOverrides((ov) => ({ ...ov, [m]: { ...((ov[m] as PriceRow) ?? builtin[m]!), [f.key]: v } }))
                          }}
                        />
                      </td>
                    ))}
                    <td>
                      {isDisabled ? (
                        <button
                          className="small-btn"
                          title="恢复该档位"
                          onClick={() => {
                            setOverrides((ov) => {
                              const n = { ...ov }
                              delete n[m]
                              return n
                            })
                          }}
                        >
                          恢复
                        </button>
                      ) : (
                        <button
                          className="small-btn danger"
                          title="停用该档位（模型将按缺价处理）"
                          onClick={() => {
                            setOverrides((ov) => ({ ...ov, [m]: null }))
                          }}
                        >
                          停用
                        </button>
                      )}
                    </td>
                  </tr>
                )
              })}
          </tbody>
        </table>
      </section>

      <section className="panel">
        <h3>数据与引导</h3>
        <div className="form-row">
          <label>应用数据目录</label>
          <span className="mono small muted">{config ? '点击打开 %APPDATA%\\AgentMeter' : '…'}</span>
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

      <div className="save-bar">
        {saved && <span className="ok-text small">{saved}</span>}
        <button className="primary" onClick={save}>
          保存设置
        </button>
      </div>
    </div>
  )
}
