import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AGENT_NAMES, type AgentId, type SourceAdapter, type UsageEvent } from '@core/model/types'
import { buildAdapter, buildAdapters } from '@core/adapters/registry'
import { appDataPath } from '@core/adapters/paths'
import { probeRecordedUsage } from '@core/adapters/probe-util'
import { probeAdapter, probeRoot } from '@core/engine/detect'

let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'tokenpulse-source-test-')) })
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

function adapter(): SourceAdapter {
  const path = join(root, 'records.bin')
  writeFileSync(path, 'test')
  return {
    id: 'dsh', displayName: 'DSH', defaultRoots: () => [root],
    discover: () => [{ path, size: 512 * 1024, mtimeMs: 1 }],
    readIncremental: vi.fn(async () => ({ events: [], endOffset: 0, recognized: true }))
  }
}

describe('source integration', () => {
  it('registers all nine sources including both desktop clients separately', () => {
    const adapters = buildAdapters()
    expect(adapters.map((source) => source.id).sort()).toEqual(Object.keys(AGENT_NAMES).sort())
    expect(new Set(adapters.map((source) => source.id)).size).toBe(9)
    expect(adapters.findIndex((source) => source.id === 'claude-desktop')).toBeLessThan(
      adapters.findIndex((source) => source.id === 'claude-code')
    )
  })

  it.each<AgentId>(['dsh', 'kimi-code', 'kimi-desktop', 'claude-desktop'])(
    '%s uses the same factory for an explicit-root probe', async (id) => {
      const source = buildAdapter(id, [root])
      expect(source.defaultRoots()).toEqual([root])
      const result = await probeRoot((path) => buildAdapter(id, [path]), root)
      expect(result.agent).toBe(id)
      expect(result.status).not.toBe('ok')
    }
  )

  it('lets stateful adapters own their probe instead of using arbitrary tail byte offsets', async () => {
    const source = adapter()
    source.probe = () => probeRecordedUsage(source)
    const result = await probeAdapter(source)
    expect(source.readIncremental).toHaveBeenCalledWith(source.discover()[0], 0)
    expect(result.status).toBe('unsupported')
  })

  it('distinguishes a known log without usage from an unknown log or a read failure', async () => {
    const source = adapter()
    expect((await probeRecordedUsage(source)).status).toBe('unsupported')
    source.readIncremental = async () => ({ events: [], endOffset: 0, recognized: false })
    expect((await probeRecordedUsage(source)).status).toBe('unrecognized')
    source.readIncremental = async () => { throw new Error('read denied') }
    expect(await probeRecordedUsage(source)).toMatchObject({ status: 'unrecognized', detail: 'Error: read denied' })
  })

  it('reports no usage for a recognized desktop profile without counting a placeholder event', async () => {
    const source = adapter()
    source.discover = () => []
    const result = await probeRecordedUsage(source, { unavailableWithoutFiles: true, emptyDetail: 'No local usage' })
    expect(result).toMatchObject({ status: 'unsupported', fileCount: 0, detail: 'No local usage' })
    expect(source.readIncremental).not.toHaveBeenCalled()
  })

  it('preserves coverage notes for a source that has actual events', async () => {
    const source = adapter()
    const event: UsageEvent = {
      id: 'synthetic', agent: 'dsh', sessionId: 'session', ts: 1000, model: 'model', costEstUSD: 0,
      tokens: { input: 1, output: 2, reasoning: 0, cacheRead: 3, cacheWrite: 4 }
    }
    source.readIncremental = async () => ({ events: [event], endOffset: 4, recognized: true })
    expect(await probeRecordedUsage(source, { coverage: 'Local agent only' })).toMatchObject({
      status: 'ok', sessionCount: 1, earliest: 1000, latest: 1000, detail: expect.stringContaining('Local agent only')
    })
  })

  it('resolves app data using platform conventions and configured roots', () => {
    expect(appDataPath('Example', 'win32', '/home/example', { APPDATA: '/roaming' })).toBe(join('/roaming', 'Example'))
    expect(appDataPath('Example', 'darwin', '/home/example', {})).toBe(join('/home/example', 'Library', 'Application Support', 'Example'))
    expect(appDataPath('Example', 'linux', '/home/example', {})).toBe(join('/home/example', '.config', 'Example'))
    expect(appDataPath('Example', 'linux', '/home/example', { XDG_CONFIG_HOME: '/config' })).toBe(join('/config', 'Example'))
  })
})
