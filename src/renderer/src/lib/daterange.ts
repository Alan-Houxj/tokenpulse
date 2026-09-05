/** 全局日期范围：快捷档 + 双日历自定义（本地时区） */

export interface DateRange {
  from: number
  to: number
  preset: PresetId | 'custom'
  label: string
}

export type PresetId = 'today' | '3d' | '7d' | '30d'

/** 快捷档（含今天） */
export const PRESETS: { id: PresetId; label: string; days: number }[] = [
  { id: 'today', label: '今日', days: 1 },
  { id: '3d', label: '近三天', days: 3 },
  { id: '7d', label: '近一周', days: 7 },
  { id: '30d', label: '近一月', days: 30 }
]

function midnight(d = new Date()): number {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  return x.getTime()
}

const DAY = 86_400_000

export function rangeFromPreset(preset: PresetId, now = new Date()): DateRange {
  const cfg = PRESETS.find((p) => p.id === preset)!
  const today0 = midnight(now)
  return {
    from: today0 - (cfg.days - 1) * DAY,
    to: today0 + DAY,
    preset,
    label: cfg.label
  }
}

/** 自定义：yyyy-MM-dd 字符串（本地时区）→ 区间（to 为次日零点，含结束日全天） */
export function customRange(fromDay: string, toDay: string): DateRange {
  const from = new Date(`${fromDay}T00:00:00`).getTime()
  const to = new Date(`${toDay}T00:00:00`).getTime() + DAY
  return {
    from: Number.isNaN(from) ? 0 : from,
    to: Number.isNaN(to) ? DAY : to,
    preset: 'custom',
    label: fromDay === toDay ? fromDay : `${fromDay} ~ ${toDay}`
  }
}

export function todayMidnight(now = new Date()): number {
  return midnight(now)
}

export function dayInputValue(ts: number): string {
  const d = new Date(ts)
  const pad = (x: number) => `${x}`.padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 趋势分桶：跨度 ≤ 72h 用小时桶，否则用天 */
export function bucketForRange(range: DateRange): 'hour' | 'day' {
  return range.to - range.from <= 72 * 3_600_000 ? 'hour' : 'day'
}
