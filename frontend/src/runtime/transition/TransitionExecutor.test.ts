import { describe, expect, it } from 'vitest'
import {
  VDAP_VERSION,
  type CommandResult,
  type IntentCancelReason,
  type VdapError,
  type VdapMutationCommand,
} from '@vibraxis/shared/vdap'
import type { TransitionPlan } from '@vibraxis/shared/dj'
import { VdapClientError, type IntentTerminalEvent, type MutationHandle } from '../VdapClient'
import { TransitionClient, TransitionExecutor } from './TransitionExecutor'

type Response =
  | { type: 'complete'; result?: CommandResult }
  | { type: 'cancel'; reason: IntentCancelReason; result?: CommandResult }
  | { type: 'fail'; error: VdapError; result?: CommandResult }
  | { type: 'reject'; error: VdapError }

type Call = { command: VdapMutationCommand; params: unknown; options: unknown }

const ERR = (code: VdapError['code']): VdapError => ({ code, message: code, retryable: false } as VdapError)

function terminalEvent(
  intentId: string,
  requestId: string,
  response: Exclude<Response, { type: 'reject' }>,
): IntentTerminalEvent {
  const base = { vdap: VDAP_VERSION, kind: 'event', intentId, requestId, revision: 1, runtimeTime: 1 } as const
  if (response.type === 'complete') return { ...base, event: 'intent.completed', result: response.result ?? {} }
  if (response.type === 'cancel') {
    return { ...base, event: 'intent.cancelled', reason: response.reason, ...(response.result ? { result: response.result } : {}) }
  }
  return { ...base, event: 'intent.failed', error: response.error, ...(response.result ? { result: response.result } : {}) }
}

/** Scriptable TransitionClient that records calls and replays per-command responses. */
class FakeClient implements TransitionClient {
  readonly calls: Call[] = []
  private sequence = 0

  constructor(private readonly responder: (command: VdapMutationCommand, callIndex: number) => Response) {}

  async mutate(command: VdapMutationCommand, params: unknown, options?: unknown): Promise<MutationHandle> {
    const callIndex = this.calls.length
    this.calls.push({ command, params, options })
    const response = this.responder(command, callIndex)
    const requestId = `req-${++this.sequence}`
    const intentId = `it-${this.sequence}`
    if (response.type === 'reject') {
      throw new VdapClientError(response.error.message, 'REJECTED', {
        vdap: VDAP_VERSION,
        kind: 'ack',
        requestId,
        state: 'rejected',
        error: response.error,
      })
    }
    const ack = { vdap: VDAP_VERSION, kind: 'ack', requestId, state: 'accepted', intentId, revision: 1 } as const
    return { ack, terminal: Promise.resolve(terminalEvent(intentId, requestId, response)) }
  }

  commands(): VdapMutationCommand[] {
    return this.calls.map((call) => call.command)
  }
}

const PLAN: TransitionPlan = {
  fromTrackId: 'track-A',
  fromBindingId: 'bind-active-A',
  expectedRevision: 1,
  targetBindingId: null,
  activeDeckId: 'A',
  nextTrackId: 'track-B',
  targetDeckId: 'B',
  tempoSync: 'tempo',
  startAt: 'nextBar',
  crossfadeBars: 4,
  confidence: 0.8,
  reasons: ['bpm-compatible'],
}

const LOAD_RESULT: CommandResult = {
  binding: {
    bindingId: 'bind-next',
    trackId: 'track-B',
    source: { kind: 'catalog', uri: '/tracks/track-B.mp3', title: 'Track B' },
    sha256: null,
    durationSeconds: 180,
    analysis: null,
  },
} as unknown as CommandResult

const SYNC_RESULT: CommandResult = { appliedVelocity: 1.0, requestedVelocity: 1.0, targetBpm: 128, exact: true } as CommandResult
const RAMP_RESULT: CommandResult = {
  from: -1, to: 1, startedAtRuntimeTime: 100, endedAtRuntimeTime: 108, durationSeconds: 8,
} as CommandResult

function happyResponder(): (command: VdapMutationCommand) => Response {
  return (command) => {
    if (command === 'deck.load') return { type: 'complete', result: LOAD_RESULT }
    if (command === 'deck.sync') return { type: 'complete', result: SYNC_RESULT }
    if (command === 'transition.start') return { type: 'complete', result: RAMP_RESULT }
    return { type: 'complete' }
  }
}

describe('TransitionExecutor', () => {
  it('drives load -> sync -> atomic transition.start -> pause active in order', async () => {
    const client = new FakeClient(happyResponder())
    const result = await new TransitionExecutor(client).run(PLAN)

    expect(result.status).toBe('completed')
    expect(client.commands()).toEqual([
      'deck.load',
      'deck.sync',
      'transition.start',
      'deck.pause',
    ])
  })

  it('requests target play and ramp through one atomic command', async () => {
    const client = new FakeClient(happyResponder())
    await new TransitionExecutor(client).run(PLAN)

    const transition = client.calls.find((call) => call.command === 'transition.start')
    expect(transition?.options).toEqual({ expectedRevision: 1 })
    expect(transition?.params).toMatchObject({
      activeDeckId: 'A', activeBindingId: 'bind-active-A',
      targetDeckId: 'B', targetBindingId: 'bind-next', at: 'nextBar',
      crossfader: { to: 1, duration: { bars: 4 }, curve: 'equalPower' },
    })
    // The final active-deck pause is guarded by the transition's start binding.
    const pause = client.calls.find((call) => call.command === 'deck.pause')
    expect((pause?.params as { deckId?: unknown }).deckId).toBe('A')
    expect((pause?.options as { expectedBindingId?: unknown }).expectedBindingId).toBe('bind-active-A')
    expect((pause?.options as { expectedRevision?: unknown }).expectedRevision).toBe(1)
    const load = client.calls.find((call) => call.command === 'deck.load')
    expect(load?.options).toEqual({ expectedRevision: 1 })
  })

  it('carries the apply-time revision and target binding into the first load precondition', async () => {
    const client = new FakeClient(happyResponder())
    await new TransitionExecutor(client).run({ ...PLAN, expectedRevision: 42, targetBindingId: 'old-target' })
    const load = client.calls.find((call) => call.command === 'deck.load')
    expect(load?.options).toEqual({ expectedRevision: 42, expectedBindingId: 'old-target' })
  })

  it('rolls back and fails when the required tempo sync is out of range (E_OUT_OF_RANGE)', async () => {
    // The runtime rejects an out-of-range sync (§11.11, AGENTS §0.6); it never
    // returns a clamped success. The executor must roll back and report failure.
    const client = new FakeClient((command) => {
      if (command === 'deck.load') return { type: 'complete', result: LOAD_RESULT }
      if (command === 'deck.sync') return { type: 'fail', error: ERR('E_OUT_OF_RANGE') }
      return { type: 'complete' }
    })
    const result = await new TransitionExecutor(client).run(PLAN)
    expect(result).toMatchObject({ status: 'failed', stage: 'sync', rolledBack: true })
    // No play/ramp were ever scheduled; rollback paused B and reset the fader to A.
    expect(client.commands()).not.toContain('deck.play')
    expect(client.commands()).not.toContain('mixer.rampCrossfader')
    const pauses = client.calls.filter((call) => call.command === 'deck.pause')
    expect(pauses.every((call) => (call.params as { deckId: string }).deckId === 'B')).toBe(true)
    expect(pauses[0]?.options).toEqual({ expectedBindingId: 'bind-next', expectedRevision: 1 })
  })

  it('does not rollback over a newer user state after a stale-revision rejection', async () => {
    const client = new FakeClient((command) => {
      if (command === 'deck.load') return { type: 'complete', result: LOAD_RESULT }
      if (command === 'deck.sync') return { type: 'reject', error: ERR('E_STALE_REVISION') }
      return { type: 'complete' }
    })
    const result = await new TransitionExecutor(client).run(PLAN)
    expect(result).toMatchObject({ status: 'failed', stage: 'sync', error: { code: 'E_STALE_REVISION' }, rolledBack: false })
    expect(client.commands()).toEqual(['deck.load', 'deck.sync'])
  })

  it('reports rolledBack:false with cleanupErrors when rollback itself fails', async () => {
    // Ramp fails, then the rollback pause of deck B is also rejected: the executor
    // must not claim the mix was rolled back (AGENTS §0.10, finding 4).
    const client = new FakeClient((command) => {
      if (command === 'deck.load') return { type: 'complete', result: LOAD_RESULT }
      if (command === 'deck.sync') return { type: 'complete', result: SYNC_RESULT }
      if (command === 'transition.start') return { type: 'fail', error: ERR('E_QUANTIZE_UNAVAILABLE'), result: RAMP_RESULT }
      if (command === 'deck.pause') return { type: 'fail', error: ERR('E_BINDING_MISMATCH') }
      return { type: 'complete' }
    })
    const result = await new TransitionExecutor(client).run(PLAN)
    expect(result).toMatchObject({ status: 'failed', stage: 'start', rolledBack: false })
    if (result.status === 'failed') {
      expect(result.cleanupErrors?.some((e) => e.code === 'E_BINDING_MISMATCH')).toBe(true)
    }
    expect(client.commands()).not.toContain('mixer.setCrossfader')
  })

  it('does not pause the active deck when the ramp fails, and rolls back', async () => {
    const client = new FakeClient((command) => {
      if (command === 'deck.load') return { type: 'complete', result: LOAD_RESULT }
      if (command === 'deck.sync') return { type: 'complete', result: SYNC_RESULT }
      if (command === 'transition.start') return { type: 'fail', error: ERR('E_QUANTIZE_UNAVAILABLE'), result: RAMP_RESULT }
      return { type: 'complete' }
    })
    const result = await new TransitionExecutor(client).run(PLAN)

    expect(result).toMatchObject({ status: 'failed', stage: 'start', rolledBack: true })
    // No pause of the ACTIVE deck A; rollback pauses target B and returns the fader to A (-1).
    const pauses = client.calls.filter((call) => call.command === 'deck.pause')
    expect(pauses.every((call) => (call.params as { deckId: string }).deckId === 'B')).toBe(true)
    expect(pauses[0]?.options).toEqual({ expectedBindingId: 'bind-next', expectedRevision: 1 })
    const reset = client.calls.find((call) => call.command === 'mixer.setCrossfader')
    expect((reset?.params as { position: number }).position).toBe(-1)
    expect(reset?.options).toEqual({ expectedRevision: 1 })
  })

  it('yields (cancelled) without fighting the user when the ramp is user-overridden', async () => {
    const client = new FakeClient((command) => {
      if (command === 'deck.load') return { type: 'complete', result: LOAD_RESULT }
      if (command === 'deck.sync') return { type: 'complete', result: SYNC_RESULT }
      if (command === 'transition.start') return { type: 'cancel', reason: 'userOverride', result: RAMP_RESULT }
      return { type: 'complete' }
    })
    const result = await new TransitionExecutor(client).run(PLAN)

    expect(result).toEqual({ status: 'cancelled', stage: 'start', reason: 'userOverride' })
    // Yielding means: do not force the crossfader back and do not pause the active deck.
    expect(client.commands()).not.toContain('mixer.setCrossfader')
    expect(client.calls.some((call) => call.command === 'deck.pause' && (call.params as { deckId: string }).deckId === 'A')).toBe(false)
  })

  it('reports a load failure without touching the active deck (no rollback needed)', async () => {
    const client = new FakeClient((command) =>
      command === 'deck.load' ? { type: 'fail', error: ERR('E_ANALYSIS_UNAVAILABLE') } : { type: 'complete' },
    )
    const result = await new TransitionExecutor(client).run(PLAN)

    expect(result).toMatchObject({ status: 'failed', stage: 'load', rolledBack: false })
    expect(client.commands()).toEqual(['deck.load'])
  })

  it('does not pause the active deck after any post-transition revision change', async () => {
    const client = new FakeClient((command, callIndex) => {
      if (command === 'deck.load') return { type: 'complete', result: LOAD_RESULT }
      if (command === 'deck.sync') return { type: 'complete', result: SYNC_RESULT }
      if (command === 'transition.start') return { type: 'complete', result: RAMP_RESULT }
      if (command === 'deck.pause' && callIndex === 3) return { type: 'reject', error: ERR('E_STALE_REVISION') }
      return { type: 'complete' }
    })
    const result = await new TransitionExecutor(client).run(PLAN)
    expect(result).toMatchObject({ status: 'failed', stage: 'pauseActive', error: { code: 'E_STALE_REVISION' }, rolledBack: false })
  })

  it('rolls back and reports the stage when the atomic reservation fails', async () => {
    const client = new FakeClient((command) => {
      if (command === 'deck.load') return { type: 'complete', result: LOAD_RESULT }
      if (command === 'deck.sync') return { type: 'complete', result: SYNC_RESULT }
      if (command === 'transition.start') return { type: 'fail', error: ERR('E_QUANTIZE_UNAVAILABLE') }
      return { type: 'complete' }
    })
    const result = await new TransitionExecutor(client).run(PLAN)

    expect(result).toMatchObject({ status: 'failed', stage: 'start', rolledBack: true })
    expect(client.commands()).not.toContain('deck.play')
    expect(client.commands()).not.toContain('mixer.rampCrossfader')
  })

  it('rejects a plan whose decks are identical instead of proceeding', async () => {
    const client = new FakeClient(happyResponder())
    const result = await new TransitionExecutor(client).run({ ...PLAN, targetDeckId: 'A' })
    expect(result).toMatchObject({ status: 'failed', stage: 'load', rolledBack: false })
    expect(client.calls).toHaveLength(0)
  })
})
