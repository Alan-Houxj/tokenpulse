import type { DateRange } from '../lib/daterange'
import DateRangePicker from './DateRangePicker'

/**
 * 顶栏（48px，透明背景）：品牌区（点击回总览）| 竖线 | 日期选择器（范围页面时显示）
 * 其余空间为拖拽区；右侧窗口控制。底部 1px 分割线贯穿内容区顶部。
 */
export default function TitleBar(props: {
  showRangePicker: boolean
  range: DateRange
  onRangeChange: (r: DateRange) => void
  onBrandClick: () => void
}): React.JSX.Element {
  return (
    <div className="titlebar">
      <button type="button" className="titlebar-brand" onClick={props.onBrandClick} title="回到总览">
        <svg className="titlebar-pulse" width="20" height="20" viewBox="0 0 20 20" aria-hidden>
          <path
            d="M1 10.5h3.2l2-6.2 3.2 12 2.4-8 1.6 3.4h5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        <span className="titlebar-brand-name">TokenPulse</span>
      </button>
      <span className="titlebar-divider" aria-hidden />
      {props.showRangePicker && (
        <DateRangePicker range={props.range} onChange={props.onRangeChange} />
      )}
      <div className="titlebar-drag" />
      <div className="titlebar-controls">
        <button
          className="titlebar-btn"
          title="最小化"
          onClick={() => window.api.minimizeWindow()}
          aria-label="最小化"
        >
          <svg width="10" height="10" viewBox="0 0 10 10">
            <rect x="1" y="4.5" width="8" height="1" rx="0.5" fill="currentColor" />
          </svg>
        </button>
        <button
          className="titlebar-btn titlebar-close"
          title="最小化到托盘（继续监控）"
          onClick={() => window.api.hideWindow()}
          aria-label="最小化到托盘"
        >
          <svg width="10" height="10" viewBox="0 0 10 10">
            <path
              d="M1.5 1.5 L8.5 8.5 M8.5 1.5 L1.5 8.5"
              stroke="currentColor"
              strokeWidth="1.2"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </div>
    </div>
  )
}
