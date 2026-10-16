import { existsSync } from 'node:fs'
import type { ProbeResult, SourceAdapter } from '../model/types'

export interface RecordedUsageProbeOptions {
  coverage?: string
  emptyDetail?: string
  noUsageDetail?: string
  unavailableWithoutFiles?: boolean
}

export async function probeRecordedUsage(
  adapter: SourceAdapter,
  options: RecordedUsageProbeOptions = {}
): Promise<ProbeResult> {
  const roots = adapter.defaultRoots()
  const existing = roots.find((root) => existsSync(root))
  const base = { agent: adapter.id, displayName: adapter.displayName, root: existing ?? roots[0] ?? '' }
  if (!existing) return { ...base, status: 'absent', detail: '未检测到本地数据目录' }

  let files
  try {
    files = adapter.discover()
  } catch (error) {
    return { ...base, status: 'unrecognized', detail: `读取记录失败：${String(error)}` }
  }
  if (files.length === 0) {
    return {
      ...base,
      status: options.unavailableWithoutFiles ? 'unsupported' : 'empty',
      fileCount: 0,
      detail: options.emptyDetail ?? '尚未发现可读取的用量记录'
    }
  }

  const sample = [...files].sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, 5)
  const sessions = new Set<string>()
  let recognized = false
  let earliest: number | undefined
  let latest: number | undefined
  let failure: string | undefined
  for (const file of sample) {
    try {
      // Stateful and compressed logs must start at their own header/frame boundary.
      const result = await adapter.readIncremental(file, 0)
      recognized ||= result.recognized === true
      for (const event of result.events) {
        sessions.add(event.sessionId)
        earliest = Math.min(earliest ?? event.ts, event.ts)
        latest = Math.max(latest ?? event.ts, event.ts)
      }
    } catch (error) {
      failure = String(error)
    }
  }

  const stats = { fileCount: files.length, sizeBytes: files.reduce((sum, file) => sum + file.size, 0) }
  if (sessions.size > 0) {
    return {
      ...base,
      ...stats,
      status: 'ok',
      sessionCount: sessions.size,
      earliest,
      latest,
      detail: [options.coverage, `抽样验证 ${sample.length} 个记录文件`, failure ? '部分文件暂时无法读取' : '']
        .filter(Boolean).join('；')
    }
  }
  if (failure) return { ...base, ...stats, status: 'unrecognized', detail: failure }
  return {
    ...base,
    ...stats,
    status: recognized ? 'unsupported' : 'unrecognized',
    detail: recognized
      ? options.noUsageDetail ?? '已识别记录格式，但其中没有可用的 token 用量字段；不计为零消耗'
      : '记录格式尚未支持，未计入用量'
  }
}
