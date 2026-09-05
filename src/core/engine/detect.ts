/**
 * 数据源四态探测（开箱即用的可见性核心）：
 * ok         目录存在且能解析出用量事件（附统计摘要）
 * absent     默认目录不存在（未安装该 Agent）
 * empty      目录存在但没有数据文件（装了没用过）
 * unrecognized 文件存在但解析不出任何事件（Agent 改了格式 → 引导提 issue）
 */
import type { ProbeResult, SourceAdapter } from '../model/types'
import { existsSync } from 'node:fs'
import { statSync } from 'node:fs'

export async function probeAdapter(adapter: SourceAdapter): Promise<ProbeResult> {
  const roots = adapter.defaultRoots()
  const existingRoot = roots.find((r) => {
    try {
      return existsSync(r)
    } catch {
      return false
    }
  })

  const base: Omit<ProbeResult, 'status'> = {
    agent: adapter.id,
    displayName: adapter.displayName,
    root: existingRoot ?? roots[0]!
  }

  if (!existingRoot) {
    return { ...base, status: 'absent', detail: `未找到数据目录 ${roots[0]}` }
  }

  let files
  try {
    files = adapter.discover()
  } catch (e) {
    return { ...base, status: 'unrecognized', detail: `扫描失败: ${String(e)}` }
  }

  if (files.length === 0) {
    return { ...base, status: 'empty', detail: '数据目录为空（尚未产生用量）' }
  }

  const sizeBytes = files.reduce((s, f) => s + f.size, 0)

  // 抽样验证：读最新的 3 个文件的尾部，能解析出事件即 ok
  const sample = [...files].sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, 3)
  let sawEvent = false
  const sessions = new Set<string>()
  let earliest: number | undefined
  let latest: number | undefined
  let lastError: string | undefined

  for (const f of sample) {
    try {
      // 从文件尾 256KB 抽样（足够覆盖最近事件，避免全文件解析）
      const from = Math.max(0, f.size - 256 * 1024)
      const { events } = await adapter.readIncremental(f, from)
      if (events.length > 0) sawEvent = true
      for (const e of events) {
        sessions.add(`${e.agent}/${e.sessionId}`)
        if (e.ts > 0) {
          earliest = Math.min(earliest ?? Infinity, e.ts)
          latest = Math.max(latest ?? -Infinity, e.ts)
        }
      }
    } catch (e) {
      lastError = String(e)
    }
  }

  if (!sawEvent) {
    return {
      ...base,
      status: 'unrecognized',
      fileCount: files.length,
      sizeBytes,
      detail: lastError ?? `发现 ${files.length} 个数据文件但无法解析（格式可能已变更，欢迎提 issue）`
    }
  }

  return {
    ...base,
    status: 'ok',
    fileCount: files.length,
    sizeBytes,
    // 抽样口径下的会话数（下界），完整值以回填后的仪表盘为准
    sessionCount: sessions.size,
    earliest: earliest === Infinity ? undefined : earliest,
    latest: latest === -Infinity ? undefined : latest,
    detail: `抽样自最新 ${sample.length} 个文件`
  }
}

export async function probeAll(adapters: SourceAdapter[]): Promise<ProbeResult[]> {
  const results: ProbeResult[] = []
  for (const a of adapters) {
    results.push(await probeAdapter(a))
  }
  return results
}

/** 探测也用于设置页"自定义路径即时校验"：给定路径 + 适配器工厂探测一次 */
export async function probeRoot(
  createAdapter: (root: string) => SourceAdapter,
  root: string
): Promise<ProbeResult> {
  let st: { isDirectory(): boolean } | undefined
  try {
    st = statSync(root)
  } catch {
    st = undefined
  }
  if (!st?.isDirectory()) {
    return {
      agent: createAdapter(root).id,
      displayName: createAdapter(root).displayName,
      root,
      status: 'absent',
      detail: '路径不存在或不是目录'
    }
  }
  return probeAdapter(createAdapter(root))
}
