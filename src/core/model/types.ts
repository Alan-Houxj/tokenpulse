/**
 * 统一数据契约 —— 整个产品的核心。
 * 所有 Agent 的用量最终都归一化为 UsageEvent，一层改动全局生效。
 */

export type AgentId = 'claude-code' | 'codex' | 'gemini-cli' | 'qwen' | 'zcode'

/** 归一化 token 口径：input 恒为「非缓存输入」（Codex/Gemini 的原始口径需减去 cached） */
export interface TokenBreakdown {
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
}

export interface UsageEvent {
  /** 幂等键 `${agent}:${sessionId}:${requestId}`，重复采集安全 */
  id: string
  /** epoch 毫秒（事件发生时间） */
  ts: number
  agent: AgentId
  sessionId: string
  model: string
  tokens: TokenBreakdown
  /** 官方成本（claude-code jsonl 自带 costUSD 时填） */
  costUSD?: number
  /** 引擎按价格表估算的成本（"API 等价估算"口径） */
  costEstUSD: number
  durationMs?: number
  projectPath?: string
}

/** 数据源探测四态 */
export type ProbeStatus = 'ok' | 'absent' | 'empty' | 'unrecognized'

export interface ProbeResult {
  agent: AgentId
  displayName: string
  root: string
  status: ProbeStatus
  fileCount?: number
  sessionCount?: number
  sizeBytes?: number
  earliest?: number
  latest?: number
  detail?: string
}

/** 适配器发现的数据文件（jsonl 或 sqlite 库文件） */
export interface DiscoveredFile {
  /** 规范化绝对路径（作为 file_positions 的键） */
  path: string
  size: number
  mtimeMs: number
}

export interface ReadResult {
  events: UsageEvent[]
  /** 新的读取位点（jsonl=字节偏移；sqlite=最大 rowid） */
  endOffset: number
  /**
   * 适配器自定义的解析状态（如 Codex 的"当前模型"），由调度器持久化、
   * 下次增量读取时原样传回——解决跨增量段的行内状态丢失。
   */
  state?: unknown
}

/**
 * 数据源适配器契约。偏移量语义对 jsonl 是字节、对 sqlite 是 rowid，
 * 由适配器自行解释，调度器只做「存取位点 + 比较文件签名 + 存取状态」。
 */
export interface SourceAdapter {
  readonly id: AgentId
  readonly displayName: string
  /** 各平台默认数据根（绝对路径，按当前平台返回存在的候选） */
  defaultRoots(): string[]
  /** 扫描数据根，返回当前全部数据文件快照 */
  discover(): DiscoveredFile[]
  /**
   * 增量读取单个文件。文件被截断/轮换（size < offset）时适配器应自行重置。
   * state 为上次读取结束时的解析状态（可为 undefined）。
   */
  readIncremental(file: DiscoveredFile, fromOffset: number, state?: unknown): Promise<ReadResult>
}

export interface TokenTotals extends TokenBreakdown {
  total: number
  costUSD: number
  costEstUSD: number
  eventCount: number
}

export interface AgentSummary {
  agent: AgentId
  displayName: string
  totals: TokenTotals
}

export interface ModelSummary {
  model: string
  totals: TokenTotals
}

export interface OverviewSummary {
  range: { from: number; to: number }
  totals: TokenTotals
  byAgent: AgentSummary[]
  byModel: ModelSummary[]
  /** 没有价格表覆盖的模型名（UI 提示"估算缺失"） */
  unpricedModels: string[]
}

export interface TrendPoint {
  bucketStart: number
  total: number
  input: number
  output: number
  cacheRead: number
  costEstUSD: number
}

export interface TrendPointByModel {
  bucketStart: number
  model: string
  total: number
  costEstUSD: number
}

export interface SessionRow {
  agent: AgentId
  sessionId: string
  projectPath?: string
  models: string[]
  firstTs: number
  lastTs: number
  totals: TokenTotals
}

export interface ActiveSessionRow {
  agent: AgentId
  sessionId: string
  projectPath?: string
  model: string
  lastTs: number
  recentTokens: number
  /** 请求吞吐：Σtoken ÷ Σ请求耗时（tok/s）。无耗时数据（如 Codex jsonl）时为 null */
  tokensPerSec: number | null
}

export interface IngestResult {
  inserted: number
  skipped: number
}
