import { describe, expect, it } from 'vitest'
import { appInfo } from '@core/meta'

describe('工程冒烟测试', () => {
  it('core 包可被导入', () => {
    expect(appInfo.name).toBe('agentmeter')
  })
})
