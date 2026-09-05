import { useEffect, useRef, useState } from 'react'

export interface DropdownOption<T extends string> {
  value: T
  label: string
  /** 分组标题；相同分组的选项排在一起，组间显示小标题 */
  group?: string
}

/**
 * 自绘下拉（替代原生 select：原生弹出菜单是系统绘制的，样式无法定制）。
 * 触发按钮 + 卡片弹层，支持分组、选中态、键盘 ↑↓ Enter、点外部关闭。
 */
export default function Dropdown<T extends string>(props: {
  value: T
  options: DropdownOption<T>[]
  onChange: (v: T) => void
  width?: number
  placeholder?: string
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [activeIdx, setActiveIdx] = useState(-1)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDocClick = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
      else if (e.key === 'ArrowDown') {
        e.preventDefault()
        setActiveIdx((i) => Math.min(i + 1, props.options.length - 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setActiveIdx((i) => Math.max(i - 1, 0))
      } else if (e.key === 'Enter' && activeIdx >= 0) {
        e.preventDefault()
        props.onChange(props.options[activeIdx]!.value)
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, activeIdx, props])

  const selected = props.options.find((o) => o.value === props.value)
  const label = selected?.label ?? props.placeholder ?? '—'

  // 弹层按分组组织
  const groups: { title?: string; items: DropdownOption<T>[] }[] = []
  for (const opt of props.options) {
    const last = groups[groups.length - 1]
    if (last && last.title === opt.group) last.items.push(opt)
    else groups.push({ title: opt.group, items: [opt] })
  }

  return (
    <div className={`dropdown ${open ? 'open' : ''}`} ref={rootRef} style={props.width ? { width: props.width } : undefined}>
      <button
        type="button"
        className="dropdown-trigger"
        onClick={() => {
          setOpen((o) => !o)
          setActiveIdx(props.options.findIndex((o) => o.value === props.value))
        }}
      >
        <span className="dropdown-value" title={label}>
          {label}
        </span>
        <svg
          className={`dropdown-chevron ${open ? 'up' : ''}`}
          width="10"
          height="6"
          viewBox="0 0 10 6"
          aria-hidden
        >
          <path
            d="M1 1l4 4 4-4"
            stroke="currentColor"
            strokeWidth="1.4"
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      {open && (
        <div className="dropdown-menu" role="listbox">
          {groups.map((g, gi) => (
            <div key={gi} className="dropdown-group">
              {g.title && <div className="dropdown-group-title">{g.title}</div>}
              {g.items.map((opt) => {
                const idx = props.options.indexOf(opt)
                const isSelected = opt.value === props.value
                const isActive = idx === activeIdx
                return (
                  <button
                    key={opt.value}
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    className={`dropdown-item ${isSelected ? 'selected' : ''} ${isActive ? 'active' : ''}`}
                    onMouseEnter={() => setActiveIdx(idx)}
                    onClick={() => {
                      props.onChange(opt.value)
                      setOpen(false)
                    }}
                  >
                    <span className="dropdown-item-check">{isSelected ? '✓' : ''}</span>
                    <span className="dropdown-item-label" title={opt.label}>
                      {opt.label}
                    </span>
                  </button>
                )
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
