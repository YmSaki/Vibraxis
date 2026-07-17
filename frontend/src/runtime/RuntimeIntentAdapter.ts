import type { IntentState } from '@vibraxis/shared/vdap'
import type {
  IntentStateAdapter,
  IntentStateMap,
  IntentTransactionPlan,
  IntentTransactionResult,
  RuntimeStateEffect,
} from './IntentManager'
import type { RuntimeStore } from './RuntimeStore'

/**
 * Commits the IntentManager map and its runtime effect through one
 * RuntimeStore update, so subscribers can never observe a half-applied intent.
 */
export class RuntimeIntentAdapter implements IntentStateAdapter {
  readonly #store: RuntimeStore

  constructor(store: RuntimeStore) {
    this.#store = store
  }

  transaction<T>(
    prepare: (
      current: Readonly<IntentStateMap>,
    ) => IntentTransactionPlan<T> | null,
    effect?: RuntimeStateEffect,
  ): IntentTransactionResult<T> | null {
    const current = this.#store.getSnapshot().intents as Readonly<
      Record<string, Readonly<IntentState>>
    > as Readonly<IntentStateMap>
    const plan = prepare(current)
    if (plan === null) return null

    const snapshot = this.#store.update((draft) => {
      draft.intents = plan.intents
      effect?.(draft)
    })

    return {
      revision: snapshot.revision,
      runtimeTime: snapshot.runtimeTime,
      value: plan.value,
    }
  }
}
