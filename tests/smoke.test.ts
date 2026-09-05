import { describe, expect, it } from 'vitest'
import { BUILTIN_PRICES, PRICES_VERSION } from '@core/engine/cost'

describe('工程冒烟测试', () => {
  it('core 包可被导入且价格表就绪', () => {
    expect(PRICES_VERSION).toBeGreaterThan(0)
    expect(Object.keys(BUILTIN_PRICES).length).toBeGreaterThan(10)
  })
})
