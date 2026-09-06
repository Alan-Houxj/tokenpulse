/**
 * 成本引擎：「API 等价估算」口径。
 * - 内置精简价格表（USD / 1M tokens，快照可被用户覆盖）
 * - 四类 token 分别计价（cache read 是 input 价的 1/10 量级，绝不能合并）
 * - 未知模型返回 null，由 UI 提示"估算缺失"，而不是假装 0 成本
 */
import type { TokenBreakdown, UsageEvent } from '../model/types'

export interface ModelPrice {
  /** USD / 1M tokens */
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

/**
 * 内置价格快照（2026-09-04，来源各家官方定价页，调研存档见 docs/PRD.md）。
 * USD / 1M tokens；GLM/Qwen 用国际站美元价；订阅制场景此表是"API 等价估算"依据，
 * 用户可在设置里覆盖。带 ★ 的项为推断价（官方未单列）。
 */
export const BUILTIN_PRICES: Record<string, ModelPrice> = {
  // Anthropic（5 系列在售 + 4.x 存量；cache 规则 5m 读 0.1×、写 1.25×）
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
  'claude-fable-5': { input: 10, output: 50, cacheRead: 1.0, cacheWrite: 12.5 },
  'claude-mythos-5-1': { input: 10, output: 50, cacheRead: 1.0, cacheWrite: 12.5 }, // ★ cacheRead 按 0.1× 规则推断
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-opus-4-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-sonnet-4-5': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-opus-4-1': { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  'claude-3-7-sonnet': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-3-5-sonnet': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-3-5-haiku': { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
  // OpenAI（GPT-5.6 按天体代号分档：sol=旗舰 terra=中档 luna=轻量；5.6 起写缓存计费 1.25×）
  'gpt-6-astra': { input: 10, output: 50, cacheRead: 1.0, cacheWrite: 12.5 },
  'gpt-5.6-sol': { input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5.0 },
  'gpt-5.6-terra': { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 2.5 },
  'gpt-5.6-luna': { input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: 0.25 }, // ★ cacheWrite 按 1.25× 推断
  'gpt-5.3-codex': { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 2.19 },
  'gpt-5.2': { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 1.56 }, // 2026-08 已退役，历史数据用
  'gpt-5': { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 1.25 },
  'gpt-5-mini': { input: 0.25, output: 2, cacheRead: 0.125, cacheWrite: 0.31 }, // 2026-12 停服
  'o3': { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 2 },
  // Google（≤200k 档；缓存无写加价）
  'gemini-3.1-pro': { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 0 },
  'gemini-3-pro': { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 0 },
  'gemini-3-flash': { input: 0.75, output: 3.75, cacheRead: 0.075, cacheWrite: 0 },
  'gemini-2.5-pro': { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
  'gemini-2.5-flash': { input: 0.3, output: 2.5, cacheRead: 0.03, cacheWrite: 0 },
  // 智谱（z.ai 国际站官方美元价）
  'glm-5.3': { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 },
  'glm-5.3-flash': { input: 0.06, output: 0.2, cacheRead: 0.016, cacheWrite: 0 },
  'glm-5': { input: 1.0, output: 3.2, cacheRead: 0.2, cacheWrite: 0 },
  'glm-4.7': { input: 0.6, output: 2.2, cacheRead: 0.11, cacheWrite: 0 },
  // 阿里（国际站 ≤32k 档）
  'qwen3-coder-plus': { input: 1.0, output: 5.0, cacheRead: 0.1, cacheWrite: 1.25 }, // ★ cacheRead 按 10% 推断
  'qwen3-coder-flash': { input: 0.14, output: 0.56, cacheRead: 0.014, cacheWrite: 0.18 }
}

/** 入库/展示用模型名规范化：小写 + 去日期后缀（不做价格档位聚拢，保持模型身份）。
 *  各 Agent 上报大小写不一（ZCode 'GLM-5.3' / Codex 'glm-5.3'），统一后才能正确分组。 */
export function canonicalModelId(raw: string): string {
  return raw.toLowerCase().replace(/-\d{8}$/, '').trim()
}

/** 模型名归一化：小写、去日期后缀、聚拢到价格表档位 */
export function normalizeModelId(raw: string): string {
  const s = canonicalModelId(raw)

  // Codex 后台自动审查模型：无公开 API 价，按 gpt-5.3-codex 估算（推断映射）
  if (s === 'codex-auto-review') return 'gpt-5.3-codex'

  // Anthropic
  if (s.includes('fable-5-1') || (s.includes('fable') && s.includes('5.1'))) return 'claude-fable-5-1'
  if (s.includes('fable')) return 'claude-fable-5'
  if (s.includes('mythos')) return 'claude-mythos-5-1'
  if (s.includes('opus-5')) return 'claude-opus-5'
  if (s.includes('opus-4-5') || s.includes('opus-4-05')) return 'claude-opus-4-5'
  if (s.includes('opus-4-1') || s.includes('opus-4')) return 'claude-opus-4-1'
  if (s.includes('sonnet-5')) return 'claude-sonnet-5'
  if (s.includes('sonnet-4-5')) return 'claude-sonnet-4-5'
  if (s.includes('3-7-sonnet')) return 'claude-3-7-sonnet'
  if (s.includes('3-5-sonnet')) return 'claude-3-5-sonnet'
  if (s.includes('3-5-haiku') || s.includes('haiku')) return 'claude-haiku-4-5'

  // OpenAI：先长后短，fast/priority 变体按基本价
  if (s.startsWith('gpt-6')) return 'gpt-6-astra'
  if (s.includes('5.6-sol')) return 'gpt-5.6-sol'
  if (s.includes('5.6-terra')) return 'gpt-5.6-terra'
  if (s.includes('5.6-luna')) return 'gpt-5.6-luna'
  if (s.includes('5.3-codex')) return 'gpt-5.3-codex'
  if (s.includes('5.2')) return 'gpt-5.2'
  if (s.startsWith('gpt-5-mini')) return 'gpt-5-mini'
  if (s.startsWith('gpt-5')) return 'gpt-5'
  if (s.startsWith('o3')) return 'o3'

  // Google
  if (s.includes('gemini-3.1-pro') || s.includes('gemini-3-pro')) return 'gemini-3.1-pro'
  if (s.includes('gemini-3') && s.includes('flash')) return 'gemini-3-flash'
  if (s.includes('gemini-2.5-pro')) return 'gemini-2.5-pro'
  if (s.includes('gemini') && s.includes('flash')) return 'gemini-2.5-flash'

  // 智谱
  if (s.includes('glm-5.3-flash') || (s.includes('glm') && s.includes('flash'))) return 'glm-5.3-flash'
  if (s.includes('glm-5.3') || s.includes('glm-5.2')) return 'glm-5.3'
  if (s.includes('glm-5')) return 'glm-5'
  if (s.startsWith('glm')) return 'glm-4.7'

  // 阿里
  if (s.includes('qwen3-coder-plus') || s.includes('qwen3-235b')) return 'qwen3-coder-plus'
  if (s.includes('qwen3-coder-flash')) return 'qwen3-coder-flash'
  if (s.startsWith('qwen')) return 'qwen3-coder-plus'

  return s
}

export type PriceTable = Record<string, ModelPrice>

/** 覆盖表：值为 null 表示停用该内置档（模型将回到"缺价"状态） */
export type PriceOverrides = Record<string, ModelPrice | null>

/**
 * 价格表版本号：每次修改 BUILTIN_PRICES 必须 +1，
 * 应用启动检测到变化会自动重算全部历史事件的估算成本。
 */
export const PRICES_VERSION = 2

export function effectivePriceTable(overrides: PriceOverrides = {}): PriceTable {
  const out: PriceTable = { ...BUILTIN_PRICES }
  for (const [k, v] of Object.entries(overrides)) {
    if (v === null) delete out[k]
    else out[k] = v
  }
  return out
}

/** 估算单事件成本；未知模型返回 null（UI 显示"估算缺失"） */
export function estimateCost(
  model: string,
  tokens: TokenBreakdown,
  prices: PriceTable = BUILTIN_PRICES
): number | null {
  const p = prices[normalizeModelId(model)]
  if (!p) return null
  const cost =
    (tokens.input / 1e6) * p.input +
    (tokens.output / 1e6) * p.output +
    (tokens.cacheRead / 1e6) * p.cacheRead +
    (tokens.cacheWrite / 1e6) * p.cacheWrite
  return Math.round(cost * 1e6) / 1e6 // µ$ 精度即可
}

/** 批量回填估算成本，返回无价格的模型集合 */
export function applyCostEstimates(
  events: UsageEvent[],
  prices: PriceTable = BUILTIN_PRICES
): { events: UsageEvent[]; unpricedModels: Set<string> } {
  const unpriced = new Set<string>()
  const out = events.map((e) => {
    const est = estimateCost(e.model, e.tokens, prices)
    if (est === null) {
      unpriced.add(e.model)
      return e
    }
    return { ...e, costEstUSD: est }
  })
  return { events: out, unpricedModels: unpriced }
}
