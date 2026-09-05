/** 展示层格式化工具（renderer 专用） */

export function formatTokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`
  return `${n}`
}

export function formatUSD(n: number): string {
  if (n === 0) return '$0'
  if (n < 0.01) return `$${n.toFixed(4)}`
  if (n < 1) return `$${n.toFixed(3)}`
  if (n < 1000) return `$${n.toFixed(2)}`
  return `$${(n / 1000).toFixed(2)}k`
}

export function formatTs(ts: number | undefined): string {
  if (!ts) return '—'
  const d = new Date(ts)
  const pad = (x: number) => `${x}`.padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function formatBytes(n: number | undefined): string {
  if (n == null) return '—'
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}GB`
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}MB`
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}KB`
  return `${n}B`
}
