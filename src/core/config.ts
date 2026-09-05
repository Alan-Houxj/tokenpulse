/**
 * 用户配置：%APPDATA%/AgentMeter/config.json（全部可选，缺省即可用）
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { AgentId } from './model/types'
import type { PriceOverrides } from './engine/cost'

export interface AgentMeterConfig {
  /** 轮询间隔（ms），默认 5000 */
  pollIntervalMs: number
  /** 自定义数据根：追加到各 Agent 默认根之后 */
  roots: Partial<Record<AgentId, string[]>>
  /** 价格覆盖（值为 null 表示停用内置档；键为归一化模型名） */
  priceOverrides: PriceOverrides
  /** 首启引导是否已完成 */
  onboarded: boolean
}

export function defaultConfig(): AgentMeterConfig {
  return {
    pollIntervalMs: 5000,
    roots: {},
    priceOverrides: {},
    onboarded: false
  }
}

export function configPath(userDataDir: string): string {
  return join(userDataDir, 'config.json')
}

export function loadConfig(userDataDir: string): AgentMeterConfig {
  const base = defaultConfig()
  const p = configPath(userDataDir)
  if (!existsSync(p)) return base
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8')) as Partial<AgentMeterConfig>
    return {
      pollIntervalMs: typeof raw.pollIntervalMs === 'number' ? raw.pollIntervalMs : base.pollIntervalMs,
      roots: raw.roots ?? base.roots,
      priceOverrides: raw.priceOverrides ?? base.priceOverrides,
      onboarded: raw.onboarded ?? base.onboarded
    }
  } catch {
    return base // 坏配置不致命：回落默认值
  }
}

export function saveConfig(userDataDir: string, config: AgentMeterConfig): void {
  const p = configPath(userDataDir)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, JSON.stringify(config, null, 2), 'utf8')
}
