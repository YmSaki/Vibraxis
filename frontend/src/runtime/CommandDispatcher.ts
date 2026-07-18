import {
  DECK_EQ_MAX_GAIN_DB,
  DECK_EQ_MIN_GAIN_DB,
  VDAP_VERSION,
  type DeckId,
  type DeckLoadParams,
  type DeckSeekParams,
  type IntentDomain,
  type IntentCancelledEvent,
  type IntentCompletedEvent,
  type IntentFailedEvent,
  type IntentState,
  type IntentSupersededEvent,
  type IntentTarget,
  type P0When,
  type RuntimeState,
  type ScheduleCancelFilter,
  type VdapAcceptedAck,
  type VdapError,
  type VdapMutationCommand,
  type VdapRejectedAck,
  type VdapSnapshot,
} from '@vibraxis/shared/vdap'
import {
  IntentManager,
  type RuntimeStateEffect,
} from './IntentManager'
import type {
  RuntimeRequestContext,
  RuntimeRequestEnvelope,
  VdapOutboundMessage,
} from './MessagePortTransport'
import { RuntimeAudioError, type RuntimeAudioPort } from './RuntimeAudioPort'
import { RuntimeIntentAdapter } from './RuntimeIntentAdapter'
import { RuntimeStore } from './RuntimeStore'

export type CommandDispatcherOptions = {
  store: RuntimeStore
  audio: RuntimeAudioPort
  nextIntentId?: () => string
  runtime?: { name: string; version: string }
}

type DispatchResult =
  | void
  | VdapOutboundMessage
  | readonly VdapOutboundMessage[]

type Validation<T> = { value: T } | { error: VdapError }

type IntentTerminalEvent =
  | IntentCompletedEvent
  | IntentFailedEvent
  | IntentCancelledEvent
  | IntentSupersededEvent

type IntentOwner = {
  connectionId: string
  send: RuntimeRequestContext['send']
  bindingDependencies: ReadonlySet<DeckId>
}

const IMMEDIATE_ONLY = new Set<string>([
  'state.subscribe',
  'state.unsubscribe',
  'deck.load',
  'deck.unload',
  'deck.setTempoInterpretation',
  'mixer.setMasterGain',
  'schedule.cancel',
  'runtime.panic',
])

const SCHEDULABLE = new Set<string>([
  'deck.play',
  'deck.pause',
  'deck.seek',
  'deck.selectPad',
  'deck.setGain',
  'deck.setEq',
  'deck.setVelocity',
  'deck.sync',
  'mixer.setCrossfader',
  'mixer.rampCrossfader',
])

const DECK_COMMANDS = new Set<string>([
  'deck.getGrid',
  'deck.load',
  'deck.unload',
  'deck.play',
  'deck.pause',
  'deck.seek',
  'deck.selectPad',
  'deck.setPad',
  'deck.clearPad',
  'deck.setGain',
  'deck.setEq',
  'deck.setVelocity',
  'deck.setTempoInterpretation',
  'deck.sync',
])

const INTENT_DOMAINS = new Set<IntentDomain>([
  'binding',
  'transport',
  'padSelection',
  'padEdit',
  'velocity',
  'gain',
  'eq',
  'crossfader',
  'master',
  'subscription',
  'schedule',
  'runtime',
])

export class CommandDispatcher {
  private readonly store: RuntimeStore
  private readonly audio: RuntimeAudioPort
  private readonly intents: IntentManager
  private readonly runtime: { name: string; version: string }
  private readonly subscriptions = new Set<string>()
  private readonly intentOwners = new Map<string, IntentOwner>()

  constructor(options: CommandDispatcherOptions) {
    this.store = options.store
    this.audio = options.audio
    this.runtime = options.runtime ?? { name: 'Vibraxis Runtime', version: '0.1.0' }
    let sequence = 0
    this.intents = new IntentManager({
      state: new RuntimeIntentAdapter(options.store),
      nextIntentId: options.nextIntentId ?? (() => `it-${++sequence}`),
    })
  }

  /** Whether the connection has an active state subscription (used by the runtime to route snapshots). */
  isSubscribed(connectionId: string): boolean {
    return this.subscriptions.has(connectionId)
  }

  /**
   * Records a natural track end reported by the audio layer and returns the
   * deck.ended event for the transport to broadcast.
   */
  deckEnded(deckId: DeckId, position: { sourceSeconds: number; atRuntimeTime: number }) {
    const snapshot = this.store.update((draft) => {
      const deck = draft.decks[deckId]
      deck.transport.phase = deck.binding ? 'ended' : 'empty'
      deck.playback.position = position
      deck.playback.headVelocity = 0
      deck.playback.direction = 'stopped'
    })
    return {
      vdap: VDAP_VERSION,
      kind: 'event',
      event: 'deck.ended',
      revision: snapshot.revision,
      runtimeTime: snapshot.runtimeTime,
      deckId,
      position,
    } as const
  }

  handle = async (
    request: RuntimeRequestEnvelope,
    context: RuntimeRequestContext,
  ): Promise<DispatchResult> => {
    const envelopeError = validateEnvelopeFields(request)
    if (envelopeError) return rejected(request.requestId, envelopeError)

    if (request.command === 'session.hello') return this.hello(request, context)
    if (request.command === 'state.get') return this.stateGet(request)
    if (request.command === 'deck.getGrid') return this.getGrid(request)

    const snapshot = this.store.getSnapshot()
    if (
      request.command !== 'runtime.panic'
      && request.expectedRevision !== undefined
      && request.expectedRevision !== snapshot.revision
    ) {
      return rejectedError(request.requestId, 'E_STALE_REVISION', 'expectedRevision does not match current state.')
    }

    const when = validateWhen(request.command, request.when)
    if ('error' in when) return rejected(request.requestId, when.error)

    switch (request.command) {
      case 'state.subscribe':
      case 'state.unsubscribe':
        return this.subscription(request, context, request.command === 'state.subscribe')
      case 'deck.load':
        return this.load(request, context)
      case 'deck.unload':
        return this.unload(request, context)
      case 'deck.play':
      case 'deck.pause':
        return this.transport(request, context, request.command, when.value)
      case 'deck.seek':
        return this.seek(request, context, when.value)
      case 'deck.setGain':
        return this.setGain(request, context, when.value)
      case 'deck.setEq':
        return this.setEq(request, context, when.value)
      case 'deck.setVelocity':
        return this.setVelocity(request, context, when.value)
      case 'mixer.setCrossfader':
        return this.setCrossfader(request, context, when.value)
      case 'mixer.setMasterGain':
        return this.setMasterGain(request, context)
      case 'schedule.cancel':
        return this.cancelSchedule(request, context)
      case 'runtime.panic':
        return this.panic(request, context)
      case 'mixer.rampCrossfader':
      case 'deck.sync':
        return rejectedError(request.requestId, 'E_CAPABILITY_REQUIRED', `${request.command} execution is implemented in the Beat transition stage.`)
      default:
        return rejectedError(request.requestId, 'E_UNSUPPORTED_COMMAND', `${request.command} is not implemented by the P0 dispatcher.`)
    }
  }

  private hello(
    request: RuntimeRequestEnvelope,
    context: RuntimeRequestContext,
  ): VdapOutboundMessage {
    if (request.when !== undefined || request.expectedRevision !== undefined || request.expectedBindingId !== undefined) {
      return rejectedError(request.requestId, 'E_INVALID_PARAMS', 'Queries cannot carry when or mutation preconditions.')
    }
    const params = parseHello(request.params)
    if ('error' in params) return rejected(request.requestId, params.error)
    if (!params.value.protocolVersions.includes(VDAP_VERSION)) {
      return rejectedError(request.requestId, 'E_UNSUPPORTED_VERSION', `VDAP ${VDAP_VERSION} is not supported by the client.`)
    }
    if (params.value.role !== context.role) {
      return rejectedError(request.requestId, 'E_ROLE_MISMATCH', 'hello role does not match the assigned MessagePort role.')
    }
    const snapshot = this.store.getSnapshot()
    return {
      vdap: VDAP_VERSION,
      kind: 'ack',
      requestId: request.requestId,
      state: 'completed',
      revision: snapshot.revision,
      result: {
        protocolVersion: VDAP_VERSION,
        runtime: this.runtime,
        role: context.role,
        profile: 'core',
        deckIds: ['A', 'B'],
        capabilities: {
          velocity: { min: 0.5, max: 1.5, reverse: false },
          grid: { source: 'analysis' },
        },
        limits: {
          maxScheduleHorizonSeconds: 60,
          maxPendingIntents: 16,
          idempotencyWindowSeconds: 60,
          gainRange: { min: 0, max: 1.5 },
          masterRange: { min: 0, max: 1 },
        },
        revision: snapshot.revision,
      },
    }
  }

  private getGrid(request: RuntimeRequestEnvelope): VdapOutboundMessage {
    if (request.when !== undefined || request.expectedRevision !== undefined || request.expectedBindingId !== undefined) {
      return rejectedError(request.requestId, 'E_INVALID_PARAMS', 'Queries cannot carry when or mutation preconditions.')
    }
    const deck = parseDeckId(request.params)
    if ('error' in deck) return rejected(request.requestId, deck.error)
    const state = this.store.getSnapshot().decks[deck.value]
    if (!state.binding) return rejectedError(request.requestId, 'E_DECK_EMPTY', 'Deck has no binding.')
    if (!state.binding.analysis) {
      return rejectedError(request.requestId, 'E_ANALYSIS_UNAVAILABLE', 'The bound track has no analysis grid.')
    }
    const payload = this.audio.getGrid?.(state.binding.bindingId)
    if (!payload) {
      return rejectedError(request.requestId, 'E_ANALYSIS_UNAVAILABLE', 'No grid is cached for the current binding.')
    }
    const snapshot = this.store.getSnapshot()
    return {
      vdap: VDAP_VERSION,
      kind: 'ack',
      requestId: request.requestId,
      state: 'completed',
      revision: snapshot.revision,
      result: { bindingId: state.binding.bindingId, ...payload },
    }
  }

  private stateGet(request: RuntimeRequestEnvelope): VdapOutboundMessage {
    if (request.when !== undefined || request.expectedRevision !== undefined || request.expectedBindingId !== undefined || !isEmptyObject(request.params)) {
      return rejectedError(request.requestId, 'E_INVALID_PARAMS', 'state.get accepts empty params and no mutation fields.')
    }
    const snapshot = cloneRuntimeState(this.store)
    return {
      vdap: VDAP_VERSION,
      kind: 'ack',
      requestId: request.requestId,
      state: 'completed',
      revision: snapshot.revision,
      result: snapshot,
    }
  }

  private async subscription(
    request: RuntimeRequestEnvelope,
    context: RuntimeRequestContext,
    subscribe: boolean,
  ): Promise<DispatchResult> {
    if (!isEmptyObject(request.params)) return rejectedError(request.requestId, 'E_INVALID_PARAMS', 'Subscription params must be empty.')
    const accepted = this.acceptGeneral(request, context, 'subscription', { connectionId: context.connectionId })
    if (!accepted.accepted) return accepted.rejection
    context.send(accepted.ack)
    this.routeForeignTerminals(accepted.cancelled)
    if (subscribe) this.subscriptions.add(context.connectionId)
    else this.subscriptions.delete(context.connectionId)
    const terminal = this.intents.complete(accepted.intentId)
    if (!terminal) return rejectedError(request.requestId, 'E_INTERNAL', 'Subscription Intent disappeared before completion.')
    const ownTerminal = this.ownTerminal(terminal)
    return subscribe
      ? [ownTerminal, snapshotMessage(this.store)]
      : ownTerminal
  }

  private async load(request: RuntimeRequestEnvelope, context: RuntimeRequestContext): Promise<DispatchResult> {
    const params = parseLoad(request.params)
    if ('error' in params) return rejected(request.requestId, params.error)
    const precondition = this.deckPrecondition(request, params.value.deckId)
    if (precondition) return rejected(request.requestId, precondition)
    const deck = this.store.getSnapshot().decks[params.value.deckId]
    if (
      context.origin === 'agent'
      && deck.transport.phase === 'playing'
      && (params.value.replacePlaying !== true || request.expectedBindingId === undefined)
    ) {
      return rejectedError(request.requestId, 'E_DECK_PLAYING', 'Agent load into a playing deck requires replacePlaying and expectedBindingId.')
    }

    const accepted = this.intents.acceptBindingSupersession({
      requestId: request.requestId,
      command: 'deck.load',
      origin: context.origin,
      target: { deckId: params.value.deckId },
      domain: 'binding',
      when: { at: 'immediate' },
    }, (draft) => {
      const intent = Object.values(draft.intents).find((item) => item.requestId === request.requestId)
      if (intent) draft.decks[params.value.deckId].load = { phase: 'loading', intentId: intent.intentId, progress: null }
    })
    if (!accepted.accepted) return userPriority(request.requestId)
    this.registerOwner(accepted.intent.intentId, context, { deckId: params.value.deckId })
    context.send(acceptedAck(request.requestId, accepted.intent.intentId, accepted.revision))
    this.routeForeignTerminals(accepted.superseded)

    try {
      const loaded = await this.audio.load(params.value)
      const completion = this.intents.completeWithCancellation(
        accepted.intent.intentId,
        (intent) => this.dependsOnDeck(intent, params.value.deckId),
        'bindingChanged',
        { binding: loaded.binding },
        (draft) => {
        const target = draft.decks[params.value.deckId]
        target.load = { phase: 'idle', intentId: null, progress: null }
        target.binding = loaded.binding
        target.transport.phase = 'ready'
        target.playback.position = loaded.position
        target.playback.override = null
        target.playback.headVelocity = 0
        target.playback.direction = 'stopped'
        target.tempo.interpretation = 'normal'
        target.tempo.baseBpm = loaded.binding.analysis?.bpm ?? null
        target.tempo.interpretedBpm = loaded.binding.analysis?.bpm ?? null
        target.tempo.effectiveBpm = loaded.binding.analysis
          ? loaded.binding.analysis.bpm * target.playback.configuredVelocity
          : null
        target.pads = { selectedSlot: 1, slots: [] }
      })
      if (!completion) return
      loaded.finalize?.()
      this.routeForeignTerminals(completion.cancelled)
      return this.ownTerminal(completion.terminal)
    } catch (cause) {
      const terminal = this.intents.fail(accepted.intent.intentId, audioError(cause, 'E_LOAD_FAILED'), undefined, (draft) => {
        draft.decks[params.value.deckId].load = { phase: 'idle', intentId: null, progress: null }
      })
      return this.ownTerminal(terminal)
    }
  }

  private async unload(request: RuntimeRequestEnvelope, context: RuntimeRequestContext): Promise<DispatchResult> {
    const params = parseDeckParams(request.params)
    if ('error' in params) return rejected(request.requestId, params.error)
    const precondition = this.deckPrecondition(request, params.value.deckId)
    if (precondition) return rejected(request.requestId, precondition)
    const accepted = this.intents.acceptBindingSupersession({
      requestId: request.requestId,
      command: 'deck.unload',
      origin: context.origin,
      target: { deckId: params.value.deckId },
      domain: 'binding',
      when: { at: 'immediate' },
    })
    if (!accepted.accepted) return userPriority(request.requestId)
    this.registerOwner(accepted.intent.intentId, context, { deckId: params.value.deckId })
    context.send(acceptedAck(request.requestId, accepted.intent.intentId, accepted.revision))
    this.routeForeignTerminals(accepted.superseded)
    try {
      await this.audio.unload(params.value.deckId)
      const completion = this.intents.completeWithCancellation(
        accepted.intent.intentId,
        (intent) => this.dependsOnDeck(intent, params.value.deckId),
        'bindingChanged',
        {},
        (draft) => {
        const target = draft.decks[params.value.deckId]
        target.load = { phase: 'idle', intentId: null, progress: null }
        target.binding = null
        target.transport.phase = 'empty'
        target.playback.position = { sourceSeconds: 0, atRuntimeTime: draft.runtimeTime }
        target.playback.headVelocity = 0
        target.playback.direction = 'stopped'
        target.tempo.baseBpm = null
        target.tempo.interpretedBpm = null
        target.tempo.effectiveBpm = null
        target.pads = { selectedSlot: 1, slots: [] }
      })
      if (!completion) return
      this.routeForeignTerminals(completion.cancelled)
      return this.ownTerminal(completion.terminal)
    } catch (cause) {
      const terminal = this.intents.fail(accepted.intent.intentId, audioError(cause))
      return this.ownTerminal(terminal)
    }
  }

  private async transport(
    request: RuntimeRequestEnvelope,
    context: RuntimeRequestContext,
    command: 'deck.play' | 'deck.pause',
    when: P0When,
  ): Promise<DispatchResult> {
    const params = parseDeckParams(request.params)
    if ('error' in params) return rejected(request.requestId, params.error)
    const precondition = this.deckPrecondition(request, params.value.deckId)
    if (precondition) return rejected(request.requestId, precondition)
    const deck = this.store.getSnapshot().decks[params.value.deckId]
    if (command === 'deck.play' && !deck.binding) return rejectedError(request.requestId, 'E_DECK_EMPTY', 'Deck has no binding.')
    const phaseAtAcceptance = deck.transport.phase
    const accepted = this.acceptGeneral(request, context, 'transport', { deckId: params.value.deckId }, when)
    if (!accepted.accepted) return accepted.rejection
    context.send(accepted.ack)
    this.routeForeignTerminals(accepted.cancelled)
    try {
      const position = command === 'deck.play'
        ? await this.audio.play(params.value.deckId)
        : await this.audio.pause(params.value.deckId)
      const terminal = this.intents.complete(accepted.intentId, {}, undefined, (draft) => {
        const target = draft.decks[params.value.deckId]
        // A natural audio end can arrive while an async transport operation is
        // in flight. Its terminal position is authoritative and must not be
        // replaced by a late pause/play completion.
        if (phaseAtAcceptance !== 'ended' && target.transport.phase === 'ended') return
        target.playback.position = position
        target.transport.phase = command === 'deck.play' ? 'playing' : target.binding ? 'ready' : 'empty'
        target.playback.headVelocity = command === 'deck.play' ? target.playback.configuredVelocity : 0
        target.playback.direction = command === 'deck.play' ? 'forward' : 'stopped'
      })
      return this.ownTerminal(terminal)
    } catch (cause) {
      const terminal = this.intents.fail(accepted.intentId, audioError(cause))
      return this.ownTerminal(terminal)
    }
  }

  private async seek(request: RuntimeRequestEnvelope, context: RuntimeRequestContext, when: P0When): Promise<DispatchResult> {
    const params = parseSeek(request.params)
    if ('error' in params) return rejected(request.requestId, params.error)
    const precondition = this.deckPrecondition(request, params.value.deckId)
    if (precondition) return rejected(request.requestId, precondition)
    if (!this.store.getSnapshot().decks[params.value.deckId].binding) return rejectedError(request.requestId, 'E_DECK_EMPTY', 'Deck has no binding.')
    const accepted = this.acceptGeneral(request, context, 'transport', { deckId: params.value.deckId }, when)
    if (!accepted.accepted) return accepted.rejection
    context.send(accepted.ack)
    this.routeForeignTerminals(accepted.cancelled)
    try {
      const position = await this.audio.seek(params.value.deckId, {
        target: params.value.target,
        resume: params.value.resume ?? 'keep',
      })
      const terminal = this.intents.complete(accepted.intentId, { position }, undefined, (draft) => {
        const target = draft.decks[params.value.deckId]
        target.playback.position = position
        if (params.value.resume === 'pause') {
          target.transport.phase = 'ready'
          target.playback.headVelocity = 0
          target.playback.direction = 'stopped'
        } else if (params.value.resume === 'play') {
          target.transport.phase = 'playing'
          target.playback.headVelocity = target.playback.configuredVelocity
          target.playback.direction = 'forward'
        }
      })
      return this.ownTerminal(terminal)
    } catch (cause) {
      const terminal = this.intents.fail(accepted.intentId, audioError(cause))
      return this.ownTerminal(terminal)
    }
  }

  private async setGain(request: RuntimeRequestEnvelope, context: RuntimeRequestContext, when: P0When): Promise<DispatchResult> {
    const deck = parseDeckId(request.params)
    if ('error' in deck) return rejected(request.requestId, deck.error)
    const params = parseNumberParam(request.params, 'gain', 0, 1.5, false)
    if ('error' in params) return rejected(request.requestId, params.error)
    const precondition = this.deckPrecondition(request, deck.value)
    if (precondition) return rejected(request.requestId, precondition)
    return this.executeGeneral(request, context, 'gain', { deckId: deck.value }, when,
      () => this.audio.setGain(deck.value, params.value),
      (draft) => { draft.decks[deck.value].gain = params.value })
  }

  private async setVelocity(request: RuntimeRequestEnvelope, context: RuntimeRequestContext, when: P0When): Promise<DispatchResult> {
    const deck = parseDeckId(request.params)
    if ('error' in deck) return rejected(request.requestId, deck.error)
    const params = parseNumberParam(request.params, 'velocity', 0.5, 1.5, false)
    if ('error' in params) return rejected(request.requestId, params.error)
    const precondition = this.deckPrecondition(request, deck.value)
    if (precondition) return rejected(request.requestId, precondition)
    const accepted = this.acceptGeneral(request, context, 'velocity', { deckId: deck.value }, when)
    if (!accepted.accepted) return accepted.rejection
    context.send(accepted.ack)
    this.routeForeignTerminals(accepted.cancelled)
    try {
      const position = await this.audio.setVelocity(deck.value, params.value)
      const terminal = this.intents.complete(accepted.intentId, {}, undefined, (draft) => {
        const target = draft.decks[deck.value]
        if (position) target.playback.position = position
        target.playback.baseVelocity = params.value
        target.playback.configuredVelocity = params.value
        target.playback.headVelocity = target.transport.phase === 'playing' ? params.value : 0
        target.tempo.effectiveBpm = target.tempo.interpretedBpm === null
          ? null
          : target.tempo.interpretedBpm * params.value
      })
      return this.ownTerminal(terminal)
    } catch (cause) {
      const terminal = this.intents.fail(accepted.intentId, audioError(cause))
      return this.ownTerminal(terminal)
    }
  }

  private async setEq(request: RuntimeRequestEnvelope, context: RuntimeRequestContext, when: P0When): Promise<DispatchResult> {
    const deck = parseDeckId(request.params)
    if ('error' in deck) return rejected(request.requestId, deck.error)
    if (!isRecord(request.params) || !['low', 'mid', 'high'].includes(String(request.params.band))) {
      return rejectedError(request.requestId, 'E_INVALID_PARAMS', 'band must be low, mid, or high.')
    }
    const gainDb = parseNumberParam(
      request.params,
      'gainDb',
      DECK_EQ_MIN_GAIN_DB,
      DECK_EQ_MAX_GAIN_DB,
      false,
    )
    if ('error' in gainDb) return rejected(request.requestId, gainDb.error)
    const precondition = this.deckPrecondition(request, deck.value)
    if (precondition) return rejected(request.requestId, precondition)
    const band = request.params.band as 'low' | 'mid' | 'high'
    const stateKey = `${band}Db` as const
    return this.executeGeneral(request, context, 'eq', { deckId: deck.value }, when,
      () => this.audio.setEq(deck.value, band, gainDb.value),
      (draft) => { draft.decks[deck.value].eq[stateKey] = gainDb.value })
  }

  private async setCrossfader(request: RuntimeRequestEnvelope, context: RuntimeRequestContext, when: P0When): Promise<DispatchResult> {
    const position = parseNumberParam(request.params, 'position', -1, 1, false)
    if ('error' in position) return rejected(request.requestId, position.error)
    if (request.expectedBindingId !== undefined) return rejectedError(request.requestId, 'E_INVALID_PARAMS', 'Mixer commands cannot carry expectedBindingId.')
    return this.executeGeneral(request, context, 'crossfader', { mixer: 'crossfader' }, when,
      () => this.audio.setCrossfader(position.value),
      (draft) => {
        draft.mixer.crossfader.base = position.value
        draft.mixer.crossfader.effective = position.value
        draft.mixer.crossfader.curve = 'dj'
        draft.mixer.crossfader.automation = null
      })
  }

  private async setMasterGain(request: RuntimeRequestEnvelope, context: RuntimeRequestContext): Promise<DispatchResult> {
    const gain = parseNumberParam(request.params, 'gain', 0, 1, false)
    if ('error' in gain) return rejected(request.requestId, gain.error)
    if (request.expectedBindingId !== undefined) return rejectedError(request.requestId, 'E_INVALID_PARAMS', 'Mixer commands cannot carry expectedBindingId.')
    return this.executeGeneral(request, context, 'master', { mixer: 'master' }, { at: 'immediate' },
      () => this.audio.setMasterGain(gain.value),
      (draft) => { draft.mixer.masterGain = gain.value })
  }

  private async executeGeneral(
    request: RuntimeRequestEnvelope,
    context: RuntimeRequestContext,
    domain: Exclude<IntentDomain, 'binding'>,
    target: IntentTarget,
    when: P0When,
    audio: () => Promise<void>,
    effect: RuntimeStateEffect,
  ): Promise<DispatchResult> {
    const accepted = this.acceptGeneral(request, context, domain, target, when)
    if (!accepted.accepted) return accepted.rejection
    context.send(accepted.ack)
    this.routeForeignTerminals(accepted.cancelled)
    try {
      await audio()
      const terminal = this.intents.complete(accepted.intentId, {}, undefined, effect)
      return this.ownTerminal(terminal)
    } catch (cause) {
      const terminal = this.intents.fail(accepted.intentId, audioError(cause))
      return this.ownTerminal(terminal)
    }
  }

  private async cancelSchedule(request: RuntimeRequestEnvelope, context: RuntimeRequestContext): Promise<DispatchResult> {
    const filter = parseCancelFilter(request.params)
    if ('error' in filter) return rejected(request.requestId, filter.error)
    const target: IntentTarget = { runtime: true }
    const accepted = this.intents.acceptUncontested({
      requestId: request.requestId,
      command: 'schedule.cancel',
      origin: context.origin,
      target,
      domain: 'schedule',
      when: { at: 'immediate' },
    })
    this.registerOwner(accepted.intent.intentId, context, target)
    context.send(acceptedAck(request.requestId, accepted.intent.intentId, accepted.revision))
    const completion = this.intents.completeWithFilteredCancellation(
      accepted.intent.intentId,
      filter.value,
      'clientCancel',
      context.origin,
      (draft) => {
      const automation = draft.mixer.crossfader.automation
      if (automation && !draft.intents[automation.intentId]) draft.mixer.crossfader.automation = null
    })
    if (!completion) return
    this.routeForeignTerminals(completion.cancelled)
    return this.ownTerminal(completion.terminal)
  }

  private async panic(request: RuntimeRequestEnvelope, context: RuntimeRequestContext): Promise<DispatchResult> {
    const scope = parsePanic(request.params)
    if ('error' in scope) return rejected(request.requestId, scope.error)
    const target: IntentTarget = { scope: scope.value ?? 'all' }
    const accepted = this.intents.acceptUncontested({
      requestId: request.requestId,
      command: 'runtime.panic',
      origin: context.origin,
      target,
      domain: 'runtime',
      when: { at: 'immediate' },
    })
    this.registerOwner(accepted.intent.intentId, context, target)
    context.send(acceptedAck(request.requestId, accepted.intent.intentId, accepted.revision))
    try {
      const positions = await this.audio.panic(scope.value)
      const completion = this.intents.completeWithCancellation(
        accepted.intent.intentId,
        (intent) => {
          if (!scope.value || scope.value === 'all') return true
          return this.targetsDeck(intent, scope.value)
        },
        'panic',
        {},
        (draft) => {
          const automation = draft.mixer.crossfader.automation
          if (automation && !draft.intents[automation.intentId]) draft.mixer.crossfader.automation = null
          const deckIds: DeckId[] = scope.value && scope.value !== 'all' ? [scope.value] : ['A', 'B']
          for (const deckId of deckIds) {
            const deck = draft.decks[deckId]
            if (positions[deckId]) deck.playback.position = positions[deckId]
            deck.transport.phase = deck.binding ? 'ready' : 'empty'
            deck.playback.override = null
            deck.playback.headVelocity = 0
            deck.playback.direction = 'stopped'
          }
        },
      )
      if (!completion) return
      this.routeForeignTerminals(completion.cancelled)
      return this.ownTerminal(completion.terminal)
    } catch (cause) {
      const terminal = this.intents.fail(accepted.intent.intentId, audioError(cause))
      return this.ownTerminal(terminal)
    }
  }

  private acceptGeneral(
    request: RuntimeRequestEnvelope,
    context: RuntimeRequestContext,
    domain: Exclude<IntentDomain, 'binding'>,
    target: IntentTarget,
    when: P0When = { at: 'immediate' },
    bindingDependencies: readonly DeckId[] = [],
  ):
    | { accepted: true; intentId: string; ack: VdapAcceptedAck; cancelled: IntentCancelledEvent[] }
    | { accepted: false; rejection: VdapRejectedAck } {
    const accepted = this.intents.accept({
      requestId: request.requestId,
      command: request.command as Exclude<VdapMutationCommand, 'deck.load' | 'deck.unload'>,
      origin: context.origin,
      target,
      domain,
      when,
    })
    if (accepted.accepted) {
      this.registerOwner(accepted.intent.intentId, context, target, bindingDependencies)
      return {
          accepted: true,
          intentId: accepted.intent.intentId,
          ack: acceptedAck(request.requestId, accepted.intent.intentId, accepted.revision),
          cancelled: accepted.cancelled,
        }
    }
    return { accepted: false, rejection: userPriority(request.requestId) }
  }

  private registerOwner(
    intentId: string,
    context: RuntimeRequestContext,
    target: IntentTarget,
    additionalBindingDependencies: readonly DeckId[] = [],
  ): void {
    const bindingDependencies = new Set<DeckId>()
    if ('deckId' in target) bindingDependencies.add(target.deckId)
    if ('scope' in target && target.scope !== 'all') bindingDependencies.add(target.scope)
    for (const deckId of additionalBindingDependencies) bindingDependencies.add(deckId)
    this.intentOwners.set(intentId, {
      connectionId: context.connectionId,
      send: context.send,
      bindingDependencies,
    })
  }

  private routeForeignTerminals(events: readonly IntentTerminalEvent[]): void {
    for (const event of events) {
      const owner = this.intentOwners.get(event.intentId)
      this.intentOwners.delete(event.intentId)
      owner?.send(event)
    }
  }

  private ownTerminal<T extends IntentTerminalEvent>(event: T): T
  private ownTerminal(event: null): undefined
  private ownTerminal<T extends IntentTerminalEvent>(event: T | null): T | undefined
  private ownTerminal<T extends IntentTerminalEvent>(event: T | null): T | undefined {
    if (!event) return undefined
    this.intentOwners.delete(event.intentId)
    return event
  }

  private dependsOnDeck(intent: Readonly<IntentState>, deckId: DeckId): boolean {
    if (intent.domain === 'binding' || intent.command === 'runtime.panic') return false
    return this.targetsDeck(intent, deckId)
  }

  private targetsDeck(intent: Readonly<IntentState>, deckId: DeckId): boolean {
    if ('deckId' in intent.target && intent.target.deckId === deckId) return true
    if ('scope' in intent.target && (intent.target.scope === 'all' || intent.target.scope === deckId)) return true
    return this.intentOwners.get(intent.intentId)?.bindingDependencies.has(deckId) ?? false
  }

  private deckPrecondition(request: RuntimeRequestEnvelope, deckId: DeckId): VdapError | null {
    if (request.expectedBindingId === undefined) return null
    if (typeof request.expectedBindingId !== 'string' || request.expectedBindingId.length === 0) {
      return error('E_INVALID_PARAMS', 'expectedBindingId must be a non-empty string.')
    }
    if (this.store.getSnapshot().decks[deckId].binding?.bindingId !== request.expectedBindingId) {
      return error('E_BINDING_MISMATCH', 'expectedBindingId does not match the current deck binding.')
    }
    return null
  }
}

function validateEnvelopeFields(request: RuntimeRequestEnvelope): VdapError | null {
  if (request.vdap !== VDAP_VERSION || request.kind !== 'request' || !request.requestId || typeof request.command !== 'string' || !isRecord(request.params)) {
    return error('E_PROTOCOL', 'Invalid VDAP request envelope.')
  }
  if (
    request.command !== 'runtime.panic'
    && request.expectedRevision !== undefined
    && (!Number.isSafeInteger(request.expectedRevision) || Number(request.expectedRevision) < 1)
  ) {
    return error('E_INVALID_PARAMS', 'expectedRevision must be a positive safe integer.')
  }
  if (
    request.command !== 'runtime.panic'
    &&
    request.expectedBindingId !== undefined
    && (typeof request.expectedBindingId !== 'string' || request.expectedBindingId.length === 0)
  ) {
    return error('E_INVALID_PARAMS', 'expectedBindingId must be a non-empty string.')
  }
  if (
    request.command !== 'runtime.panic'
    && request.expectedBindingId !== undefined
    && !DECK_COMMANDS.has(request.command)
  ) {
    return error('E_INVALID_PARAMS', 'expectedBindingId is only valid on deck commands.')
  }
  return null
}

function validateWhen(command: string, value: unknown): Validation<P0When> {
  if (value === undefined) return { value: { at: 'immediate' } }
  if (!isRecord(value) || !['immediate', 'nextBeat', 'nextBar'].includes(String(value.at))) {
    return { error: error('E_INVALID_PARAMS', 'when must use immediate, nextBeat, or nextBar.') }
  }
  const when = value as P0When
  if (when.at !== 'immediate') {
    if (IMMEDIATE_ONLY.has(command)) return { error: error('E_SCHEDULE_NOT_ALLOWED', `${command} is immediate-only.`) }
    if (SCHEDULABLE.has(command)) return { error: error('E_CAPABILITY_REQUIRED', 'Beat scheduling is not enabled by the P0 dispatcher.') }
  }
  return { value: when }
}

function parseHello(value: unknown): Validation<{ protocolVersions: string[]; role: 'ui' | 'agent' | 'observer' }> {
  if (!isRecord(value) || !Array.isArray(value.protocolVersions) || !value.protocolVersions.every((item) => typeof item === 'string') || !isRecord(value.client) || typeof value.client.name !== 'string' || typeof value.client.version !== 'string' || !['ui', 'agent', 'observer'].includes(String(value.role))) {
    return { error: error('E_INVALID_PARAMS', 'Invalid session.hello params.') }
  }
  return { value: { protocolVersions: value.protocolVersions as string[], role: value.role as 'ui' | 'agent' | 'observer' } }
}

function parseDeckParams(value: unknown): Validation<{ deckId: DeckId }> {
  const deck = parseDeckId(value)
  return 'error' in deck ? deck : { value: { deckId: deck.value } }
}

function parseDeckId(value: unknown): Validation<DeckId> {
  if (!isRecord(value) || (value.deckId !== 'A' && value.deckId !== 'B')) return { error: error('E_DECK_UNKNOWN', 'deckId must be A or B.') }
  return { value: value.deckId }
}

function parseLoad(value: unknown): Validation<DeckLoadParams> {
  const deck = parseDeckId(value)
  if ('error' in deck) return deck
  if (!isRecord(value) || !isRecord(value.source)) return { error: error('E_INVALID_PARAMS', 'deck.load requires source.') }
  let source: DeckLoadParams['source']
  if (value.source.kind === 'catalog' && typeof value.source.trackId === 'string' && value.source.trackId.length > 0) {
    source = { kind: 'catalog', trackId: value.source.trackId }
  } else if (value.source.kind === 'url' && typeof value.source.url === 'string' && typeof value.source.title === 'string') {
    source = { kind: 'url', url: value.source.url, title: value.source.title }
  } else return { error: error('E_INVALID_PARAMS', 'Invalid deck.load source.') }
  if (value.requireAnalysis !== undefined && typeof value.requireAnalysis !== 'boolean') return { error: error('E_INVALID_PARAMS', 'requireAnalysis must be boolean.') }
  if (value.replacePlaying !== undefined && typeof value.replacePlaying !== 'boolean') return { error: error('E_INVALID_PARAMS', 'replacePlaying must be boolean.') }
  if (value.initialPosition !== undefined && (!isRecord(value.initialPosition) || !finiteInRange(value.initialPosition.sourceSeconds, 0, Number.POSITIVE_INFINITY))) return { error: error('E_OUT_OF_RANGE', 'initialPosition.sourceSeconds must be non-negative.') }
  return { value: {
    deckId: deck.value,
    source,
    ...(value.requireAnalysis === undefined ? {} : { requireAnalysis: value.requireAnalysis }),
    ...(value.replacePlaying === undefined ? {} : { replacePlaying: value.replacePlaying }),
    ...(value.initialPosition === undefined ? {} : { initialPosition: { sourceSeconds: value.initialPosition.sourceSeconds as number } }),
  } }
}

function parseSeek(value: unknown): Validation<DeckSeekParams> {
  const deck = parseDeckId(value)
  if ('error' in deck) return deck
  if (!isRecord(value) || !isRecord(value.target)) return { error: error('E_INVALID_PARAMS', 'deck.seek requires target.') }
  const target = value.target
  let parsed: DeckSeekParams['target']
  if (target.type === 'sourceSeconds' && finiteInRange(target.sourceSeconds, 0, Number.POSITIVE_INFINITY)) parsed = { type: 'sourceSeconds', sourceSeconds: target.sourceSeconds as number }
  else if (target.type === 'beat' && nonNegativeInteger(target.beatIndex)) parsed = { type: 'beat', beatIndex: target.beatIndex as number }
  else if (target.type === 'bar' && nonNegativeInteger(target.barIndex)) parsed = { type: 'bar', barIndex: target.barIndex as number }
  else if (target.type === 'pad' && Number.isInteger(target.slot) && Number(target.slot) >= 1 && Number(target.slot) <= 8) parsed = { type: 'pad', slot: target.slot as number }
  else return { error: error('E_INVALID_PARAMS', 'Invalid seek target.') }
  if (value.resume !== undefined && !['keep', 'pause', 'play'].includes(String(value.resume))) return { error: error('E_INVALID_PARAMS', 'Invalid seek resume value.') }
  return { value: { deckId: deck.value, target: parsed, ...(value.resume === undefined ? {} : { resume: value.resume as DeckSeekParams['resume'] }) } }
}

function parseNumberParam(value: unknown, key: string, min: number, max: number, requireDeck: boolean): Validation<number> {
  if (!isRecord(value) || (requireDeck && value.deckId !== 'A' && value.deckId !== 'B') || !finiteInRange(value[key], min, max)) return { error: error('E_OUT_OF_RANGE', `${key} is outside the supported range.`) }
  return { value: value[key] as number }
}

function parseCancelFilter(value: unknown): Validation<ScheduleCancelFilter> {
  if (!isRecord(value) || !isRecord(value.filter)) return { error: error('E_INVALID_PARAMS', 'schedule.cancel requires filter.') }
  const filter = value.filter
  if (typeof filter.intentId === 'string' && filter.intentId) return { value: { intentId: filter.intentId } }
  if (filter.all === true) return { value: { all: true } }
  if (
    (filter.deckId === 'A' || filter.deckId === 'B')
    && (filter.domain === undefined || (typeof filter.domain === 'string' && INTENT_DOMAINS.has(filter.domain as IntentDomain)))
  ) return { value: { deckId: filter.deckId, ...(filter.domain === undefined ? {} : { domain: filter.domain as IntentDomain }) } }
  return { error: error('E_INVALID_PARAMS', 'Invalid schedule.cancel filter.') }
}

function parsePanic(value: unknown): Validation<'all' | DeckId | undefined> {
  if (!isRecord(value)) return { error: error('E_INVALID_PARAMS', 'runtime.panic params must be an object.') }
  if (value.scope === undefined) return { value: undefined }
  if (value.scope === 'all' || value.scope === 'A' || value.scope === 'B') return { value: value.scope }
  return { error: error('E_INVALID_PARAMS', 'Invalid panic scope.') }
}

function acceptedAck(requestId: string, intentId: string, revision: number): VdapAcceptedAck {
  return { vdap: VDAP_VERSION, kind: 'ack', requestId, state: 'accepted', intentId, revision }
}

function rejected(requestId: string, cause: VdapError): VdapRejectedAck {
  return { vdap: VDAP_VERSION, kind: 'ack', requestId, state: 'rejected', error: cause }
}

function rejectedError(requestId: string, code: Exclude<VdapError['code'], 'E_QUANTIZE_UNAVAILABLE' | 'E_SCHEDULE_IN_PAST'>, message: string): VdapRejectedAck {
  return rejected(requestId, error(code, message))
}

function userPriority(requestId: string): VdapRejectedAck {
  return rejectedError(requestId, 'E_USER_PRIORITY', 'A user Intent already owns this conflict domain.')
}

function error(code: Exclude<VdapError['code'], 'E_QUANTIZE_UNAVAILABLE' | 'E_SCHEDULE_IN_PAST'>, message: string, retryable = false): VdapError {
  return { code, message, retryable }
}

function audioError(cause: unknown, fallback: 'E_LOAD_FAILED' | 'E_INTERNAL' = 'E_INTERNAL'): VdapError {
  if (cause instanceof RuntimeAudioError) return cause.error
  return error(fallback, cause instanceof Error ? cause.message : 'Audio operation failed.', fallback === 'E_LOAD_FAILED')
}

function snapshotMessage(store: RuntimeStore): VdapSnapshot {
  return { vdap: VDAP_VERSION, kind: 'snapshot', ...cloneRuntimeState(store) }
}

function cloneRuntimeState(store: RuntimeStore): RuntimeState {
  return structuredClone(store.getSnapshot()) as RuntimeState
}

function isEmptyObject(value: unknown): boolean {
  return isRecord(value) && Object.keys(value).length === 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function finiteInRange(value: unknown, min: number, max: number): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
}

function nonNegativeInteger(value: unknown): boolean {
  return Number.isInteger(value) && Number(value) >= 0
}
