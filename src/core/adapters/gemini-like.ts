/**
 * Gemini CLI 系适配器（Gemini CLI 与其 fork Qwen Code 共用）。
 * 数据：~/.gemini/tmp/<chatId>/chunk_*.json（Qwen 在 ~/.qwen 下）
 * 每个 chunk 文件是 {"requests":[{usageMetadata, modelVersion, chatId, timestamp?}]}，
 * 无 timestamp 时退化为文件 mtime。
 */
import { readFile } from 'node:fs/promises'
import type { AgentId, DiscoveredFile, ReadResult, SourceAdapter, UsageEvent } from '../model/types'
import { dirExists, homePath, parseJsonLine, walkFiles } from './util'

interface GeminiUsageMeta {
  promptTokenCount?: number
  candidatesTokenCount?: number
  thoughtsTokenCount?: number
  cachedContentTokenCount?: number
}

interface GeminiRequest {
  timestamp?: string
  chatId?: string
  modelVersion?: string
  usageMetadata?: GeminiUsageMeta
}

interface ChunkFile {
  requests?: GeminiRequest[]
}

export class GeminiLikeAdapter implements SourceAdapter {
  readonly id: AgentId
  readonly displayName: string
  private readonly rootCandidates: string[]

  constructor(opts: { id: AgentId; displayName: string; roots?: string[] | string; defaultRoot: string }) {
    this.id = opts.id
    this.displayName = opts.displayName
    // 防御：误传单个字符串时包裹成数组（字符串有 length，直接用会被逐字符迭代）
    const roots = typeof opts.roots === 'string' ? [opts.roots] : opts.roots
    this.rootCandidates = roots && roots.length > 0 ? roots : [opts.defaultRoot]
  }

  defaultRoots(): string[] {
    return this.rootCandidates
  }

  discover(): DiscoveredFile[] {
    const files: DiscoveredFile[] = []
    for (const root of this.rootCandidates) {
      if (!dirExists(root)) continue
      // chunk 文件可 json 可 jsonl；_usage.json 等内部文件跳过
      files.push(
        ...walkFiles(root, (n) => !n.startsWith('_') && (n.endsWith('.json') || n.endsWith('.jsonl')))
      )
    }
    const seen = new Map<string, DiscoveredFile>()
    for (const f of files) seen.set(f.path, f)
    return [...seen.values()]
  }

  async readIncremental(file: DiscoveredFile, fromOffset: number): Promise<ReadResult> {
    // chunk 文件整体重写风险低且通常很小：mtime/size 变了就整文件重读，靠幂等键去重
    if (fromOffset === file.size) return { events: [], endOffset: fromOffset }
    let text: string
    try {
      text = await readFile(file.path, 'utf8')
    } catch {
      return { events: [], endOffset: fromOffset }
    }

    // 兼容两种形态：单 JSON 对象 / 每行一个对象的 jsonl
    const requests: GeminiRequest[] = []
    const chunk = parseJsonLine<ChunkFile>(text)
    if (chunk && Array.isArray(chunk.requests)) {
      requests.push(...chunk.requests)
    } else {
      for (const line of text.split('\n')) {
        const r = parseJsonLine<GeminiRequest>(line)
        if (r?.usageMetadata) requests.push(r)
      }
    }
    if (requests.length === 0) return { events: [], endOffset: file.size }

    const fileTag = file.path.split('/').pop()?.replace(/[^a-zA-Z0-9-]/g, '') ?? 'f'
    const chatIdBase = requests.find((r) => r.chatId)?.chatId
    const chatId =
      chatIdBase ?? file.path.split('/').slice(-2, -1)[0] ?? 'unknown-chat' // 目录名即 chatId

    const events: UsageEvent[] = []
    requests.forEach((r, i) => {
      const u = r.usageMetadata
      if (!u) return
      const cached = Math.max(0, u.cachedContentTokenCount ?? 0)
      // Gemini 口径：promptTokenCount 含 cached；thoughts 独立于 candidates
      events.push({
        id: `${this.id}:${chatId}:${fileTag}:${i}`,
        ts: r.timestamp ? Date.parse(r.timestamp) : Math.round(file.mtimeMs),
        agent: this.id,
        sessionId: String(chatId),
        model: r.modelVersion ?? 'unknown',
        tokens: {
          input: Math.max(0, (u.promptTokenCount ?? 0) - cached),
          output: Math.max(0, u.candidatesTokenCount ?? 0),
          reasoning: Math.max(0, u.thoughtsTokenCount ?? 0),
          cacheRead: cached,
          cacheWrite: 0
        },
        costUSD: undefined,
        costEstUSD: 0
      })
    })
    return { events, endOffset: file.size }
  }
}

export function createGeminiAdapter(roots?: string[]): GeminiLikeAdapter {
  return new GeminiLikeAdapter({
    id: 'gemini-cli',
    displayName: 'Gemini CLI',
    defaultRoot: homePath('.gemini'),
    roots
  })
}

/** Qwen Code 是 gemini-cli 的 fork，数据格式同构（best-effort，探测页会暴露不识别） */
export function createQwenAdapter(roots?: string[]): GeminiLikeAdapter {
  return new GeminiLikeAdapter({
    id: 'qwen',
    displayName: 'Qwen Code',
    defaultRoot: homePath('.qwen'),
    roots
  })
}
