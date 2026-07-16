import { describe, expect, it } from 'vitest'
import type {
  IntentState,
  IntentTarget,
  P0When,
  VdapOrigin,
} from '@vibraxis/shared/vdap'
import {
  IntentManager,
  type AcceptIntentInput,
  type BindingSupersessionInput,
  type GeneralIntentDomain,
  type GeneralMutationCommand,
  type IntentStateAdapter,
  type IntentStateMap,
  type IntentTransactionPlan,
  type IntentTransactionResult,
  type RuntimeStateEffect,
} from './IntentManager'
import { RuntimeStore } from './RuntimeStore'

class RuntimeStoreIntentAdapter implements IntentStateAdapter {
  readonly store: RuntimeStore

  constructor() {
    let runtimeTime = 0
    this.store = new RuntimeStore({
      runtimeTimeProvider: () => ++runtimeTime / 10,
    })
  }

  transaction<T>(
    prepare: (
      current: Readonly<IntentStateMap>,
    ) => IntentTransactionPlan<T> | null,
    effect?: RuntimeStateEffect,
  ): IntentTransactionResult<T> | null {
    const current = this.store.getSnapshot().intents as unknown as Readonly<IntentStateMap>
    const plan = prepare(current)
    if (!plan) return null

    const snapshot = this.store.update((draft) => {
      draft.intents = plan.intents
      effect?.(draft)
    })
    return {
      revision: snapshot.revision,
      runtimeTime: snapshot.runtimeTime,
      value: plan.value,
    }
  }

  get intents(): Readonly<IntentStateMap> {
    return this.store.getSnapshot().intents as unknown as Readonly<IntentStateMap>
  }

  get revision(): number {
    return this.store.getSnapshot().revision
  }
}

function setup() {
  const state = new RuntimeStoreIntentAdapter()
  let sequence = 0
  const manager = new IntentManager({
    state,
    nextIntentId: () => `it-${++sequence}`,
  })
  return { manager, state }
}

function input(
  requestId: string,
  origin: VdapOrigin,
  domain: GeneralIntentDomain,
  target: IntentTarget,
  when: P0When = { at: 'immediate' },
  command: GeneralMutationCommand = 'deck.play',
): AcceptIntentInput {
  return { requestId, command, origin, target, domain, when }
}

function acceptedBindingIntent(
  manager: IntentManager,
  value: BindingSupersessionInput,
): IntentState {
  const result = manager.acceptBindingSupersession(value)
  expect(result.accepted).toBe(true)
  if (!result.accepted) throw new Error('Expected binding intent acceptance')
  return result.intent
}

function acceptedIntent(
  manager: IntentManager,
  value: AcceptIntentInput,
): IntentState {
  const result = manager.accept(value)
  expect(result.accepted).toBe(true)
  if (!result.accepted) throw new Error('Expected intent acceptance')
  return result.intent
}

describe('IntentManager', () => {
  it('adds immediate intents as executing and scheduled intents as scheduled', () => {
    const { manager, state } = setup()
    const immediate = acceptedIntent(
      manager,
      input('req-1', 'agent', 'transport', { deckId: 'A' }),
    )
    const scheduled = acceptedIntent(
      manager,
      input('req-2', 'agent', 'transport', { deckId: 'B' }, { at: 'nextBar' }),
    )

    expect(immediate.state).toBe('executing')
    expect(scheduled.state).toBe('scheduled')
    expect(state.intents[immediate.intentId]).toEqual(immediate)
    expect(state.intents[scheduled.intentId]).toEqual(scheduled)

    const transition = manager.markExecuting(scheduled.intentId)
    expect(transition?.intent.state).toBe('executing')
    expect(state.intents[scheduled.intentId].state).toBe('executing')
    expect(manager.markExecuting(scheduled.intentId)).toBeNull()
  })

  it('commits Intent changes and RuntimeState effects in one revision', () => {
    const { manager, state } = setup()
    const accepted = manager.accept(
      input('req-gain', 'user', 'gain', { deckId: 'A' }, { at: 'immediate' }, 'deck.setGain'),
      (draft) => {
        draft.decks.A.gain = 0.4
      },
    )
    expect(accepted.accepted).toBe(true)
    if (!accepted.accepted) throw new Error('Expected acceptance')

    let snapshot = state.store.getSnapshot()
    expect(snapshot.revision).toBe(accepted.revision)
    expect(snapshot.decks.A.gain).toBe(0.4)
    expect(snapshot.intents[accepted.intent.intentId]).toBeDefined()

    const completed = manager.complete(
      accepted.intent.intentId,
      {},
      undefined,
      (draft) => {
        draft.mixer.masterGain = 0.6
      },
    )
    snapshot = state.store.getSnapshot()
    expect(completed?.revision).toBe(snapshot.revision)
    expect(snapshot.mixer.masterGain).toBe(0.6)
    expect(snapshot.intents[accepted.intent.intentId]).toBeUndefined()
  })

  it('generates each logical terminal once and supports atomic failure/cancel/supersede effects', () => {
    const { manager, state } = setup()
    const failed = acceptedIntent(
      manager,
      input('req-fail', 'agent', 'gain', { deckId: 'A' }),
    )
    const cancelled = acceptedIntent(
      manager,
      input('req-cancel', 'agent', 'transport', { deckId: 'B' }),
    )
    const superseded = acceptedBindingIntent(manager, {
      requestId: 'req-old-load',
      origin: 'agent',
      command: 'deck.load',
      domain: 'binding',
      target: { deckId: 'B' },
      when: { at: 'immediate' },
    })

    const failedEvent = manager.fail(failed.intentId, {
      code: 'E_INTERNAL',
      retryable: true,
      message: 'boom',
    }, undefined, (draft) => {
      draft.decks.A.gain = 0.8
    })
    expect(failedEvent?.revision).toBe(state.revision)
    expect(state.store.getSnapshot().decks.A.gain).toBe(0.8)
    expect(manager.cancel(failed.intentId, 'panic')).toBeNull()

    const cancelledEvent = manager.cancel(
      cancelled.intentId,
      'clientCancel',
      undefined,
      (draft) => {
        draft.decks.B.gain = 0.7
      },
    )
    expect(cancelledEvent?.revision).toBe(state.revision)
    expect(state.store.getSnapshot().decks.B.gain).toBe(0.7)
    expect(manager.cancel(cancelled.intentId, 'clientCancel')).toBeNull()

    const supersededEvent = manager.supersede(
      superseded.intentId,
      'it-new',
      (draft) => {
        draft.mixer.masterGain = 0.5
      },
    )
    expect(supersededEvent?.revision).toBe(state.revision)
    expect(state.store.getSnapshot().mixer.masterGain).toBe(0.5)
    expect(manager.supersede(superseded.intentId, 'it-newer')).toBeNull()
    expect(state.intents).toEqual({})
  })

  it('user override cancels only scheduled work and executing automation', () => {
    const { manager, state } = setup()
    const scheduled = acceptedIntent(
      manager,
      input('req-scheduled', 'agent', 'transport', { deckId: 'A' }, { at: 'nextBar' }),
    )
    const immediate = acceptedIntent(
      manager,
      input('req-immediate', 'agent', 'transport', { deckId: 'A' }),
    )
    const ramp = acceptedIntent(
      manager,
      input('req-ramp', 'agent', 'crossfader', { mixer: 'crossfader' }, { at: 'immediate' }, 'mixer.rampCrossfader'),
    )

    const transportOverride = manager.accept(
      input('req-user-play', 'user', 'transport', { deckId: 'A' }),
    )
    expect(transportOverride.accepted).toBe(true)
    if (!transportOverride.accepted) throw new Error('Expected acceptance')
    expect(transportOverride.cancelled.map((event) => event.intentId)).toEqual([
      scheduled.intentId,
    ])
    expect(state.intents[immediate.intentId]).toBeDefined()

    const mixerOverride = manager.accept(
      input('req-user-fader', 'user', 'crossfader', { mixer: 'crossfader' }, { at: 'immediate' }, 'mixer.setCrossfader'),
    )
    expect(mixerOverride.accepted).toBe(true)
    if (!mixerOverride.accepted) throw new Error('Expected acceptance')
    expect(mixerOverride.cancelled.map((event) => event.intentId)).toEqual([
      ramp.intentId,
    ])
  })

  it('rejects generic binding misuse and uses the dedicated supersession result', () => {
    const generic = setup()
    const invalidBindingInput = {
      requestId: 'req-invalid',
      origin: 'user',
      command: 'deck.unload',
      domain: 'binding',
      target: { deckId: 'A' },
      when: { at: 'immediate' },
    } as unknown as AcceptIntentInput
    expect(() => generic.manager.accept(invalidBindingInput)).toThrow(
      'Binding commands must use acceptBindingSupersession().',
    )
    expect(generic.state.intents).toEqual({})

    const dedicated = setup()
    const oldLoad = acceptedBindingIntent(dedicated.manager, {
      requestId: 'req-old',
      origin: 'agent',
      command: 'deck.load',
      domain: 'binding',
      target: { deckId: 'B' },
      when: { at: 'immediate' },
    })
    const replacement = dedicated.manager.acceptBindingSupersession({
      requestId: 'req-replacement',
      command: 'deck.unload',
      origin: 'user',
      target: { deckId: 'B' },
      domain: 'binding',
      when: { at: 'immediate' },
    })
    expect(replacement.accepted).toBe(true)
    if (!replacement.accepted) throw new Error('Expected binding replacement')
    expect(replacement.cancelled).toEqual([])
    expect(replacement.superseded).toHaveLength(1)
    expect(replacement.superseded[0]).toMatchObject({
      intentId: oldLoad.intentId,
      supersededBy: replacement.intent.intentId,
      revision: replacement.revision,
    })
    expect(dedicated.manager.cancel(oldLoad.intentId, 'userOverride')).toBeNull()
  })

  it('rejects an agent that would overtake a live user intent', () => {
    const { manager, state } = setup()
    const user = acceptedIntent(
      manager,
      input('req-user', 'user', 'crossfader', { mixer: 'crossfader' }, { at: 'nextBar' }, 'mixer.rampCrossfader'),
    )
    const revisionBefore = state.revision

    const result = manager.accept(
      input('req-agent', 'agent', 'crossfader', { mixer: 'crossfader' }, { at: 'nextBar' }, 'mixer.rampCrossfader'),
    )
    expect(result).toEqual({
      accepted: false,
      error: 'E_USER_PRIORITY',
      blockingIntentIds: [user.intentId],
    })
    expect(state.revision).toBe(revisionBefore)
    expect(Object.keys(state.intents)).toEqual([user.intentId])
  })

  it('cancels by deck/domain filter and protects user intents from agent cancellation', () => {
    const { manager, state } = setup()
    const agentTransport = acceptedIntent(
      manager,
      input('req-agent-transport', 'agent', 'transport', { deckId: 'A' }, { at: 'nextBar' }),
    )
    const agentGain = acceptedIntent(
      manager,
      input('req-agent-gain', 'agent', 'gain', { deckId: 'A' }, { at: 'nextBeat' }, 'deck.setGain'),
    )
    const userTransport = acceptedIntent(
      manager,
      input('req-user-transport', 'user', 'transport', { deckId: 'B' }, { at: 'nextBar' }),
    )

    const filtered = manager.cancelByFilter(
      { deckId: 'A', domain: 'transport' },
      'clientCancel',
      'user',
    )
    expect(filtered.cancelledCount).toBe(1)
    expect(filtered.events[0].intentId).toBe(agentTransport.intentId)
    expect(state.intents[agentGain.intentId]).toBeDefined()

    const agentAll = manager.cancelByFilter({ all: true }, 'clientCancel', 'agent')
    expect(agentAll.cancelledCount).toBe(1)
    expect(agentAll.skippedCount).toBe(1)
    expect(agentAll.events[0].intentId).toBe(agentGain.intentId)
    expect(state.intents[userTransport.intentId]).toBeDefined()
  })

  it('filter cancellation skips normal executing work and clears ramp automation atomically', () => {
    const { manager, state } = setup()
    const immediate = acceptedIntent(
      manager,
      input(
        'req-immediate-fader',
        'agent',
        'crossfader',
        { mixer: 'crossfader' },
        { at: 'immediate' },
        'mixer.setCrossfader',
      ),
    )
    const ramp = acceptedIntent(
      manager,
      input(
        'req-ramp',
        'agent',
        'crossfader',
        { mixer: 'crossfader' },
        { at: 'immediate' },
        'mixer.rampCrossfader',
      ),
    )
    state.store.update((draft) => {
      draft.mixer.crossfader.automation = {
        intentId: ramp.intentId,
        from: 0,
        to: 1,
        startedAtRuntimeTime: draft.runtimeTime,
        durationSecondsEstimate: 8,
      }
    })

    const result = manager.cancelByFilter(
      { all: true },
      'clientCancel',
      'user',
      (draft) => {
        draft.mixer.crossfader.automation = null
      },
    )
    const snapshot = state.store.getSnapshot()

    expect(result.cancelledCount).toBe(1)
    expect(result.skippedCount).toBe(1)
    expect(result.events[0]).toMatchObject({
      intentId: ramp.intentId,
      revision: snapshot.revision,
    })
    expect(snapshot.intents[ramp.intentId]).toBeUndefined()
    expect(snapshot.intents[immediate.intentId]).toBeDefined()
    expect(snapshot.mixer.crossfader.automation).toBeNull()
  })
})
