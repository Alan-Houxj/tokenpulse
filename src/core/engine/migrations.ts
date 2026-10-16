import type { Store } from '../store/sqlite'
import type { PriceTable } from './cost'

/** Apply pending legacy data migrations without replaying completed steps. */
export function migrateData(store: Store, prices: PriceTable): void {
  const storedVersion = store.getMeta('data_version')
  let version = storedVersion === undefined ? 0 : Number(storedVersion)
  if (storedVersion?.trim() === '' || !Number.isSafeInteger(version) || version < 0) {
    throw new Error(`Invalid data_version: ${JSON.stringify(storedVersion)}`)
  }

  const steps: { version: number; run: () => void }[] = [
    {
      version: 2,
      run: () => {
        store.migrateZcodeInputV2()
        store.recomputeCosts(prices)
      }
    },
    { version: 3, run: () => store.migrateUnknownModelsV3() },
    { version: 4, run: () => store.migrateZcodePathsV4() },
    { version: 5, run: () => store.resetCodexPositionsV5() },
    { version: 6, run: () => store.migrateModelCaseV6() }
  ]

  for (const step of steps) {
    if (version >= step.version) continue
    // In particular, v2 must never commit its input subtraction without its marker.
    store.transaction(() => {
      step.run()
      store.setMeta('data_version', String(step.version))
    })
    version = step.version
  }
}
