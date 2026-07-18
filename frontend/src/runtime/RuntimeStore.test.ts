import type { RuntimeState } from '@vibraxis/shared/vdap'
import { describe, expect, it, vi } from 'vitest'
import { RuntimeStore } from './RuntimeStore'

describe('RuntimeStore', () => {
  it('requires an explicit runtime clock even with an initial state', () => {
    // @ts-expect-error runtimeTimeProvider is intentionally required.
    expect(() => new RuntimeStore()).toThrow('runtimeTimeProvider is required')

    const createFromInitialStateWithoutClock = () =>
      // @ts-expect-error initialState does not make the clock optional.
      new RuntimeStore({
        initialState: {
          revision: 1,
          runtimeTime: 0,
        } as RuntimeState,
      })
    expect(createFromInitialStateWithoutClock).toThrow(
      'runtimeTimeProvider is required',
    )
  })

  it('starts with two empty decks and all required nullable fields', () => {
    const store = new RuntimeStore({ runtimeTimeProvider: () => 12.5 })
    const snapshot = store.getSnapshot()

    expect(snapshot.revision).toBe(1)
    expect(snapshot.runtimeTime).toBe(12.5)
    expect(Object.keys(snapshot.decks)).toEqual(['A', 'B'])
    for (const deck of Object.values(snapshot.decks)) {
      expect(deck.load).toEqual({
        phase: 'idle',
        intentId: null,
        progress: null,
      })
      expect(deck.binding).toBeNull()
      expect(deck.transport.phase).toBe('empty')
      expect(deck.playback.override).toBeNull()
      expect(deck.tempo.baseBpm).toBeNull()
      expect(deck.tempo.interpretedBpm).toBeNull()
      expect(deck.tempo.effectiveBpm).toBeNull()
      expect(deck.eq).toEqual({ lowDb: 0, midDb: 0, highDb: 0 })
    }
    expect(snapshot.mixer.crossfader.override).toBeNull()
    expect(snapshot.mixer.crossfader.automation).toBeNull()
    expect(snapshot.mixer.crossfader.curve).toBe('dj')
    expect(snapshot.intents).toEqual({})
  })

  it('increments revision once and keeps runtimeTime monotonic per update', () => {
    let now = 10
    const store = new RuntimeStore({ runtimeTimeProvider: () => now })

    now = 11.25
    const second = store.update((draft) => {
      draft.decks.A.gain = 0.75
    })
    expect(second.revision).toBe(2)
    expect(second.runtimeTime).toBe(11.25)

    now = 9
    const third = store.update((draft) => {
      draft.decks.B.gain = 0.5
    })
    expect(third.revision).toBe(3)
    expect(third.runtimeTime).toBe(11.25)
  })

  it('publishes one atomic snapshot after a multi-field update', () => {
    const store = new RuntimeStore({ runtimeTimeProvider: () => 2 })
    const observed: Array<ReturnType<typeof store.getSnapshot>> = []
    store.subscribe(() => observed.push(store.getSnapshot()))

    store.update((draft) => {
      draft.mixer.crossfader.base = 0.4
      draft.mixer.crossfader.effective = 0.4
      draft.decks.A.gain = 1.25
    })

    expect(observed).toHaveLength(1)
    expect(observed[0]).toMatchObject({
      revision: 2,
      mixer: { crossfader: { base: 0.4, effective: 0.4 } },
      decks: { A: { gain: 1.25 } },
    })
  })

  it('does not notify a listener after unsubscribe', () => {
    const store = new RuntimeStore({ runtimeTimeProvider: () => 0 })
    const listener = vi.fn()
    const unsubscribe = store.subscribe(listener)

    store.update((draft) => {
      draft.mixer.masterGain = 0.8
    })
    unsubscribe()
    store.update((draft) => {
      draft.mixer.masterGain = 0.6
    })

    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('freezes snapshots and rejects removal of required nullable fields', () => {
    const store = new RuntimeStore({ runtimeTimeProvider: () => 3 })
    const snapshot = store.getSnapshot()

    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.decks.A.playback)).toBe(true)
    expect(() => {
      ;(snapshot as unknown as RuntimeState).decks.A.gain = 0
    }).toThrow(TypeError)

    expect(() =>
      store.update((draft) => {
        delete (draft.decks.A.playback as Partial<
          RuntimeState['decks']['A']['playback']
        >).override
      }),
    ).toThrow('decks.A.playback.override')
    expect(store.getSnapshot()).toBe(snapshot)
    expect(store.getSnapshot().revision).toBe(1)
  })
})
