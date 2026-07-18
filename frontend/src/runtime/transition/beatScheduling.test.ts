import { describe, expect, it } from 'vitest'
import {
  VDAP_VERSION,
  type PositionPair,
  type TrackBinding,
} from '@vibraxis/shared/vdap'
import { CommandDispatcher, type SchedulerTimerHandle, type SchedulerTimers } from '../CommandDispatcher'
import type {
  RuntimeRequestContext,
  RuntimeRequestEnvelope,
  VdapOutboundMessage,
} from '../MessagePortTransport'
import type { BeatTransitionAudioSpec, CrossfaderRampSpec, RuntimeAudioPort } from '../RuntimeAudioPort'
import { RuntimeStore } from '../RuntimeStore'

/** Deterministic timers keyed to the injected clock; fired by advanceTo(). */
class FakeTimers implements SchedulerTimers {
  private readonly tasks = new Map<number, { fireAt: number; cb: () => void }>()
  private seq = 0
  constructor(private readonly now: () => number) {}
  setTimer(cb: () => void, delayMs: number): SchedulerTimerHandle {
    const id = ++this.seq
    this.tasks.set(id, { fireAt: this.now() + delayMs / 1000, cb })
    return id as unknown as SchedulerTimerHandle
  }
  clearTimer(handle: SchedulerTimerHandle): void {
    this.tasks.delete(handle as unknown as number)
  }
  pending(): number {
    return this.tasks.size
  }
  async advanceTo(t: number, setClock: (value: number) => void): Promise<void> {
    for (let guard = 0; guard < 1000; guard += 1) {
      const due = [...this.tasks.entries()]
        .filter(([, task]) => task.fireAt <= t)
        .sort((a, b) => a[1].fireAt - b[1].fireAt)
      if (due.length === 0) break
      const [id, task] = due[0]
      this.tasks.delete(id)
      setClock(task.fireAt)
      task.cb()
      await flush()
    }
    setClock(t)
  }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

const pos = (sourceSeconds: number, atRuntimeTime: number): PositionPair => ({ sourceSeconds, atRuntimeTime })

function binding(bindingId: string, bpm = 120): TrackBinding {
  return {
    bindingId,
    trackId: `track-${bindingId}`,
    source: { kind: 'catalog', uri: `/tracks/${bindingId}.mp3`, title: bindingId },
    sha256: null,
    durationSeconds: 180,
    analysis: {
      analysisRef: `data/analysis/${bindingId}.json`,
      schemaVersion: 2,
      bpm,
      timeSignature: '4/4',
      beatsPerBar: 4,
      firstDownbeatSeconds: 0,
      beatCount: 360,
      barCount: 90,
      key: 'C',
      scale: 'major',
      camelot: '8B',
      energy: 0.5,
      grid: { available: true, confidence: 0.8, status: 'complete' },
    },
  }
}

function makeAudio(now: () => number) {
  const played: Array<{ deckId: string; at: number }> = []
  const ramps: CrossfaderRampSpec[] = []
  const stops: number[] = []
  let lastVelocity: { deckId: string; velocity: number } | null = null
  const transitions: BeatTransitionAudioSpec[] = []
  let resolveTransitionStart: ((position: PositionPair) => void) | null = null
  let resolveTransitionComplete: ((value: { endedAtRuntimeTime: number; targetPosition: PositionPair }) => void) | null = null
  let transitionCancelled = false
  const audio: RuntimeAudioPort = {
    load: async () => ({ binding: binding('loaded'), position: pos(0, now()) }),
    unload: async () => undefined,
    play: async (deckId) => pos(0, now()),
    pause: async () => pos(12, now()),
    seek: async () => pos(0, now()),
    setGain: async () => undefined,
    setEq: async () => undefined,
    setVelocity: async (deckId, velocity) => {
      lastVelocity = { deckId, velocity }
      return pos(0, now())
    },
    setCrossfader: async () => undefined,
    setMasterGain: async () => undefined,
    panic: async () => ({ A: pos(12, now()), B: pos(0, now()) }),
    playAt: async (deckId, at) => {
      played.push({ deckId, at })
      return pos(0, now())
    },
    scheduleCrossfaderRamp: async (spec) => {
      ramps.push(spec)
    },
    stopCrossfaderRamp: async (holdPosition) => {
      stops.push(holdPosition)
    },
    getGrid: () => ({
      timeSignature: '4/4',
      beatsPerBar: 4,
      bpm: 120,
      confidence: 0.8,
      // 120 BPM 4/4: beats every 0.5 s, downbeats every 2 s.
      beatsSeconds: Array.from({ length: 64 }, (_, i) => i * 0.5),
      downbeatsSeconds: Array.from({ length: 16 }, (_, i) => i * 2),
      barsSeconds: Array.from({ length: 16 }, (_, i) => i * 2),
      sections: [],
      phrases: [],
    }),
    minimumTransitionLeadSeconds: 0.05,
    scheduleBeatTransition: async (spec) => {
      transitions.push(spec)
      transitionCancelled = false
      const started = new Promise<PositionPair>((resolve) => { resolveTransitionStart = resolve })
      const completed = new Promise<{ endedAtRuntimeTime: number; targetPosition: PositionPair }>((resolve) => {
        resolveTransitionComplete = resolve
      })
      return {
        started,
        completed,
        sample: () => {
          const elapsed = now() <= spec.startAtRuntimeTime
            ? 0
            : Math.min(spec.durationSeconds, now() - spec.startAtRuntimeTime)
          const fraction = elapsed / spec.durationSeconds
          return {
            targetPosition: pos(elapsed, now()),
            holdPosition: spec.from + (spec.to - spec.from) * fraction,
            progressedDurationSeconds: elapsed,
          }
        },
        cancel: () => {
          transitionCancelled = true
          return { targetPosition: pos(0, now()), holdPosition: spec.from, progressedDurationSeconds: 0 }
        },
      }
    },
  }
  return Object.assign(audio, {
    played, ramps, stops, transitions,
    velocity: () => lastVelocity,
    transitionCancelled: () => transitionCancelled,
    startTransition: () => resolveTransitionStart?.(pos(0, now())),
    completeTransition: () => resolveTransitionComplete?.({ endedAtRuntimeTime: now(), targetPosition: pos(8, now()) }),
  })
}

function setup(startClock = 100) {
  let clock = startClock
  const now = () => clock
  const setClock = (value: number) => {
    clock = value
  }
  const timers = new FakeTimers(now)
  const store = new RuntimeStore({ runtimeTimeProvider: now })
  const audio = makeAudio(now)
  let seq = 0
  const dispatcher = new CommandDispatcher({ store, audio, now, timers, nextIntentId: () => `it-${++seq}` })
  const sent: VdapOutboundMessage[] = []
  const agentSent: VdapOutboundMessage[] = []
  const ui: RuntimeRequestContext = { connectionId: 'ui', role: 'ui', origin: 'user', send: (m) => (sent.push(m), true) }
  const agent: RuntimeRequestContext = { connectionId: 'agent', role: 'agent', origin: 'agent', send: (m) => (agentSent.push(m), true) }
  return { store, audio, timers, dispatcher, sent, agentSent, ui, agent, now, setClock, advance: (t: number) => timers.advanceTo(t, setClock) }
}

/** Deck A playing forward at 1x, head at sourceSeconds `head` as of the clock. */
function bindPlayingA(store: RuntimeStore, now: () => number, head = 1): void {
  store.update((draft) => {
    draft.decks.A.binding = binding('bind-A')
    draft.decks.A.transport.phase = 'playing'
    draft.decks.A.playback.position = pos(head, now())
    draft.decks.A.playback.baseVelocity = 1
    draft.decks.A.playback.configuredVelocity = 1
    draft.decks.A.playback.headVelocity = 1
    draft.decks.A.playback.direction = 'forward'
    draft.decks.A.tempo.baseBpm = 120
    draft.decks.A.tempo.interpretedBpm = 120
    draft.decks.A.tempo.effectiveBpm = 120
  })
}

function bindReadyB(store: RuntimeStore, now: () => number, bpm = 90): void {
  store.update((draft) => {
    draft.decks.B.binding = binding('bind-B', bpm)
    draft.decks.B.transport.phase = 'ready'
    draft.decks.B.playback.position = pos(0, now())
    draft.decks.B.tempo.baseBpm = bpm
    draft.decks.B.tempo.interpretedBpm = bpm
    draft.decks.B.tempo.effectiveBpm = bpm
  })
}

function request(requestId: string, command: string, params: Record<string, unknown> = {}, extra: Partial<RuntimeRequestEnvelope> = {}): RuntimeRequestEnvelope {
  return { vdap: VDAP_VERSION, kind: 'request', requestId, command, params, ...extra }
}

function messages(result: Awaited<ReturnType<CommandDispatcher['handle']>>): VdapOutboundMessage[] {
  if (!result) return []
  return Array.isArray(result) ? [...result] : [result as VdapOutboundMessage]
}

describe('beat scheduling — deck.play @nextBar', () => {
  it('reserves the exact next downbeat and starts the deck at that boundary', async () => {
    const s = setup(100)
    bindPlayingA(s.store, s.now, 1) // head at 1.0s → next downbeat at 2.0s → boundary at t=101
    bindReadyB(s.store, s.now)

    await s.dispatcher.handle(
      request('r1', 'deck.play', { deckId: 'B' }, { when: { at: 'nextBar', deckId: 'A' } }),
      s.agent,
    )
    const ack = s.agentSent.at(-1)
    expect(ack).toMatchObject({ state: 'accepted', scheduledFor: { runtimeTime: 101, estimate: true } })
    expect(s.store.getSnapshot().decks.B.transport.phase).toBe('ready')

    await s.advance(101)
    expect(s.audio.played).toEqual([{ deckId: 'B', at: 101 }])
    expect(s.store.getSnapshot().decks.B.transport.phase).toBe('playing')
    expect(s.agentSent.at(-1)).toMatchObject({ event: 'intent.completed', requestId: 'r1' })
  })

  it('fails a scheduled start with notAdvancing when the reference deck pauses first', async () => {
    const s = setup(100)
    bindPlayingA(s.store, s.now, 1)
    bindReadyB(s.store, s.now)
    await s.dispatcher.handle(
      request('r1', 'deck.play', { deckId: 'B' }, { when: { at: 'nextBar', deckId: 'A' } }),
      s.agent,
    )
    // User pauses the reference deck before the boundary.
    await s.dispatcher.handle(request('r2', 'deck.pause', { deckId: 'A' }), s.ui)

    const failed = s.agentSent.find((m) => 'event' in m && m.event === 'intent.failed')
    expect(failed).toMatchObject({ event: 'intent.failed', error: { code: 'E_QUANTIZE_UNAVAILABLE', reason: 'notAdvancing' } })
    expect(s.audio.played).toHaveLength(0)
    expect(s.timers.pending()).toBe(0)
  })

  it('cancels a scheduled start (bindingChanged) and stops the timer when the REFERENCE deck is reloaded (finding 5)', async () => {
    const s = setup(100)
    bindPlayingA(s.store, s.now, 1) // reference deck A, boundary at t=101
    bindReadyB(s.store, s.now)
    await s.dispatcher.handle(
      request('r1', 'deck.play', { deckId: 'B' }, { when: { at: 'nextBar', deckId: 'A' } }),
      s.agent,
    )
    expect(s.timers.pending()).toBe(1)
    // The user reloads the REFERENCE deck A before the boundary: its grid is now a
    // different track, so the schedule reserved against it must be invalidated.
    await s.dispatcher.handle(
      request('rL', 'deck.load', { deckId: 'A', source: { kind: 'catalog', trackId: 'track-new' } }),
      s.ui,
    )
    const cancelled = s.agentSent.find((m) => 'event' in m && m.event === 'intent.cancelled')
    expect(cancelled).toMatchObject({ event: 'intent.cancelled', requestId: 'r1', reason: 'bindingChanged' })
    expect(s.audio.played).toHaveLength(0)
    expect(s.timers.pending()).toBe(0)
  })

  it('rejects musical scheduling with E_CAPABILITY_REQUIRED when the adapter cannot queue it', async () => {
    const s = setup(100)
    bindPlayingA(s.store, s.now, 1)
    bindReadyB(s.store, s.now)
    // A dispatcher whose audio port lacks scheduled methods must not advertise or accept musical when.
    const bare = new CommandDispatcher({
      store: s.store,
      now: s.now,
      audio: { ...s.audio, playAt: undefined, scheduleCrossfaderRamp: undefined, stopCrossfaderRamp: undefined },
    })
    const result = await bare.handle(
      request('r1', 'deck.play', { deckId: 'B' }, { when: { at: 'nextBar', deckId: 'A' } }),
      s.agent,
    )
    expect(messages(result)[0]).toMatchObject({ state: 'rejected', error: { code: 'E_CAPABILITY_REQUIRED' } })
  })
})

describe('deck.sync — tempo only', () => {
  it('applies the exact playback rate when in range', async () => {
    const s = setup(100)
    bindPlayingA(s.store, s.now, 1) // A effectiveBpm 120
    bindReadyB(s.store, s.now, 120) // B interpretedBpm 120 → velocity 1.0 exact
    const result = await s.dispatcher.handle(request('r1', 'deck.sync', { deckId: 'B', reference: 'A', mode: 'tempo' }), s.ui)
    const terminal = messages(result).find((m) => 'event' in m && m.event === 'intent.completed')
    expect(terminal).toMatchObject({ result: { appliedVelocity: 1, targetBpm: 120, exact: true } })
    expect(s.store.getSnapshot().decks.B.playback.baseVelocity).toBe(1)
  })

  it('rejects an out-of-range rate with E_OUT_OF_RANGE and leaves audio/state unchanged (§11.11, AGENTS §0.6)', async () => {
    const s = setup(100)
    bindPlayingA(s.store, s.now, 1) // 120
    bindReadyB(s.store, s.now, 70) // needs 120/70 ≈ 1.714x → outside [0.5, 1.5]
    const before = s.store.getSnapshot().decks.B.playback.baseVelocity
    const result = await s.dispatcher.handle(request('r1', 'deck.sync', { deckId: 'B', reference: 'A', mode: 'tempo' }), s.ui)
    // Rejected without accepting an intent: no clamp, no audio call, no state change.
    expect(messages(result)[0]).toMatchObject({ state: 'rejected', error: { code: 'E_OUT_OF_RANGE' } })
    expect(messages(result).some((m) => 'event' in m)).toBe(false)
    expect(s.audio.velocity()).toBeNull()
    expect(s.store.getSnapshot().decks.B.playback.baseVelocity).toBe(before)
  })

  it('rejects tempoPhase/tempoBar rather than silently downgrading', async () => {
    const s = setup(100)
    bindPlayingA(s.store, s.now, 1)
    bindReadyB(s.store, s.now, 120)
    const result = await s.dispatcher.handle(request('r1', 'deck.sync', { deckId: 'B', reference: 'A', mode: 'tempoBar' }), s.ui)
    expect(messages(result)[0]).toMatchObject({ state: 'rejected', error: { code: 'E_CAPABILITY_REQUIRED' } })
  })
})

describe('mixer.rampCrossfader', () => {
  it('runs an immediate equal-power ramp and completes with the terminal result', async () => {
    const s = setup(100)
    bindPlayingA(s.store, s.now, 1)
    await s.dispatcher.handle(
      request('r1', 'mixer.setCrossfader', { position: -1 }),
      s.ui,
    )
    await s.dispatcher.handle(
      request('r2', 'mixer.rampCrossfader', { to: 1, duration: { seconds: 8 }, curve: 'equalPower' }),
      s.agent,
    )
    const automation = s.store.getSnapshot().mixer.crossfader.automation
    expect(automation).toMatchObject({ from: -1, to: 1, startedAtRuntimeTime: 100, durationSecondsEstimate: 8 })
    expect(s.audio.ramps).toEqual([{ from: -1, to: 1, startAtRuntimeTime: 100, durationSeconds: 8, curve: 'equalPower' }])

    await s.advance(108)
    const terminal = s.agentSent.find((m) => 'event' in m && m.event === 'intent.completed') as { result: { durationSeconds: number; to: number } }
    expect(terminal).toMatchObject({ result: { from: -1, to: 1, startedAtRuntimeTime: 100, endedAtRuntimeTime: 108, durationSeconds: 8 } })
    const mixer = s.store.getSnapshot().mixer.crossfader
    expect(mixer.effective).toBe(1)
    expect(mixer.automation).toBeNull()
  })

  it('derives ramp duration from the reference tempo for a bars duration', async () => {
    const s = setup(100)
    bindPlayingA(s.store, s.now, 1) // 120 BPM → 4 bars = 16 beats = 8 s
    await s.dispatcher.handle(
      request('r1', 'mixer.rampCrossfader', { to: 1, duration: { bars: 4 }, curve: 'equalPower', referenceDeckId: 'A' }),
      s.agent,
    )
    expect(s.audio.ramps[0].durationSeconds).toBeCloseTo(8, 6)
  })

  it('cancels an in-flight agent ramp on a user crossfader override, with the ramp result attached', async () => {
    const s = setup(100)
    bindPlayingA(s.store, s.now, 1)
    await s.dispatcher.handle(request('r0', 'mixer.setCrossfader', { position: -1 }), s.ui)
    await s.dispatcher.handle(
      request('r1', 'mixer.rampCrossfader', { to: 1, duration: { seconds: 8 }, curve: 'equalPower' }),
      s.agent,
    )
    // Halfway through, the user grabs the crossfader.
    s.setClock(104)
    await s.dispatcher.handle(request('r2', 'mixer.setCrossfader', { position: -0.2 }), s.ui)

    const cancelled = s.agentSent.find((m) => 'event' in m && m.event === 'intent.cancelled') as { reason: string; result?: { from: number; to: number } }
    expect(cancelled).toMatchObject({ reason: 'userOverride' })
    expect(cancelled.result).toMatchObject({ from: -1, to: 1, startedAtRuntimeTime: 100 })
    expect(s.audio.stops.length).toBe(1) // audio automation was stopped, not jumped to `to`
    expect(s.store.getSnapshot().mixer.crossfader).toMatchObject({ base: -0.2, effective: -0.2, automation: null })
  })

  it('cancels a scheduled ramp before it starts (startedAtRuntimeTime:null, durationSeconds:0)', async () => {
    const s = setup(100)
    bindPlayingA(s.store, s.now, 1) // boundary at t=101
    await s.dispatcher.handle(
      request('r1', 'mixer.rampCrossfader', { to: 1, duration: { seconds: 8 }, curve: 'equalPower', referenceDeckId: 'A' }, { when: { at: 'nextBar', deckId: 'A' } }),
      s.agent,
    )
    expect(s.agentSent.at(-1)).toMatchObject({ state: 'accepted', scheduledFor: { runtimeTime: 101 } })
    await s.dispatcher.handle(request('r2', 'schedule.cancel', { filter: { all: true } }), s.agent)

    const cancelled = s.agentSent.find((m) => 'event' in m && m.event === 'intent.cancelled') as { result?: { startedAtRuntimeTime: number | null; durationSeconds: number } }
    expect(cancelled.result).toMatchObject({ startedAtRuntimeTime: null, durationSeconds: 0 })
    expect(s.audio.ramps).toHaveLength(0)
    expect(s.timers.pending()).toBe(0)
  })
})

describe('transition.start — atomic Web Audio reservation', () => {
  const params = {
    activeDeckId: 'A', activeBindingId: 'bind-A',
    targetDeckId: 'B', targetBindingId: 'bind-B',
    at: 'nextBar',
    crossfader: { to: 1, duration: { bars: 4 }, curve: 'equalPower' },
  }

  it('resolves one boundary and reserves target play plus ramp in one audio call', async () => {
    const s = setup(100)
    bindPlayingA(s.store, s.now, 1)
    bindReadyB(s.store, s.now, 120)

    await s.dispatcher.handle(request('tr1', 'transition.start', params), s.agent)
    expect(s.agentSent.at(-1)).toMatchObject({ state: 'accepted', scheduledFor: { runtimeTime: 101, estimate: false } })
    expect(s.audio.transitions).toEqual([{
      targetDeckId: 'B', from: 0, to: 1,
      startAtRuntimeTime: 101, durationSeconds: 8, curve: 'equalPower',
    }])
    expect(s.audio.played).toHaveLength(0)
    expect(s.audio.ramps).toHaveLength(0)

    s.setClock(101)
    s.audio.startTransition()
    await flush()
    expect(s.store.getSnapshot().decks.B.transport.phase).toBe('playing')
    expect(s.store.getSnapshot().mixer.crossfader.automation).toMatchObject({ from: 0, to: 1 })

    await s.advance(105)
    expect(s.store.getSnapshot().mixer.crossfader.effective).toBeCloseTo(0.5, 6)
    expect(s.store.getSnapshot().decks.B.playback.position.sourceSeconds).toBeCloseTo(4, 6)

    s.setClock(109)
    s.audio.completeTransition()
    await flush()
    const completed = s.agentSent.find((message) => 'event' in message && message.event === 'intent.completed')
    expect(completed).toMatchObject({ result: { targetDeckId: 'B', targetBindingId: 'bind-B', durationSeconds: 8 } })
    expect(s.store.getSnapshot().mixer.crossfader).toMatchObject({ effective: 1, automation: null })
  })

  it('rejects a boundary that lacks the published scheduling lead without changing audio', async () => {
    const s = setup(100)
    bindPlayingA(s.store, s.now, 1.99)
    bindReadyB(s.store, s.now, 120)

    const result = await s.dispatcher.handle(request('tr1', 'transition.start', params), s.agent)
    expect(messages(result)[0]).toMatchObject({ state: 'rejected', error: { code: 'E_SCHEDULE_TOO_SOON' } })
    expect(s.audio.transitions).toHaveLength(0)
    expect(s.store.getSnapshot().decks.B.transport.phase).toBe('ready')
  })

  it('does not complete while only the wall clock advances', async () => {
    const s = setup(100)
    bindPlayingA(s.store, s.now, 1)
    bindReadyB(s.store, s.now, 120)
    await s.dispatcher.handle(request('tr1', 'transition.start', params), s.agent)

    await s.advance(120)
    expect(s.agentSent.some((message) => 'event' in message && message.event === 'intent.completed')).toBe(false)
    expect(s.store.getSnapshot().decks.B.transport.phase).toBe('ready')
  })

  it('cancels the single audio reservation on user crossfader override', async () => {
    const s = setup(100)
    bindPlayingA(s.store, s.now, 1)
    bindReadyB(s.store, s.now, 120)
    await s.dispatcher.handle(request('tr1', 'transition.start', params), s.agent)

    await s.dispatcher.handle(request('ui1', 'mixer.setCrossfader', { position: -0.25 }), s.ui)
    expect(s.audio.transitionCancelled()).toBe(true)
    expect(s.agentSent.find((message) => 'event' in message && message.event === 'intent.cancelled')).toMatchObject({
      reason: 'userOverride',
    })
    expect(s.store.getSnapshot().mixer.crossfader).toMatchObject({ effective: -0.25, automation: null })
  })

  it('cancels instead of moving the reservation to a replacement reference binding', async () => {
    const s = setup(100)
    bindPlayingA(s.store, s.now, 1)
    bindReadyB(s.store, s.now, 120)
    await s.dispatcher.handle(request('tr1', 'transition.start', params), s.agent)

    await s.dispatcher.handle(request(
      'ui-load',
      'deck.load',
      { deckId: 'A', source: { kind: 'catalog', trackId: 'replacement' }, replacePlaying: true },
      { expectedBindingId: 'bind-A' },
    ), s.ui)
    expect(s.audio.transitionCancelled()).toBe(true)
    expect(s.agentSent.find((message) => 'event' in message && message.event === 'intent.cancelled')).toMatchObject({
      reason: 'bindingChanged',
    })
  })
})
