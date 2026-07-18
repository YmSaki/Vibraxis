import { describe, expect, it, vi } from 'vitest'
import {
  VDAP_VERSION,
  type PositionPair,
  type TrackBinding,
} from '@vibraxis/shared/vdap'
import { CommandDispatcher } from './CommandDispatcher'
import type {
  RuntimeRequestContext,
  RuntimeRequestEnvelope,
  VdapOutboundMessage,
} from './MessagePortTransport'
import { RuntimeAudioError, type RuntimeAudioPort } from './RuntimeAudioPort'
import { RuntimeStore } from './RuntimeStore'

const position = (sourceSeconds: number): PositionPair => ({
  sourceSeconds,
  atRuntimeTime: 10,
})

function binding(bindingId = 'bind-1'): TrackBinding {
  return {
    bindingId,
    trackId: 'track-1',
    source: { kind: 'catalog', uri: '/tracks/track-1.mp3', title: 'Track 1' },
    sha256: 'a'.repeat(64),
    durationSeconds: 180,
    analysis: {
      analysisRef: 'data/analysis/track-1.json',
      schemaVersion: 2,
      bpm: 120,
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

function audioPort(): RuntimeAudioPort {
  return {
    load: vi.fn(async () => ({ binding: binding(), position: position(0) })),
    unload: vi.fn(async () => undefined),
    play: vi.fn(async () => position(0)),
    pause: vi.fn(async () => position(12)),
    seek: vi.fn(async (_deckId, request) =>
      position(request.target.type === 'sourceSeconds' ? request.target.sourceSeconds : 16)),
    setGain: vi.fn(async () => undefined),
    setEq: vi.fn(async () => undefined),
    setVelocity: vi.fn(async () => position(8)),
    setCrossfader: vi.fn(async () => undefined),
    setMasterGain: vi.fn(async () => undefined),
    panic: vi.fn(async () => ({ A: position(12), B: position(0) })),
    getGrid: vi.fn(() => ({
      timeSignature: '4/4',
      beatsPerBar: 4,
      bpm: 120,
      confidence: 0.8,
      beatsSeconds: [0, 0.5, 1, 1.5],
      downbeatsSeconds: [0],
      barsSeconds: [0],
      sections: [],
      phrases: [],
      chords: [{ startSeconds: 0, endSeconds: 2, symbol: 'C', degree: 'I', confidence: 0.6 }],
    })),
  }
}

function setup() {
  let runtimeTime = 0
  const store = new RuntimeStore({ runtimeTimeProvider: () => ++runtimeTime })
  const audio = audioPort()
  const dispatcher = new CommandDispatcher({ store, audio })
  const sent: VdapOutboundMessage[] = []
  const context: RuntimeRequestContext = {
    connectionId: 'ui-port',
    role: 'ui',
    origin: 'user',
    send(message) {
      sent.push(message)
      return true
    },
  }
  return { store, audio, dispatcher, sent, context }
}

function portContext(
  connectionId: string,
  role: 'ui' | 'agent',
  sent: VdapOutboundMessage[],
): RuntimeRequestContext {
  return {
    connectionId,
    role,
    origin: role === 'ui' ? 'user' : 'agent',
    send(message) {
      sent.push(message)
      return true
    },
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise })
  return { promise, resolve }
}

function request(
  requestId: string,
  command: string,
  params: Record<string, unknown> = {},
  extra: Partial<RuntimeRequestEnvelope> = {},
): RuntimeRequestEnvelope {
  return {
    vdap: VDAP_VERSION,
    kind: 'request',
    requestId,
    command,
    params,
    ...extra,
  }
}

function messages(result: Awaited<ReturnType<CommandDispatcher['handle']>>): VdapOutboundMessage[] {
  if (!result) return []
  return Array.isArray(result) ? [...result] : [result as VdapOutboundMessage]
}

function bindDeck(store: RuntimeStore, deckId: 'A' | 'B' = 'A'): void {
  store.update((draft) => {
    draft.decks[deckId].binding = binding()
    draft.decks[deckId].transport.phase = 'ready'
    draft.decks[deckId].tempo.baseBpm = 120
    draft.decks[deckId].tempo.interpretedBpm = 120
    draft.decks[deckId].tempo.effectiveBpm = 120
  })
}

describe('CommandDispatcher', () => {
  it('handles hello, state queries, subscribe, and unsubscribe', async () => {
    const { dispatcher, context, sent, store } = setup()
    const hello = await dispatcher.handle(request('hello', 'session.hello', {
      protocolVersions: ['1.0'],
      client: { name: 'UI', version: '0.1.0' },
      role: 'ui',
    }), context)
    expect(messages(hello)[0]).toMatchObject({
      state: 'completed',
      result: {
        protocolVersion: '1.0',
        role: 'ui',
        capabilities: { grid: { source: 'analysis' } },
      },
    })

    const state = await dispatcher.handle(request('state', 'state.get'), context)
    expect(messages(state)[0]).toMatchObject({
      state: 'completed',
      result: { revision: store.getSnapshot().revision, intents: {} },
    })

    const subscribed = messages(await dispatcher.handle(
      request('subscribe', 'state.subscribe'),
      context,
    ))
    expect(sent.at(-1)).toMatchObject({ state: 'accepted' })
    expect(subscribed.map((message) => message.kind)).toEqual(['event', 'snapshot'])
    expect(subscribed[0]).toMatchObject({ event: 'intent.completed' })
    expect(subscribed[0]).toMatchObject({ revision: store.getSnapshot().revision })
    expect(subscribed[1]).toMatchObject({ revision: store.getSnapshot().revision })

    const unsubscribed = messages(await dispatcher.handle(
      request('unsubscribe', 'state.unsubscribe'),
      context,
    ))
    expect(unsubscribed).toHaveLength(1)
    expect(unsubscribed[0]).toMatchObject({ event: 'intent.completed' })
  })

  it('loads atomically and emits accepted ack before the terminal event', async () => {
    const { dispatcher, context, sent, store, audio } = setup()
    const revision = store.getSnapshot().revision
    const result = messages(await dispatcher.handle(request('load', 'deck.load', {
      deckId: 'A',
      source: { kind: 'catalog', trackId: 'track-1' },
      requireAnalysis: true,
    }, { expectedRevision: revision }), context))

    expect(audio.load).toHaveBeenCalledOnce()
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ state: 'accepted', revision: revision + 1 })
    expect(result.at(-1)).toMatchObject({ event: 'intent.completed' })
    const snapshot = store.getSnapshot()
    expect(result.at(-1)).toMatchObject({ revision: snapshot.revision })
    expect(snapshot.intents).toEqual({})
    expect(snapshot.decks.A).toMatchObject({
      binding: { bindingId: 'bind-1' },
      load: { phase: 'idle', intentId: null },
      transport: { phase: 'ready' },
    })
  })

  it('checks expectedRevision and expectedBindingId before acceptance', async () => {
    const { dispatcher, context, store, audio, sent } = setup()
    bindDeck(store)
    const revision = store.getSnapshot().revision

    const stale = messages(await dispatcher.handle(request('stale', 'deck.play', {
      deckId: 'A',
    }, { expectedRevision: revision - 1 }), context))[0]
    expect(stale).toMatchObject({ state: 'rejected', error: { code: 'E_STALE_REVISION' } })

    const mismatched = messages(await dispatcher.handle(request('binding', 'deck.play', {
      deckId: 'A',
    }, { expectedRevision: revision, expectedBindingId: 'bind-old' }), context))[0]
    expect(mismatched).toMatchObject({ state: 'rejected', error: { code: 'E_BINDING_MISMATCH' } })
    expect(audio.play).not.toHaveBeenCalled()
    expect(sent).toEqual([])
    expect(store.getSnapshot().revision).toBe(revision)
  })

  it('enforces the when allowlist while deferring beat execution', async () => {
    const { dispatcher, context } = setup()
    const load = messages(await dispatcher.handle(request('load-when', 'deck.load', {
      deckId: 'A', source: { kind: 'catalog', trackId: 'track-1' },
    }, { when: { at: 'nextBar' } }), context))[0]
    expect(load).toMatchObject({ error: { code: 'E_SCHEDULE_NOT_ALLOWED' } })

    const play = messages(await dispatcher.handle(request('play-when', 'deck.play', {
      deckId: 'A',
    }, { when: { at: 'nextBar' } }), context))[0]
    expect(play).toMatchObject({ error: { code: 'E_CAPABILITY_REQUIRED' } })

    const query = messages(await dispatcher.handle(request('query-when', 'state.get', {}, {
      when: { at: 'immediate' },
    }), context))[0]
    expect(query).toMatchObject({ error: { code: 'E_INVALID_PARAMS' } })
  })

  it('commits play audio state and terminal Intent removal in one revision', async () => {
    const { dispatcher, context, sent, store, audio } = setup()
    bindDeck(store)
    const acceptedRevision = store.getSnapshot().revision
    let resolvePlay!: (value: PositionPair) => void
    vi.mocked(audio.play).mockImplementation(() => new Promise((resolve) => {
      resolvePlay = resolve
    }))

    const pending = dispatcher.handle(request('play', 'deck.play', {
      deckId: 'A',
    }, {
      expectedRevision: acceptedRevision,
      expectedBindingId: 'bind-1',
    }), context)
    await Promise.resolve()
    expect(sent[0]).toMatchObject({ state: 'accepted' })
    expect(store.getSnapshot().decks.A.transport.phase).toBe('ready')
    store.update((draft) => {
      draft.mixer.masterGain = 0.9
    })
    resolvePlay(position(24))
    const terminal = messages(await pending).at(-1)
    const snapshot = store.getSnapshot()

    expect(terminal).toMatchObject({ event: 'intent.completed', revision: snapshot.revision })
    expect(snapshot.decks.A.transport.phase).toBe('playing')
    expect(snapshot.decks.A.playback).toMatchObject({
      position: position(24),
      headVelocity: 1,
      direction: 'forward',
    })
    expect(snapshot.intents).toEqual({})
  })

  it('maps Audio errors to stable failed terminal events after ack', async () => {
    const { dispatcher, context, sent, store, audio } = setup()
    bindDeck(store)
    vi.mocked(audio.play).mockRejectedValue(new RuntimeAudioError({
      code: 'E_AUDIO_LOCKED',
      retryable: true,
      message: 'User gesture required.',
    }))

    const result = messages(await dispatcher.handle(
      request('locked', 'deck.play', { deckId: 'A' }),
      context,
    ))
    expect(sent[0]).toMatchObject({ state: 'accepted' })
    expect(result.at(-1)).toMatchObject({
      event: 'intent.failed',
      error: { code: 'E_AUDIO_LOCKED', retryable: true },
    })
    expect(store.getSnapshot().intents).toEqual({})
    expect(store.getSnapshot().decks.A.transport.phase).toBe('ready')
  })

  it('reports an out-of-duration seek as E_OUT_OF_RANGE without changing runtime playback', async () => {
    const { dispatcher, context, store, audio } = setup()
    bindDeck(store)
    const before = store.getSnapshot().decks.A.playback.position
    vi.mocked(audio.seek).mockRejectedValue(new RuntimeAudioError({
      code: 'E_OUT_OF_RANGE',
      retryable: false,
      message: 'sourceSeconds exceeds duration.',
    }))

    const result = messages(await dispatcher.handle(request('seek-too-far', 'deck.seek', {
      deckId: 'A',
      target: { type: 'sourceSeconds', sourceSeconds: 181 },
      resume: 'pause',
    }), context))

    expect(result.at(-1)).toMatchObject({
      event: 'intent.failed',
      error: { code: 'E_OUT_OF_RANGE' },
    })
    expect(store.getSnapshot().decks.A.playback.position).toEqual(before)
    expect(store.getSnapshot().decks.A.transport.phase).toBe('ready')
  })

  it('validates ranges and atomically applies gain, EQ, velocity, seek, and mixer values', async () => {
    const { dispatcher, context, store, audio } = setup()
    bindDeck(store)
    const invalid = messages(await dispatcher.handle(
      request('bad-gain', 'deck.setGain', { deckId: 'A', gain: 2 }),
      context,
    ))[0]
    expect(invalid).toMatchObject({ error: { code: 'E_OUT_OF_RANGE' } })

    const invalidEqLow = messages(await dispatcher.handle(
      request('bad-eq-low', 'deck.setEq', { deckId: 'A', band: 'low', gainDb: -26.1 }),
      context,
    ))[0]
    expect(invalidEqLow).toMatchObject({ error: { code: 'E_OUT_OF_RANGE' } })

    const invalidEqHigh = messages(await dispatcher.handle(
      request('bad-eq-high', 'deck.setEq', { deckId: 'A', band: 'high', gainDb: 6.1 }),
      context,
    ))[0]
    expect(invalidEqHigh).toMatchObject({ error: { code: 'E_OUT_OF_RANGE' } })

    const invalidBand = messages(await dispatcher.handle(
      request('bad-eq-band', 'deck.setEq', { deckId: 'A', band: 'bass', gainDb: 0 }),
      context,
    ))[0]
    expect(invalidBand).toMatchObject({ error: { code: 'E_INVALID_PARAMS' } })

    await dispatcher.handle(request('gain', 'deck.setGain', { deckId: 'A', gain: 0.7 }), context)
    await dispatcher.handle(request('eq-low', 'deck.setEq', { deckId: 'A', band: 'low', gainDb: -26 }), context)
    await dispatcher.handle(request('eq-mid', 'deck.setEq', { deckId: 'A', band: 'mid', gainDb: 2.5 }), context)
    await dispatcher.handle(request('eq-high', 'deck.setEq', { deckId: 'A', band: 'high', gainDb: 6 }), context)
    await dispatcher.handle(request('velocity', 'deck.setVelocity', { deckId: 'A', velocity: 1.25 }), context)
    await dispatcher.handle(request('seek', 'deck.seek', {
      deckId: 'A', target: { type: 'sourceSeconds', sourceSeconds: 32 }, resume: 'pause',
    }), context)
    await dispatcher.handle(request('fader', 'mixer.setCrossfader', { position: 0.5 }), context)
    await dispatcher.handle(request('master', 'mixer.setMasterGain', { gain: 0.8 }), context)

    const snapshot = store.getSnapshot()
    expect(snapshot.decks.A.gain).toBe(0.7)
    expect(snapshot.decks.A.eq).toEqual({ lowDb: -26, midDb: 2.5, highDb: 6 })
    expect(audio.setEq).toHaveBeenNthCalledWith(1, 'A', 'low', -26)
    expect(audio.setEq).toHaveBeenNthCalledWith(2, 'A', 'mid', 2.5)
    expect(audio.setEq).toHaveBeenNthCalledWith(3, 'A', 'high', 6)
    expect(snapshot.decks.A.playback.configuredVelocity).toBe(1.25)
    expect(snapshot.decks.A.playback.position.sourceSeconds).toBe(32)
    expect(snapshot.mixer.crossfader.effective).toBe(0.5)
    expect(snapshot.mixer.crossfader.curve).toBe('dj')
    expect(snapshot.mixer.masterGain).toBe(0.8)
    expect(snapshot.intents).toEqual({})

    await dispatcher.handle(request('eq-low-reset', 'deck.setEq', { deckId: 'A', band: 'low', gainDb: 0 }), context)
    await dispatcher.handle(request('eq-mid-reset', 'deck.setEq', { deckId: 'A', band: 'mid', gainDb: 0 }), context)
    await dispatcher.handle(request('eq-high-reset', 'deck.setEq', { deckId: 'A', band: 'high', gainDb: 0 }), context)
    expect(store.getSnapshot().decks.A.eq).toEqual({ lowDb: 0, midDb: 0, highDb: 0 })
    expect(audio.setEq).toHaveBeenNthCalledWith(4, 'A', 'low', 0)
    expect(audio.setEq).toHaveBeenNthCalledWith(5, 'A', 'mid', 0)
    expect(audio.setEq).toHaveBeenNthCalledWith(6, 'A', 'high', 0)
  })

  it('cancels scheduled work and executes panic through ack and terminal events', async () => {
    const { dispatcher, context, store, sent } = setup()
    bindDeck(store)
    store.update((draft) => {
      draft.decks.A.transport.phase = 'playing'
      draft.decks.A.playback.headVelocity = 1
      draft.decks.A.playback.direction = 'forward'
      draft.intents['it-scheduled'] = {
        intentId: 'it-scheduled',
        requestId: 'old',
        command: 'deck.pause',
        origin: 'agent',
        state: 'scheduled',
        target: { deckId: 'A' },
        domain: 'transport',
        when: { at: 'nextBar' },
      }
    })
    let scheduledPresentAtCancelAck = false
    context.send = (message) => {
      sent.push(message)
      if (message.kind === 'ack' && message.requestId === 'cancel' && message.state === 'accepted') {
        scheduledPresentAtCancelAck = Boolean(store.getSnapshot().intents['it-scheduled'])
      }
      return true
    }
    const cancelSnapshots: ReturnType<RuntimeStore['getSnapshot']>[] = []
    const unsubscribe = store.subscribe(() => { cancelSnapshots.push(store.getSnapshot()) })

    const cancelled = messages(await dispatcher.handle(request('cancel', 'schedule.cancel', {
      filter: { all: true },
    }), context))
    unsubscribe()
    expect(cancelled).toHaveLength(1)
    expect(cancelled[0]).toMatchObject({
      event: 'intent.completed',
      result: { cancelledCount: 1, skippedCount: 0 },
    })
    expect(scheduledPresentAtCancelAck).toBe(true)
    expect(sent.at(-1)).toMatchObject({ state: 'accepted', revision: expect.any(Number) })
    expect((sent.at(-1) as { revision: number }).revision).toBeLessThan(
      (cancelled[0] as { revision: number }).revision,
    )
    expect(cancelSnapshots).toHaveLength(2)
    expect(cancelSnapshots[0]?.intents['it-scheduled']).toBeDefined()
    expect(cancelSnapshots[1]?.intents).toEqual({})
    expect(cancelSnapshots[1]?.revision).toBe((cancelled[0] as { revision: number }).revision)

    const panic = messages(await dispatcher.handle(
      request('panic', 'runtime.panic', { scope: 'A' }),
      context,
    ))
    expect(sent.at(-1)).toMatchObject({ state: 'accepted' })
    expect(panic.at(-1)).toMatchObject({ event: 'intent.completed' })
    expect(store.getSnapshot().decks.A.playback).toMatchObject({
      headVelocity: 0,
      direction: 'stopped',
    })
    expect(store.getSnapshot().decks.A.transport.phase).toBe('ready')
  })

  it('rejects an unknown schedule.cancel domain at runtime', async () => {
    const { dispatcher, context } = setup()

    const result = messages(await dispatcher.handle(request('bad-cancel', 'schedule.cancel', {
      filter: { deckId: 'A', domain: 'not-a-domain' },
    }), context))[0]

    expect(result).toMatchObject({
      kind: 'ack',
      state: 'rejected',
      error: { code: 'E_INVALID_PARAMS' },
    })
  })

  it('routes load supersession to the original port and ignores the stale audio result', async () => {
    const store = new RuntimeStore({ runtimeTimeProvider: (() => { let time = 0; return () => ++time })() })
    const audio = audioPort()
    const firstLoad = deferred<{ binding: TrackBinding; position: PositionPair }>()
    vi.mocked(audio.load)
      .mockImplementationOnce(() => firstLoad.promise)
      .mockResolvedValueOnce({ binding: binding('bind-2'), position: position(2) })
    const dispatcher = new CommandDispatcher({ store, audio })
    const agentSent: VdapOutboundMessage[] = []
    const uiSent: VdapOutboundMessage[] = []
    const agent = portContext('agent-port', 'agent', agentSent)
    const ui = portContext('ui-port', 'ui', uiSent)

    const oldRequest = dispatcher.handle(request('old-load', 'deck.load', {
      deckId: 'A', source: { kind: 'catalog', trackId: 'old' },
    }), agent)
    await Promise.resolve()
    const replacement = messages(await dispatcher.handle(request('new-load', 'deck.load', {
      deckId: 'A', source: { kind: 'catalog', trackId: 'new' },
    }), ui))

    expect(agentSent).toHaveLength(2)
    expect(agentSent[0]).toMatchObject({ state: 'accepted', requestId: 'old-load' })
    expect(agentSent[1]).toMatchObject({ event: 'intent.superseded', requestId: 'old-load' })
    expect(uiSent).toHaveLength(1)
    expect(replacement).toHaveLength(1)
    expect(replacement[0]).toMatchObject({ event: 'intent.completed', requestId: 'new-load' })

    firstLoad.resolve({ binding: binding('stale-binding'), position: position(99) })
    expect(await oldRequest).toBeUndefined()
    expect(store.getSnapshot().decks.A.binding?.bindingId).toBe('bind-2')
  })

  it('finalizes audio publication only after the runtime binding commits', async () => {
    const { store, audio, dispatcher, context } = setup()
    const observedBindings: Array<string | null> = []
    vi.mocked(audio.load).mockResolvedValueOnce({
      binding: binding('bind-atomic'),
      position: position(0),
      finalize: () => observedBindings.push(store.getSnapshot().decks.A.binding?.bindingId ?? null),
    })

    await dispatcher.handle(request('atomic-load', 'deck.load', {
      deckId: 'A', source: { kind: 'catalog', trackId: 'new' },
    }), context)

    expect(observedBindings).toEqual(['bind-atomic'])
  })

  it('cancels old-binding work on commit and routes bindingChanged to its owner', async () => {
    const { store, audio, dispatcher } = setup()
    bindDeck(store)
    const play = deferred<PositionPair>()
    vi.mocked(audio.play).mockImplementationOnce(() => play.promise)
    vi.mocked(audio.load).mockResolvedValueOnce({ binding: binding('bind-2'), position: position(0) })
    const agentSent: VdapOutboundMessage[] = []
    const uiSent: VdapOutboundMessage[] = []
    const agent = portContext('agent-port', 'agent', agentSent)
    const ui = portContext('ui-port', 'ui', uiSent)

    const oldPlay = dispatcher.handle(request('old-play', 'deck.play', { deckId: 'A' }, {
      expectedBindingId: 'bind-1',
    }), agent)
    await Promise.resolve()
    const loaded = messages(await dispatcher.handle(request('replace', 'deck.load', {
      deckId: 'A', source: { kind: 'catalog', trackId: 'new' }, replacePlaying: true,
    }), ui))

    expect(agentSent.at(-1)).toMatchObject({
      event: 'intent.cancelled',
      requestId: 'old-play',
      reason: 'bindingChanged',
    })
    expect(loaded).toHaveLength(1)
    expect(agentSent.at(-1)).toMatchObject({ revision: (loaded[0] as { revision: number }).revision })
    play.resolve(position(80))
    expect(await oldPlay).toBeUndefined()
    expect(store.getSnapshot().decks.A).toMatchObject({
      binding: { bindingId: 'bind-2' },
      transport: { phase: 'ready' },
      playback: { position: position(0) },
    })
  })

  it('accepts scoped panic despite stale preconditions and user priority, without cancelling deck B', async () => {
    const { store, audio, dispatcher } = setup()
    bindDeck(store, 'A')
    bindDeck(store, 'B')
    const playA = deferred<PositionPair>()
    const playB = deferred<PositionPair>()
    const panicAudio = deferred<Partial<Record<'A' | 'B', PositionPair>>>()
    vi.mocked(audio.play)
      .mockImplementationOnce(() => playA.promise)
      .mockImplementationOnce(() => playB.promise)
    vi.mocked(audio.panic).mockImplementationOnce(() => panicAudio.promise)
    const uiASent: VdapOutboundMessage[] = []
    const agentBSent: VdapOutboundMessage[] = []
    const panicSent: VdapOutboundMessage[] = []
    const uiA = portContext('ui-a', 'ui', uiASent)
    const agentB = portContext('agent-b', 'agent', agentBSent)
    const panicAgent = portContext('panic-agent', 'agent', panicSent)

    const pendingA = dispatcher.handle(request('play-a', 'deck.play', { deckId: 'A' }), uiA)
    const pendingB = dispatcher.handle(request('play-b', 'deck.play', { deckId: 'B' }), agentB)
    await Promise.resolve()
    const panicSnapshots: ReturnType<RuntimeStore['getSnapshot']>[] = []
    const unsubscribe = store.subscribe(() => { panicSnapshots.push(store.getSnapshot()) })
    const pendingPanic = dispatcher.handle(request('panic-a', 'runtime.panic', {
      scope: 'A',
    }, {
      expectedRevision: 'ignored-stale-revision',
      expectedBindingId: 'ignored-binding',
    }), panicAgent)
    await Promise.resolve()

    expect(panicSent[0]).toMatchObject({ state: 'accepted', requestId: 'panic-a' })
    expect(uiASent).toHaveLength(1)
    expect(panicSnapshots).toHaveLength(1)
    expect(Object.values(panicSnapshots[0]?.intents ?? {})).toHaveLength(3)
    panicAudio.resolve({ A: position(12) })
    const panicResult = messages(await pendingPanic)
    unsubscribe()
    expect(uiASent.at(-1)).toMatchObject({ event: 'intent.cancelled', reason: 'panic' })
    expect(agentBSent).toHaveLength(1)
    expect(panicResult).toHaveLength(1)
    expect(Object.values(store.getSnapshot().intents)).toHaveLength(1)
    expect(Object.values(store.getSnapshot().intents)[0]?.requestId).toBe('play-b')
    expect(panicSnapshots).toHaveLength(2)
    expect(Object.values(panicSnapshots[1]?.intents ?? {})).toHaveLength(1)
    expect(panicSnapshots[1]?.decks.A.transport.phase).toBe('ready')
    expect(panicSnapshots[1]?.revision).toBe((panicResult[0] as { revision: number }).revision)

    playA.resolve(position(50))
    playB.resolve(position(25))
    expect(await pendingA).toBeUndefined()
    expect(messages(await pendingB)[0]).toMatchObject({ event: 'intent.completed' })
    expect(store.getSnapshot().decks.A.transport.phase).toBe('ready')
    expect(store.getSnapshot().decks.B.transport.phase).toBe('playing')
  })

  describe('deck.getGrid', () => {
    it('returns the cached grid with the current bindingId for an analyzed deck', async () => {
      const { dispatcher, context, store } = setup()
      bindDeck(store, 'A')
      const result = messages(await dispatcher.handle(request('grid', 'deck.getGrid', { deckId: 'A' }), context))
      expect(result[0]).toMatchObject({
        state: 'completed',
        result: {
          bindingId: 'bind-1',
          bpm: 120,
          beatsSeconds: [0, 0.5, 1, 1.5],
          chords: [{ degree: 'I' }],
        },
      })
    })

    it('rejects an empty deck with E_DECK_EMPTY', async () => {
      const { dispatcher, context } = setup()
      const result = messages(await dispatcher.handle(request('grid', 'deck.getGrid', { deckId: 'B' }), context))
      expect(result[0]).toMatchObject({ state: 'rejected', error: { code: 'E_DECK_EMPTY' } })
    })

    it('rejects an analysis-less binding with E_ANALYSIS_UNAVAILABLE', async () => {
      const { dispatcher, context, store } = setup()
      store.update((draft) => {
        draft.decks.A.binding = { ...binding(), analysis: null }
        draft.decks.A.transport.phase = 'ready'
      })
      const result = messages(await dispatcher.handle(request('grid', 'deck.getGrid', { deckId: 'A' }), context))
      expect(result[0]).toMatchObject({ state: 'rejected', error: { code: 'E_ANALYSIS_UNAVAILABLE' } })
    })

    it('rejects queries carrying mutation preconditions', async () => {
      const { dispatcher, context, store } = setup()
      bindDeck(store, 'A')
      const result = messages(
        await dispatcher.handle(request('grid', 'deck.getGrid', { deckId: 'A' }, { expectedRevision: 1 }), context),
      )
      expect(result[0]).toMatchObject({ state: 'rejected', error: { code: 'E_INVALID_PARAMS' } })
    })
  })
})
