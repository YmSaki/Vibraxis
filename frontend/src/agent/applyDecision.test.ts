import { describe, expect, it, vi } from 'vitest'
import { captureApplySnapshot, evaluateApply, instrumentTransitionClient } from './applyDecision'
import { runtimeState } from './fixtures'
import type { RuntimeState } from '@vibraxis/shared/vdap'
import type { DjContext, DjDecision } from './contract'
import type { MutationHandle, IntentTerminalEvent } from '../runtime/VdapClient'
import type { TransitionClient } from '../runtime/transition/TransitionExecutor'

const context = {
  activeDeckId: 'A',
  inactiveDeckId: 'B',
  currentTrack: { trackId: 'cur' },
  candidates: [{ trackId: 'next-a' }, { trackId: 'next-b' }],
} as unknown as DjContext

/** Snapshot taken from the SAME state (decision time == apply time). */
const snap = (rs: RuntimeState) => captureApplySnapshot(context, rs)

const decision: DjDecision = {
  nextTrackId: 'next-a',
  targetDeckId: 'B',
  tempoSync: 'tempo',
  startAt: 'nextBar',
  crossfadeBars: 8,
  confidence: 0.9,
  reasons: ['select:next-a'],
}

describe('evaluateApply', () => {
  it('builds a plan bound to the live active-deck binding when ready', () => {
    const rs = runtimeState({ playing: true, trackId: 'cur', bindingId: 'bind-A' }, {})
    const result = evaluateApply(decision, context, rs, snap(rs))
    expect(result.status).toBe('ready')
    if (result.status !== 'ready') return
    expect(result.plan).toMatchObject({
      fromTrackId: 'cur',
      fromBindingId: 'bind-A',
      expectedRevision: 5,
      targetBindingId: null,
      activeDeckId: 'A',
      nextTrackId: 'next-a',
      targetDeckId: 'B',
      crossfadeBars: 8,
    })
  })

  it('blocks when the decision targets the wrong deck', () => {
    const rs = runtimeState({ playing: true, trackId: 'cur' }, {})
    const result = evaluateApply({ ...decision, targetDeckId: 'A' }, context, rs, snap(rs))
    expect(result).toMatchObject({ status: 'blocked', reason: { code: 'targetDeckMismatch' } })
  })

  it('blocks when next track is not among candidates', () => {
    const rs = runtimeState({ playing: true, trackId: 'cur' }, {})
    const result = evaluateApply({ ...decision, nextTrackId: 'ghost' }, context, rs, snap(rs))
    expect(result).toMatchObject({ status: 'blocked', reason: { code: 'nextTrackNotCandidate' } })
  })

  it('blocks when the active deck binding vanished', () => {
    const rs = runtimeState({ playing: true, trackId: null }, {})
    const result = evaluateApply(decision, context, rs, snap(rs))
    expect(result).toMatchObject({ status: 'blocked', reason: { code: 'activeBindingMissing' } })
  })

  it('blocks (stale) when the active deck now holds a different track', () => {
    const rs = runtimeState({ playing: true, trackId: 'someone-else' }, {})
    const result = evaluateApply(decision, context, rs, snap(rs))
    expect(result).toMatchObject({ status: 'blocked', reason: { code: 'staleActiveTrack' } })
  })

  it('blocks when the active deck stopped playing', () => {
    const rs = runtimeState({ playing: false, trackId: 'cur' }, {})
    const result = evaluateApply(decision, context, rs, snap(rs))
    expect(result).toMatchObject({ status: 'blocked', reason: { code: 'activeDeckNotPlaying' } })
  })

  it('blocks when the active deck has no usable beat grid', () => {
    const rs = runtimeState({ playing: true, trackId: 'cur', gridAvailable: false }, {})
    const result = evaluateApply(decision, context, rs, snap(rs))
    expect(result).toMatchObject({ status: 'blocked', reason: { code: 'noBeatGrid' } })
  })

  it('blocks when the target deck is loading', () => {
    const rs = runtimeState({ playing: true, trackId: 'cur' }, { loading: true })
    const result = evaluateApply(decision, context, rs, snap(rs))
    expect(result).toMatchObject({ status: 'blocked', reason: { code: 'targetDeckBusy' } })
  })

  it('blocks when the target deck started playing after the decision', () => {
    const rs = runtimeState({ playing: true, trackId: 'cur' }, { playing: true, trackId: 'next-b' })
    const result = evaluateApply(decision, context, rs, snap(rs))
    expect(result).toMatchObject({ status: 'blocked', reason: { code: 'targetDeckBusy' } })
  })

  it('blocks (activeBindingChanged) when the same track is reloaded on the active deck (new bindingId)', () => {
    // Decision was made against binding bind-A1; the user re-dropped the same
    // track, so it now holds bind-A2. Same trackId, different binding => stale.
    const decisionRs = runtimeState({ playing: true, trackId: 'cur', bindingId: 'bind-A1' }, {})
    const applyRs = runtimeState({ playing: true, trackId: 'cur', bindingId: 'bind-A2' }, {})
    const result = evaluateApply(decision, context, applyRs, snap(decisionRs))
    expect(result).toMatchObject({ status: 'blocked', reason: { code: 'activeBindingChanged' } })
  })

  it('blocks when active effective tempo changes after the decision', () => {
    const decisionRs = runtimeState({ playing: true, trackId: 'cur', effectiveBpm: 120 }, {})
    const applyRs = runtimeState({ playing: true, trackId: 'cur', effectiveBpm: 132 }, {})
    const result = evaluateApply(decision, context, applyRs, snap(decisionRs))
    expect(result).toMatchObject({ status: 'blocked', reason: { code: 'activeDeckChanged' } })
  })

  it('does not adopt a fresh live bindingId — the plan binds to the decision-time binding', () => {
    const rs = runtimeState({ playing: true, trackId: 'cur', bindingId: 'bind-A1' }, {})
    const result = evaluateApply(decision, context, rs, snap(rs))
    expect(result.status).toBe('ready')
    if (result.status !== 'ready') return
    expect(result.plan.fromBindingId).toBe('bind-A1')
  })

  it('blocks (inactiveDeckChanged) when the user loaded another track on the target deck after the decision', () => {
    // At decision time the inactive deck was empty; by apply time the user
    // loaded next-b (ready) onto it — honouring the plan would overwrite it.
    const decisionRs = runtimeState({ playing: true, trackId: 'cur' }, {})
    const applyRs = runtimeState({ playing: true, trackId: 'cur' }, { trackId: 'next-b' })
    const result = evaluateApply(decision, context, applyRs, snap(decisionRs))
    expect(result).toMatchObject({ status: 'blocked', reason: { code: 'inactiveDeckChanged' } })
  })
})

function completedHandle(): MutationHandle {
  const event: IntentTerminalEvent = {
    vdap: '1.0',
    kind: 'event',
    event: 'intent.completed',
    revision: 9,
    runtimeTime: 1,
    intentId: 'i1',
    requestId: 'r1',
    result: {},
  }
  return {
    ack: { vdap: '1.0', kind: 'ack', requestId: 'r1', state: 'accepted', intentId: 'i1', revision: 9 },
    terminal: Promise.resolve(event),
  }
}

function failedHandle(): MutationHandle {
  const event: IntentTerminalEvent = {
    vdap: '1.0',
    kind: 'event',
    event: 'intent.failed',
    revision: 9,
    runtimeTime: 1,
    intentId: 'i1',
    requestId: 'r1',
    error: { code: 'E_INTERNAL', message: 'boom', retryable: false },
  }
  return { ack: {} as MutationHandle['ack'], terminal: Promise.resolve(event) }
}

describe('instrumentTransitionClient', () => {
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

  it('fires synced only after deck.sync actually completes, and forwards args unchanged', async () => {
    const inner: TransitionClient = { mutate: vi.fn(async () => completedHandle()) }
    const milestones: unknown[] = []
    const wrapped = instrumentTransitionClient(inner, (m) => milestones.push(m))
    await wrapped.mutate('deck.sync', { deckId: 'B', reference: 'A', mode: 'tempo' }, { expectedBindingId: 'bind-B' })
    await flush()
    expect(milestones).toEqual([{ type: 'synced' }])
    expect(inner.mutate).toHaveBeenCalledWith('deck.sync', { deckId: 'B', reference: 'A', mode: 'tempo' }, { expectedBindingId: 'bind-B' })
  })

  it('publishes the accepted transition intent id without claiming terminal completion as MIXING', async () => {
    const inner: TransitionClient = { mutate: vi.fn(async () => completedHandle()) }
    const milestones: unknown[] = []
    const wrapped = instrumentTransitionClient(inner, (m) => milestones.push(m))
    await wrapped.mutate('transition.start', {} as never)
    await flush()
    expect(milestones).toEqual([{ type: 'transitionAccepted', intentId: 'i1' }])
  })

  it('never fires for unrelated commands', async () => {
    const inner: TransitionClient = { mutate: vi.fn(async () => completedHandle()) }
    const milestones: unknown[] = []
    const wrapped = instrumentTransitionClient(inner, (m) => milestones.push(m))
    await wrapped.mutate('deck.load', {} as never)
    await flush()
    expect(milestones).toEqual([])
  })

  it('does not fire a milestone when the step failed', async () => {
    const inner: TransitionClient = { mutate: vi.fn(async () => failedHandle()) }
    const milestones: unknown[] = []
    const wrapped = instrumentTransitionClient(inner, (m) => milestones.push(m))
    await wrapped.mutate('deck.sync', {} as never)
    await flush()
    expect(milestones).toEqual([])
  })
})
