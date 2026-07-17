import { describe, expect, it, vi } from 'vitest'
import { IntentManager } from './IntentManager'
import { RuntimeIntentAdapter } from './RuntimeIntentAdapter'
import { RuntimeStore } from './RuntimeStore'

function setup() {
  let runtimeTime = 4
  const store = new RuntimeStore({
    runtimeTimeProvider: () => ++runtimeTime,
  })
  const adapter = new RuntimeIntentAdapter(store)
  let sequence = 0
  const manager = new IntentManager({
    state: adapter,
    nextIntentId: () => `it-${++sequence}`,
  })
  return { store, adapter, manager }
}

describe('RuntimeIntentAdapter', () => {
  it('does not advance RuntimeStore when prepare returns null', () => {
    const { store, adapter } = setup()
    const revision = store.getSnapshot().revision
    const listener = vi.fn()
    store.subscribe(listener)

    const result = adapter.transaction(() => null, (draft) => {
      draft.mixer.masterGain = 0
    })

    expect(result).toBeNull()
    expect(store.getSnapshot().revision).toBe(revision)
    expect(store.getSnapshot().mixer.masterGain).toBe(1)
    expect(listener).not.toHaveBeenCalled()
  })

  it('commits completion effect and Intent removal in one revision', () => {
    const { store, manager } = setup()
    const accepted = manager.accept({
      requestId: 'req-gain',
      command: 'deck.setGain',
      origin: 'agent',
      target: { deckId: 'A' },
      domain: 'gain',
      when: { at: 'immediate' },
    })
    expect(accepted.accepted).toBe(true)
    if (!accepted.accepted) throw new Error('Expected Intent acceptance')

    const observedRevisions: number[] = []
    const unsubscribe = store.subscribe(() => {
      observedRevisions.push(store.getSnapshot().revision)
    })
    const event = manager.complete(
      accepted.intent.intentId,
      {},
      undefined,
      (draft) => {
        draft.decks.A.gain = 0.4
      },
    )
    unsubscribe()

    const snapshot = store.getSnapshot()
    expect(event).not.toBeNull()
    expect(event?.revision).toBe(snapshot.revision)
    expect(event?.runtimeTime).toBe(snapshot.runtimeTime)
    expect(snapshot.decks.A.gain).toBe(0.4)
    expect(snapshot.intents[accepted.intent.intentId]).toBeUndefined()
    expect(observedRevisions).toEqual([snapshot.revision])
  })
})
