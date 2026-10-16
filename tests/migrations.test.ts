import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { migrateData } from '@core/engine/migrations'
import type { PriceTable } from '@core/engine/cost'
import type { UsageEvent } from '@core/model/types'
import { Store } from '@core/store/sqlite'

const PRICES: PriceTable = {
  'glm-5.3': { input: 2, output: 4, cacheRead: 0.25, cacheWrite: 3 },
  'gpt-5.2': { input: 2, output: 4, cacheRead: 0.25, cacheWrite: 3 }
}
const METHODS = [
  'migrateZcodeInputV2',
  'migrateUnknownModelsV3',
  'migrateZcodePathsV4',
  'resetCodexPositionsV5',
  'migrateModelCaseV6'
] as const
const VERSIONS = [2, 3, 4, 5, 6]

let dir: string
let dbPath: string
let store: Store
let db: DatabaseSync

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tokenpulse-migrations-'))
  dbPath = join(dir, 'test.db')
  store = Store.open(dbPath)
  db = new DatabaseSync(dbPath)
})

afterEach(() => {
  vi.restoreAllMocks()
  db.close()
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

function event(partial: Partial<UsageEvent> & { id: string }): UsageEvent {
  return {
    ts: 1_700_000_000_000,
    agent: 'codex',
    sessionId: 'archived-codex',
    model: 'gpt-5.2',
    tokens: { input: 1000, output: 200, reasoning: 25, cacheRead: 300, cacheWrite: 10 },
    costUSD: 0.12,
    costEstUSD: 12.34,
    durationMs: 4000,
    projectPath: 'C:/archived/project',
    ...partial
  }
}

function seedArchived(): void {
  store.insertEvents([
    event({ id: 'zcode:archived:r1', agent: 'zcode', sessionId: 'archived-zcode', model: 'glm-5.3' }),
    event({ id: 'codex:archived:r1' }),
    event({ id: 'codex:archived:unknown', model: 'unknown' }),
    event({ id: 'claude-code:archived:r1', agent: 'claude-code', sessionId: 'archived-claude' })
  ])
  for (const agent of ['zcode', 'codex', 'claude-code'] as const) {
    const path = join(dir, 'removed-sources', agent, 'usage.jsonl')
    expect(existsSync(path)).toBe(false)
    store.saveFileOffset(agent, path, 37, 2048, 1_700_000_001_234, {
      model: 'gpt-5.2',
      sessionId: `archived-${agent}`,
      nested: { pending: [1, 2], cursor: 'retained' }
    })
  }
  store.setMeta('prices_version', '2')
}

function snapshot() {
  return {
    events: db.prepare('SELECT * FROM events ORDER BY id').all(),
    positions: db.prepare('SELECT * FROM file_positions ORDER BY agent, file_path').all(),
    meta: db.prepare('SELECT * FROM meta ORDER BY key').all()
  }
}

function watchMigrations() {
  return METHODS.map((method) => vi.spyOn(store, method))
}

describe('migrateData', () => {
  it('leaves version 6 archives, offsets, signatures and parser state untouched on two starts', () => {
    seedArchived()
    store.setMeta('data_version', '6')
    db.prepare('UPDATE events SET model = ? WHERE id = ?')
      .run('GLM-5.3-20260901', 'zcode:archived:r1')
    const before = snapshot()

    for (let start = 0; start < 2; start++) {
      store.close()
      store = Store.open(dbPath)
      const migrations = watchMigrations()
      const transaction = vi.spyOn(store, 'transaction')
      const recompute = vi.spyOn(store, 'recomputeCosts')
      const marker = vi.spyOn(store, 'setMeta')

      migrateData(store, PRICES)

      expect(snapshot()).toEqual(before)
      expect(transaction).not.toHaveBeenCalled()
      expect(recompute).not.toHaveBeenCalled()
      expect(marker).not.toHaveBeenCalled()
      for (const migration of migrations) expect(migration).not.toHaveBeenCalled()
      vi.restoreAllMocks()
    }
  })

  it('runs only model-case migration from version 5 without changing costs or positions', () => {
    seedArchived()
    store.setMeta('data_version', '5')
    db.prepare('UPDATE events SET model = ? WHERE id = ?')
      .run('GLM-5.3-20260901', 'zcode:archived:r1')
    const before = snapshot()
    const migrations = watchMigrations()
    const recompute = vi.spyOn(store, 'recomputeCosts')

    migrateData(store, PRICES)

    expect(migrations.map((migration) => migration.mock.calls.length)).toEqual([0, 0, 0, 0, 1])
    expect(recompute).not.toHaveBeenCalled()
    expect(snapshot()).toEqual({
      ...before,
      events: before.events.map((row) => row.id === 'zcode:archived:r1' ? { ...row, model: 'glm-5.3' } : row),
      meta: before.meta.map((row) => row.key === 'data_version' ? { ...row, value: '6' } : row)
    })
  })

  it('upgrades a fresh database to version 6 and records each successful step in order', () => {
    const migrations = watchMigrations()
    const marker = vi.spyOn(store, 'setMeta')
    const recompute = vi.spyOn(store, 'recomputeCosts')

    migrateData(store, PRICES)
    migrateData(store, PRICES)

    expect(store.getMeta('data_version')).toBe('6')
    expect(store.eventCount()).toBe(0)
    expect(snapshot().positions).toEqual([])
    expect(migrations.map((migration) => migration.mock.calls.length)).toEqual([1, 1, 1, 1, 1])
    expect(marker.mock.calls).toEqual(VERSIONS.map((version) => ['data_version', String(version)]))
    expect(recompute).toHaveBeenCalledExactlyOnceWith(PRICES)
  })

  it.each([0, 1, 2, 3, 4])('runs only pending steps from version %i and never repeats them', (version) => {
    seedArchived()
    store.setMeta('data_version', String(version))
    const migrations = watchMigrations()
    const recompute = vi.spyOn(store, 'recomputeCosts')
    const marker = vi.spyOn(store, 'setMeta')

    migrateData(store, PRICES)

    const migrated = snapshot()
    expect(migrated.events.some((row) => row.id === 'zcode:archived:r1')).toBe(version >= 4)
    expect(migrated.events.some((row) => row.id === 'codex:archived:unknown')).toBe(version >= 3)
    expect(migrated.events.some((row) => row.id === 'codex:archived:r1')).toBe(true)
    expect(migrated.positions.map((row) => row.agent)).toEqual(
      version < 3 ? [] : version < 4 ? ['claude-code'] : ['claude-code', 'zcode']
    )
    migrateData(store, PRICES)

    expect(snapshot()).toEqual(migrated)
    expect(store.getMeta('data_version')).toBe('6')
    expect(migrations.map((migration) => migration.mock.calls.length)).toEqual(
      VERSIONS.map((target) => version < target ? 1 : 0)
    )
    expect(marker.mock.calls).toEqual(
      VERSIONS.filter((target) => version < target).map((target) => ['data_version', String(target)])
    )
    expect(recompute).toHaveBeenCalledTimes(version < 2 ? 1 : 0)
  })

  it('rolls back nonidempotent v2 and all nested cost batches if recomputation fails', () => {
    seedArchived()
    store.insertEvents(Array.from({ length: 501 }, (_, i) => event({ id: `codex:batch:r${i}` })))
    store.setMeta('data_version', '1')
    const before = snapshot()
    const original = store.recomputeCosts.bind(store)
    const recompute = vi.spyOn(store, 'recomputeCosts').mockImplementationOnce((prices) => {
      original(prices)
      throw new Error('cost recomputation interrupted')
    })

    expect(() => migrateData(store, PRICES)).toThrow('cost recomputation interrupted')

    expect(snapshot()).toEqual(before)
    expect(store.getMeta('data_version')).toBe('1')
    recompute.mockRestore()
    migrateData(store, PRICES)
    expect(store.getMeta('data_version')).toBe('6')
  })

  it('keeps committed v2 but rolls back failed v3, then resumes without subtracting input again', () => {
    seedArchived()
    store.setMeta('data_version', '1')
    const positions = snapshot().positions
    const v2 = vi.spyOn(store, 'migrateZcodeInputV2')
    const recompute = vi.spyOn(store, 'recomputeCosts')
    const original = store.migrateUnknownModelsV3.bind(store)
    vi.spyOn(store, 'migrateUnknownModelsV3').mockImplementationOnce(() => {
      original()
      throw new Error('v3 interrupted after deleting rows')
    })

    expect(() => migrateData(store, PRICES)).toThrow('v3 interrupted after deleting rows')

    expect(store.getMeta('data_version')).toBe('2')
    expect(store.eventCount()).toBe(4)
    expect(snapshot().positions).toEqual(positions)
    expect(db.prepare('SELECT input_tokens, cost_est_usd FROM events WHERE id = ?')
      .get('zcode:archived:r1')).toEqual({ input_tokens: 700, cost_est_usd: 0.002305 })

    migrateData(store, PRICES)
    migrateData(store, PRICES)

    expect(store.getMeta('data_version')).toBe('6')
    expect(v2).toHaveBeenCalledTimes(1)
    expect(recompute).toHaveBeenCalledTimes(1)
    expect(store.eventCount()).toBe(2)
    expect(snapshot().positions).toEqual([])
  })

  it.each(VERSIONS)('rolls back step %i when its version marker cannot be saved', (target) => {
    seedArchived()
    store.setMeta('data_version', String(target - 1))
    db.prepare('UPDATE events SET model = ? WHERE id = ?')
      .run('GLM-5.3-20260901', 'zcode:archived:r1')
    const before = snapshot()
    db.exec(`
      CREATE TRIGGER reject_version AFTER UPDATE OF value ON meta
      WHEN NEW.key = 'data_version' AND NEW.value = '${target}'
      BEGIN SELECT RAISE(ABORT, 'version write rejected'); END;
    `)

    expect(() => migrateData(store, PRICES)).toThrow('version write rejected')

    expect(snapshot()).toEqual(before)
    expect(store.getMeta('data_version')).toBe(String(target - 1))
    db.exec('DROP TRIGGER reject_version')
    migrateData(store, PRICES)
    expect(store.getMeta('data_version')).toBe('6')
  })

  it.each(['7', '12'])('does not downgrade a future numeric version %s', (version) => {
    seedArchived()
    store.setMeta('data_version', version)
    const before = snapshot()
    const transaction = vi.spyOn(store, 'transaction')

    migrateData(store, PRICES)

    expect(snapshot()).toEqual(before)
    expect(transaction).not.toHaveBeenCalled()
  })

  it.each(['', 'invalid', '-1', '5.5', 'NaN', 'Infinity'])('fails closed on invalid version %j', (version) => {
    seedArchived()
    store.setMeta('data_version', version)
    const before = snapshot()
    const transaction = vi.spyOn(store, 'transaction')

    expect(() => migrateData(store, PRICES)).toThrow('Invalid data_version')

    expect(snapshot()).toEqual(before)
    expect(transaction).not.toHaveBeenCalled()
  })
})
