import {
  DECK_EQ_MAX_GAIN_DB,
  DECK_EQ_MIN_GAIN_DB,
  VDAP_VERSION,
  type CommandResult,
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
  type NextBarWhen,
  type NextBeatWhen,
  type P0When,
  type QuantizeUnavailableReason,
  type RampCrossfaderResult,
  type RuntimeState,
  type ScheduledFor,
  type ScheduleCancelFilter,
  type SyncResult,
  type TransitionStartParams,
  type TransitionStartResult,
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
import {
  RuntimeAudioError,
  type BeatTransitionAudioReservation,
  type RuntimeAudioPort,
} from './RuntimeAudioPort'
import { RuntimeIntentAdapter } from './RuntimeIntentAdapter'
import { RuntimeStore } from './RuntimeStore'
import { boundaryRuntimeTime, nextBoundarySeconds, rampPositionAt, resolveTempoSync } from './transition/beatMath'

/** Injected timers so the beat scheduler is deterministic under test. */
export type SchedulerTimerHandle = { readonly __timer: unique symbol } | ReturnType<typeof setTimeout>
export type SchedulerTimers = {
  setTimer: (callback: () => void, delayMs: number) => SchedulerTimerHandle
  clearTimer: (handle: SchedulerTimerHandle) => void
}

const DEFAULT_TIMERS: SchedulerTimers = {
  setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

const MAX_SCHEDULE_HORIZON_SECONDS = 60
const VELOCITY_RANGE = { min: 0.5, max: 1.5 }

export type CommandDispatcherOptions = {
  store: RuntimeStore
  audio: RuntimeAudioPort
  nextIntentId?: () => string
  runtime?: { name: string; version: string }
  /** Monotonic runtime clock used to resolve musical boundaries and horizons. */
  now?: () => number
  /** Test seam: overrides main-thread scheduling timers. */
  timers?: SchedulerTimers
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

/** A schedulable command's boundary-time execution and completion effect. */
/** In-range tempo-sync resolution ready to apply (out-of-range is rejected upstream). */
type ResolvedSync = { targetBpm: number; requestedVelocity: number; appliedVelocity: number; exact: boolean }

type ScheduledAction = {
  domain: Exclude<IntentDomain, 'binding'>
  target: IntentTarget
  referenceDeckId: DeckId
  bindingDependencies: readonly DeckId[]
  run: (execTime: number) => Promise<{ result: CommandResult; effect: RuntimeStateEffect }>
}

type ScheduledEntry = {
  intentId: string
  action: ScheduledAction
  when: NextBeatWhen | NextBarWhen
  referenceDeckId: DeckId
  /** The exact source-second boundary reserved at accept time. */
  targetSourceSeconds: number
  timer: SchedulerTimerHandle
}

type RampEntry = {
  intentId: string
  from: number
  to: number
  durationSeconds: number
  /** null until the automation actually starts (scheduled ramps before boundary). */
  startAtRuntimeTime: number | null
  referenceDeckId?: DeckId
  /** Reserved start boundary (source seconds) for a musically-scheduled ramp. */
  startTargetSourceSeconds?: number
  when?: NextBeatWhen | NextBarWhen
  degraded?: 'immediate'
  startTimer?: SchedulerTimerHandle
  completionTimer?: SchedulerTimerHandle
}

type AtomicTransitionEntry = {
  intentId: string
  activeDeckId: DeckId
  targetDeckId: DeckId
  targetBindingId: string
  from: number
  to: number
  startAtRuntimeTime: number
  startedAtRuntimeTime: number | null
  durationSeconds: number
  reservation: BeatTransitionAudioReservation
  sampleTimer?: SchedulerTimerHandle
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
  'transition.start',
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
  private readonly now: () => number
  private readonly timers: SchedulerTimers
  private readonly subscriptions = new Set<string>()
  private readonly intentOwners = new Map<string, IntentOwner>()
  /** Scheduled (non-ramp) musical intents awaiting their boundary. */
  private readonly scheduled = new Map<string, ScheduledEntry>()
  /** rampCrossfader lifecycles keyed by intentId (scheduled start + automation). */
  private readonly ramps = new Map<string, RampEntry>()
  /** Atomic play+ramp reservations keyed by their single VDAP Intent. */
  private readonly transitions = new Map<string, AtomicTransitionEntry>()

  constructor(options: CommandDispatcherOptions) {
    this.store = options.store
    this.audio = options.audio
    this.runtime = options.runtime ?? { name: 'Vibraxis Runtime', version: '0.1.0' }
    this.now = options.now ?? (() => performance.now() / 1000)
    this.timers = options.timers ?? DEFAULT_TIMERS
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
    this.reevaluateReferences(deckId)
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

    const when = validateWhen(request.command, request.when, this.beatSchedulingAvailable())
    if ('error' in when) return rejected(request.requestId, when.error)

    if (when.value.at !== 'immediate') {
      return this.scheduleCommand(request, context, when.value)
    }

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
      case 'deck.sync':
        return this.sync(request, context)
      case 'mixer.setCrossfader':
        return this.setCrossfader(request, context, when.value)
      case 'mixer.rampCrossfader':
        return this.rampCrossfader(request, context, when.value)
      case 'mixer.setMasterGain':
        return this.setMasterGain(request, context)
      case 'transition.start':
        return this.startTransition(request, context)
      case 'schedule.cancel':
        return this.cancelSchedule(request, context)
      case 'runtime.panic':
        return this.panic(request, context)
      default:
        return rejectedError(request.requestId, 'E_UNSUPPORTED_COMMAND', `${request.command} is not implemented by the P0 dispatcher.`)
    }
  }

  private beatSchedulingAvailable(): boolean {
    return typeof this.audio.playAt === 'function'
      && typeof this.audio.scheduleCrossfaderRamp === 'function'
      && typeof this.audio.stopCrossfaderRamp === 'function'
      && typeof this.audio.getGrid === 'function'
  }

  private atomicTransitionAvailable(): boolean {
    return this.beatSchedulingAvailable()
      && typeof this.audio.scheduleBeatTransition === 'function'
      && typeof this.audio.minimumTransitionLeadSeconds === 'number'
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
        profile: this.beatSchedulingAvailable() ? 'beat' : 'core',
        deckIds: ['A', 'B'],
        capabilities: {
          velocity: { min: VELOCITY_RANGE.min, max: VELOCITY_RANGE.max, reverse: false },
          grid: { source: 'analysis' },
          // Beat scheduling is only advertised when the audio adapter can queue
          // sample-accurate starts and ramps; otherwise musical `when` stays a
          // capability error rather than a silently-degraded approximation.
          ...(this.beatSchedulingAvailable()
            ? {
                // No toleranceSeconds: the main-thread-timer scheduler does not yet
                // guarantee a bounded execution tolerance, so we do not advertise one
                // (finding 7; VDAP §10.5, AGENTS §0.9/§0.10). Do not re-add 0.01 until
                // WebAudio ahead-of-boundary pre-reservation lands and is measured.
                quantize: { units: ['beat', 'bar'] as Array<'beat' | 'bar'> },
                crossfaderRamp: {
                  curves: ['equalPower'] as Array<'equalPower'>,
                  durationUnits: ['seconds', 'beats', 'bars'] as Array<'seconds' | 'beats' | 'bars'>,
                },
                ...(this.atomicTransitionAvailable()
                  ? {
                      beatTransition: {
                        atomic: true as const,
                        startUnits: ['bar'] as ['bar'],
                        durationUnits: ['bars'] as ['bars'],
                        toleranceSeconds: 0.01,
                        minimumLeadSeconds: this.audio.minimumTransitionLeadSeconds as number,
                      },
                    }
                  : {}),
              }
            : {}),
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
    this.cancelAtomicTransitionsForDeck(params.value.deckId, context.origin === 'user' ? 'userOverride' : 'clientCancel')
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
      // A pause removes forward motion; any schedule anchored to this deck's
      // grid can no longer advance and must fail now (VDAP §10.2), not linger.
      if (command === 'deck.pause') this.reevaluateReferences(params.value.deckId)
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
    this.cancelAtomicTransitionsForDeck(params.value.deckId, context.origin === 'user' ? 'userOverride' : 'clientCancel')
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
      if (params.value.resume === 'pause') this.reevaluateReferences(params.value.deckId)
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
    this.cancelAtomicTransitionsForDeck(deck.value, context.origin === 'user' ? 'userOverride' : 'clientCancel')
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

  private async sync(request: RuntimeRequestEnvelope, context: RuntimeRequestContext): Promise<DispatchResult> {
    const params = parseSync(request.params)
    if ('error' in params) return rejected(request.requestId, params.error)
    const precondition = this.deckPrecondition(request, params.value.deckId)
    if (precondition) return rejected(request.requestId, precondition)
    if (params.value.mode !== 'tempo') {
      // tempoPhase / tempoBar require the phaseSync capability, which the P0
      // runtime does not advertise. Reject rather than silently downgrade.
      return rejectedError(request.requestId, 'E_CAPABILITY_REQUIRED', 'Only tempo-only deck.sync is supported; phaseSync is not enabled.')
    }
    const resolved = this.resolveSync(params.value.deckId, params.value.reference)
    if ('error' in resolved) return rejected(request.requestId, resolved.error)
    const transitionCancelReason = context.origin === 'user' ? 'userOverride' : 'clientCancel'
    this.cancelAtomicTransitionsForDeck(params.value.deckId, transitionCancelReason)
    this.cancelAtomicTransitionsForDeck(params.value.reference, transitionCancelReason)
    const { follower, sync } = resolved.value
    const accepted = this.acceptGeneral(request, context, 'velocity', { deckId: follower }, { at: 'immediate' })
    if (!accepted.accepted) return accepted.rejection
    context.send(accepted.ack)
    this.routeForeignTerminals(accepted.cancelled)
    try {
      await this.audio.setVelocity(follower, sync.appliedVelocity)
      const terminal = this.intents.complete(accepted.intentId, syncResult(sync), undefined, (draft) =>
        applyVelocity(draft, follower, sync.appliedVelocity))
      return this.ownTerminal(terminal)
    } catch (cause) {
      const terminal = this.intents.fail(accepted.intentId, audioError(cause))
      return this.ownTerminal(terminal)
    }
  }

  /**
   * Resolves the exact tempo-only sync velocity from canonical tempo state.
   * Both decks MUST carry analysis-derived BPM; otherwise the follower value
   * would be invented, so it fails with E_ANALYSIS_UNAVAILABLE instead.
   */
  private resolveSync(follower: DeckId, reference: DeckId):
    | { value: { follower: DeckId; sync: ResolvedSync } }
    | { error: VdapError } {
    if (follower === reference) return { error: error('E_INVALID_PARAMS', 'deck.sync reference must differ from the follower deck.') }
    const snapshot = this.store.getSnapshot()
    const followerDeck = snapshot.decks[follower]
    const referenceDeck = snapshot.decks[reference]
    if (!followerDeck.binding) return { error: error('E_DECK_EMPTY', 'Follower deck has no binding.') }
    if (!referenceDeck.binding) return { error: error('E_DECK_EMPTY', 'Reference deck has no binding.') }
    const followerBpm = followerDeck.tempo.interpretedBpm
    const referenceBpm = referenceDeck.tempo.effectiveBpm
    if (followerBpm === null || referenceBpm === null) {
      return { error: error('E_ANALYSIS_UNAVAILABLE', 'Both decks require analysis BPM for tempo sync.') }
    }
    const resolution = resolveTempoSync(referenceBpm, followerBpm, VELOCITY_RANGE)
    if (!resolution.withinRange) {
      // AGENTS §0.6/§0.7, VDAP §11.11: the required rate is outside the runtime
      // velocity range. Reject without touching audio/state; never clamp.
      return {
        error: error(
          'E_OUT_OF_RANGE',
          `tempo sync requires playback rate ${resolution.requestedVelocity} outside [${VELOCITY_RANGE.min}, ${VELOCITY_RANGE.max}].`,
        ),
      }
    }
    return {
      value: {
        follower,
        sync: {
          targetBpm: resolution.targetBpm,
          requestedVelocity: resolution.requestedVelocity,
          appliedVelocity: resolution.requestedVelocity,
          exact: true,
        },
      },
    }
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

  /**
   * Resolves one bar boundary once, then asks the audio adapter to atomically
   * reserve target playback and the equal-power ramp on that exact timestamp.
   */
  private async startTransition(
    request: RuntimeRequestEnvelope,
    context: RuntimeRequestContext,
  ): Promise<DispatchResult> {
    if (request.expectedBindingId !== undefined) {
      return rejectedError(request.requestId, 'E_INVALID_PARAMS', 'transition.start carries both binding IDs in params.')
    }
    if (!this.atomicTransitionAvailable()) {
      return rejectedError(request.requestId, 'E_CAPABILITY_REQUIRED', 'Atomic beat transition audio scheduling is unavailable.')
    }
    const parsed = parseTransitionStart(request.params)
    if ('error' in parsed) return rejected(request.requestId, parsed.error)
    const params = parsed.value
    if (params.activeDeckId === params.targetDeckId) {
      return rejectedError(request.requestId, 'E_INVALID_PARAMS', 'activeDeckId and targetDeckId must differ.')
    }
    const snapshot = this.store.getSnapshot()
    const active = snapshot.decks[params.activeDeckId]
    const target = snapshot.decks[params.targetDeckId]
    if (active.binding?.bindingId !== params.activeBindingId || target.binding?.bindingId !== params.targetBindingId) {
      return rejectedError(request.requestId, 'E_BINDING_MISMATCH', 'transition.start binding IDs do not match the current decks.')
    }
    if (active.transport.phase !== 'playing') {
      return rejectedError(request.requestId, 'E_INVALID_PARAMS', 'The active deck must be playing.')
    }
    if (target.transport.phase !== 'ready') {
      return rejectedError(request.requestId, 'E_DECK_PLAYING', 'The target deck must be ready and not playing.')
    }
    const when: NextBarWhen = {
      at: 'nextBar',
      deckId: params.activeDeckId,
      ...(params.minConfidence === undefined ? {} : { minConfidence: params.minConfidence }),
    }
    const boundary = this.evaluateReference(params.activeDeckId, when)
    if (!boundary.ok) return rejected(request.requestId, quantizeUnavailable(boundary.reason))
    const leadSeconds = boundary.targetRuntimeTime - this.now()
    const minimumLead = this.audio.minimumTransitionLeadSeconds as number
    if (leadSeconds < minimumLead) {
      return rejectedError(
        request.requestId,
        'E_SCHEDULE_TOO_SOON',
        `The next bar provides ${leadSeconds} seconds lead; ${minimumLead} seconds is required.`,
      )
    }
    if (leadSeconds > MAX_SCHEDULE_HORIZON_SECONDS) {
      return rejectedError(request.requestId, 'E_HORIZON_EXCEEDED', 'The next bar is beyond the runtime horizon.')
    }
    const duration = this.resolveMusicalDuration(params.activeDeckId, params.crossfader.duration)
    if ('error' in duration) return rejected(request.requestId, duration.error)
    const from = snapshot.mixer.crossfader.effective
    const scheduledFor: ScheduledFor = { runtimeTime: boundary.targetRuntimeTime, estimate: false }
    const accepted = this.intents.accept({
      requestId: request.requestId,
      command: 'transition.start',
      origin: context.origin,
      target: { mixer: 'crossfader' },
      domain: 'crossfader',
      when,
      scheduledFor,
    })
    if (!accepted.accepted) return userPriority(request.requestId)
    const intentId = accepted.intent.intentId
    this.registerOwner(intentId, context, { mixer: 'crossfader' }, [params.activeDeckId, params.targetDeckId])
    context.send(acceptedAck(request.requestId, intentId, accepted.revision, scheduledFor))
    this.routeForeignTerminals(accepted.cancelled)

    let reservation: BeatTransitionAudioReservation
    try {
      reservation = await this.audio.scheduleBeatTransition!({
        targetDeckId: params.targetDeckId,
        from,
        to: params.crossfader.to,
        startAtRuntimeTime: boundary.targetRuntimeTime,
        durationSeconds: duration.value,
        curve: 'equalPower',
      })
    } catch (cause) {
      return this.ownTerminal(this.intents.fail(intentId, audioError(cause)))
    }
    if (!this.store.getSnapshot().intents[intentId]) {
      reservation.cancel(this.store.getSnapshot().mixer.crossfader.effective)
      return
    }
    const entry: AtomicTransitionEntry = {
      intentId,
      activeDeckId: params.activeDeckId,
      targetDeckId: params.targetDeckId,
      targetBindingId: params.targetBindingId,
      from,
      to: params.crossfader.to,
      startAtRuntimeTime: boundary.targetRuntimeTime,
      startedAtRuntimeTime: null,
      durationSeconds: duration.value,
      reservation,
    }
    this.transitions.set(intentId, entry)
    void reservation.started.then((position) => this.transitionStarted(intentId, position)).catch((cause) => {
      if (this.transitions.has(intentId)) this.transitionAudioFailed(intentId, cause)
    })
    void reservation.completed.then((completion) => this.transitionCompleted(intentId, completion)).catch((cause) => {
      if (this.transitions.has(intentId)) this.transitionAudioFailed(intentId, cause)
    })
    return
  }

  private transitionStarted(intentId: string, position: { sourceSeconds: number; atRuntimeTime: number }): void {
    const entry = this.transitions.get(intentId)
    if (!entry) return
    if (!this.intents.markExecuting(intentId)) {
      this.transitions.delete(intentId)
      entry.reservation.cancel()
      return
    }
    entry.startedAtRuntimeTime = position.atRuntimeTime
    this.store.update((draft) => {
      const target = draft.decks[entry.targetDeckId]
      target.transport.phase = 'playing'
      target.playback.position = position
      target.playback.headVelocity = target.playback.configuredVelocity
      target.playback.direction = 'forward'
      draft.mixer.crossfader.curve = 'equalPower'
      draft.mixer.crossfader.base = entry.from
      draft.mixer.crossfader.effective = entry.from
      draft.mixer.crossfader.automation = {
        intentId,
        from: entry.from,
        to: entry.to,
        startedAtRuntimeTime: position.atRuntimeTime,
        durationSecondsEstimate: entry.durationSeconds,
      }
    })
    this.armTransitionSample(intentId)
  }

  private armTransitionSample(intentId: string): void {
    const entry = this.transitions.get(intentId)
    if (!entry) return
    entry.sampleTimer = this.timers.setTimer(() => this.sampleTransition(intentId), 50)
  }

  private sampleTransition(intentId: string): void {
    const entry = this.transitions.get(intentId)
    if (!entry || entry.startedAtRuntimeTime === null) return
    entry.sampleTimer = undefined
    const sample = entry.reservation.sample()
    this.store.update((draft) => {
      if (draft.mixer.crossfader.automation?.intentId !== intentId) return
      draft.decks[entry.targetDeckId].playback.position = sample.targetPosition
      draft.mixer.crossfader.base = sample.holdPosition
      draft.mixer.crossfader.effective = sample.holdPosition
    })
    this.armTransitionSample(intentId)
  }

  private transitionCompleted(
    intentId: string,
    completion: { endedAtRuntimeTime: number; targetPosition: { sourceSeconds: number; atRuntimeTime: number } },
  ): void {
    const entry = this.transitions.get(intentId)
    if (!entry) return
    this.transitions.delete(intentId)
    if (entry.sampleTimer) this.timers.clearTimer(entry.sampleTimer)
    const result: TransitionStartResult = {
      targetDeckId: entry.targetDeckId,
      targetBindingId: entry.targetBindingId,
      targetPosition: completion.targetPosition,
      from: entry.from,
      to: entry.to,
      startedAtRuntimeTime: entry.startedAtRuntimeTime,
      endedAtRuntimeTime: completion.endedAtRuntimeTime,
      durationSeconds: entry.durationSeconds,
    }
    this.deliver(this.intents.complete(intentId, result, undefined, (draft) => {
      draft.decks[entry.targetDeckId].playback.position = completion.targetPosition
      draft.mixer.crossfader.base = entry.to
      draft.mixer.crossfader.effective = entry.to
      draft.mixer.crossfader.curve = 'equalPower'
      draft.mixer.crossfader.automation = null
    }))
  }

  private transitionAudioFailed(intentId: string, cause: unknown): void {
    const entry = this.transitions.get(intentId)
    if (!entry) return
    this.transitions.delete(intentId)
    if (entry.sampleTimer) this.timers.clearTimer(entry.sampleTimer)
    const cancelled = entry.reservation.cancel()
    this.deliver(this.intents.fail(intentId, audioError(cause), undefined, (draft) => {
      const target = draft.decks[entry.targetDeckId]
      target.transport.phase = 'ready'
      target.playback.position = cancelled.targetPosition
      target.playback.headVelocity = 0
      target.playback.direction = 'stopped'
      draft.mixer.crossfader.base = cancelled.holdPosition
      draft.mixer.crossfader.effective = cancelled.holdPosition
      draft.mixer.crossfader.automation = null
    }))
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
      for (const deckId of (scope.value && scope.value !== 'all' ? [scope.value] : ['A', 'B'] as DeckId[])) {
        this.reevaluateReferences(deckId)
      }
      return this.ownTerminal(completion.terminal)
    } catch (cause) {
      const terminal = this.intents.fail(accepted.intent.intentId, audioError(cause))
      return this.ownTerminal(terminal)
    }
  }

  // ── Beat scheduling (order 4) ───────────────────────────────────────────

  /**
   * Routes a musically-scheduled mutation. rampCrossfader owns its own two-phase
   * lifecycle; every other schedulable command runs once at the boundary.
   */
  private async scheduleCommand(
    request: RuntimeRequestEnvelope,
    context: RuntimeRequestContext,
    when: NextBeatWhen | NextBarWhen,
  ): Promise<DispatchResult> {
    if (request.command === 'mixer.rampCrossfader') {
      return this.rampCrossfader(request, context, when)
    }
    const built = this.buildScheduledAction(request, context, when)
    if ('error' in built) return rejected(request.requestId, built.error)
    const action = built.action
    const feasibility = this.evaluateReference(action.referenceDeckId, when)
    if (!feasibility.ok) {
      if (when.onGridUnavailable === 'immediate') {
        return this.executeDegraded(request, context, action)
      }
      return rejected(request.requestId, quantizeUnavailable(feasibility.reason))
    }
    const now = this.now()
    if (feasibility.targetRuntimeTime - now > MAX_SCHEDULE_HORIZON_SECONDS) {
      return rejectedError(request.requestId, 'E_HORIZON_EXCEEDED', 'Scheduled boundary is beyond the runtime horizon.')
    }
    const scheduledFor: ScheduledFor = { runtimeTime: feasibility.targetRuntimeTime, estimate: true }
    const accepted = this.intents.accept({
      requestId: request.requestId,
      command: request.command as Exclude<VdapMutationCommand, 'deck.load' | 'deck.unload'>,
      origin: context.origin,
      target: action.target,
      domain: action.domain,
      when,
      scheduledFor,
    })
    if (!accepted.accepted) return userPriority(request.requestId)
    this.registerOwner(accepted.intent.intentId, context, action.target, action.bindingDependencies)
    context.send(acceptedAck(request.requestId, accepted.intent.intentId, accepted.revision, scheduledFor))
    this.routeForeignTerminals(accepted.cancelled)
    this.armScheduled(accepted.intent.intentId, action, when, feasibility.targetSourceSeconds, feasibility.targetRuntimeTime)
    return
  }

  private armScheduled(
    intentId: string,
    action: ScheduledAction,
    when: NextBeatWhen | NextBarWhen,
    targetSourceSeconds: number,
    targetRuntimeTime: number,
  ): void {
    const delaySeconds = targetRuntimeTime - this.now()
    if (delaySeconds < 0) {
      this.deliver(this.intents.fail(intentId, scheduleInPast('The resolved boundary passed before it could be armed.')))
      return
    }
    const delayMs = delaySeconds * 1000
    const timer = this.timers.setTimer(() => { void this.fireScheduled(intentId) }, delayMs)
    this.scheduled.set(intentId, { intentId, action, when, referenceDeckId: action.referenceDeckId, targetSourceSeconds, timer })
  }

  private async fireScheduled(intentId: string): Promise<void> {
    const entry = this.scheduled.get(intentId)
    if (!entry) return
    this.scheduled.delete(intentId)
    const feasibility = this.reprojectReference(entry.referenceDeckId, entry.when, entry.targetSourceSeconds)
    if (!feasibility.ok) {
      this.deliver(this.intents.fail(intentId, quantizeUnavailable(feasibility.reason)))
      return
    }
    if (!this.intents.markExecuting(intentId)) return
    try {
      const { result, effect } = await entry.action.run(feasibility.targetRuntimeTime)
      this.deliver(this.intents.complete(intentId, result, undefined, effect))
    } catch (cause) {
      this.deliver(this.intents.fail(intentId, audioError(cause)))
    }
  }

  private async executeDegraded(
    request: RuntimeRequestEnvelope,
    context: RuntimeRequestContext,
    action: ScheduledAction,
  ): Promise<DispatchResult> {
    const accepted = this.intents.accept({
      requestId: request.requestId,
      command: request.command as Exclude<VdapMutationCommand, 'deck.load' | 'deck.unload'>,
      origin: context.origin,
      target: action.target,
      domain: action.domain,
      when: { at: 'immediate' },
    })
    if (!accepted.accepted) return userPriority(request.requestId)
    this.registerOwner(accepted.intent.intentId, context, action.target, action.bindingDependencies)
    context.send(acceptedAck(request.requestId, accepted.intent.intentId, accepted.revision))
    this.routeForeignTerminals(accepted.cancelled)
    try {
      const { result, effect } = await action.run(this.now())
      return this.ownTerminal(this.intents.complete(accepted.intent.intentId, result, 'immediate', effect))
    } catch (cause) {
      return this.ownTerminal(this.intents.fail(accepted.intent.intentId, audioError(cause)))
    }
  }

  /**
   * Shared reference-deck feasibility (VDAP §10.2): binding + available grid,
   * confidence threshold, and forward advancement. Returns the extrapolated
   * current source second and the boundary array for the requested unit.
   */
  private referenceState(
    deckId: DeckId,
    when: NextBeatWhen | NextBarWhen,
  ):
    | { ok: true; currentSource: number; headVelocity: number; boundaries: number[] }
    | { ok: false; reason: QuantizeUnavailableReason } {
    const deck = this.store.getSnapshot().decks[deckId]
    if (!deck.binding || !deck.binding.analysis || deck.binding.analysis.grid.available === false) {
      return { ok: false, reason: 'noGrid' }
    }
    const grid = this.audio.getGrid?.(deck.binding.bindingId)
    if (!grid) return { ok: false, reason: 'noGrid' }
    if (when.minConfidence !== undefined && (grid.confidence === null || grid.confidence < when.minConfidence)) {
      return { ok: false, reason: 'lowConfidence' }
    }
    const headVelocity = deck.playback.headVelocity
    if (deck.transport.phase !== 'playing' || headVelocity <= 0 || deck.playback.direction !== 'forward') {
      return { ok: false, reason: 'notAdvancing' }
    }
    const now = this.now()
    const currentSource = deck.playback.position.sourceSeconds
      + (now - deck.playback.position.atRuntimeTime) * headVelocity
    const boundaries = when.at === 'nextBar' ? grid.downbeatsSeconds : grid.beatsSeconds
    return { ok: true, currentSource, headVelocity, boundaries }
  }

  /**
   * Picks the first boundary strictly after the reference deck's current
   * position and projects its runtime time (VDAP §10.3). Never extrapolates
   * past the grid.
   */
  private evaluateReference(
    deckId: DeckId,
    when: NextBeatWhen | NextBarWhen,
  ):
    | { ok: true; targetSourceSeconds: number; targetRuntimeTime: number }
    | { ok: false; reason: QuantizeUnavailableReason } {
    const state = this.referenceState(deckId, when)
    if (!state.ok) return state
    const targetSourceSeconds = nextBoundarySeconds(state.boundaries, state.currentSource)
    if (targetSourceSeconds === null) return { ok: false, reason: 'beyondGrid' }
    const targetRuntimeTime = boundaryRuntimeTime(
      { sourceSeconds: state.currentSource, atRuntimeTime: this.now() },
      state.headVelocity,
      targetSourceSeconds,
    )
    return { ok: true, targetSourceSeconds, targetRuntimeTime }
  }

  /**
   * Re-projects an already-reserved boundary at fire time. The reserved source
   * second is kept unless the head has genuinely overshot it (a late timer /
   * velocity change), in which case it defers to the next future boundary — it
   * never skips a boundary the head is exactly on.
   */
  private reprojectReference(
    deckId: DeckId,
    when: NextBeatWhen | NextBarWhen,
    reservedTargetSource: number,
  ):
    | { ok: true; targetRuntimeTime: number }
    | { ok: false; reason: QuantizeUnavailableReason } {
    const state = this.referenceState(deckId, when)
    if (!state.ok) return state
    let targetSource = reservedTargetSource
    if (state.currentSource > reservedTargetSource) {
      const next = nextBoundarySeconds(state.boundaries, state.currentSource)
      if (next === null) return { ok: false, reason: 'beyondGrid' }
      targetSource = next
    }
    const targetRuntimeTime = this.now() + (targetSource - state.currentSource) / state.headVelocity
    return { ok: true, targetRuntimeTime }
  }

  private buildScheduledAction(
    request: RuntimeRequestEnvelope,
    context: RuntimeRequestContext,
    when: NextBeatWhen | NextBarWhen,
  ): { action: ScheduledAction } | { error: VdapError } {
    const command = request.command
    if (command === 'deck.play' || command === 'deck.pause') {
      const params = parseDeckParams(request.params)
      if ('error' in params) return params
      const pre = this.deckPrecondition(request, params.value.deckId)
      if (pre) return { error: pre }
      const deckId = params.value.deckId
      if (command === 'deck.play' && !this.store.getSnapshot().decks[deckId].binding) {
        return { error: error('E_DECK_EMPTY', 'Deck has no binding.') }
      }
      return {
        action: {
          domain: 'transport',
          target: { deckId },
          referenceDeckId: when.deckId ?? deckId,
          // The reserved boundary is derived from the reference deck's grid, so a
          // binding change there must invalidate this schedule (finding 5, §10.2).
          bindingDependencies: [deckId, when.deckId ?? deckId],
          run: async (execTime) => {
            const position = command === 'deck.play'
              ? await (this.audio.playAt ? this.audio.playAt(deckId, execTime) : this.audio.play(deckId))
              : await this.audio.pause(deckId)
            return {
              result: {},
              effect: (draft) => {
                applyTransport(draft, deckId, command)
                draft.decks[deckId].playback.position = position
              },
            }
          },
        },
      }
    }
    if (command === 'deck.seek') {
      const params = parseSeek(request.params)
      if ('error' in params) return params
      const pre = this.deckPrecondition(request, params.value.deckId)
      if (pre) return { error: pre }
      if (!this.store.getSnapshot().decks[params.value.deckId].binding) {
        return { error: error('E_DECK_EMPTY', 'Deck has no binding.') }
      }
      const seek = params.value
      return {
        action: {
          domain: 'transport',
          target: { deckId: seek.deckId },
          referenceDeckId: when.deckId ?? seek.deckId,
          bindingDependencies: [seek.deckId, when.deckId ?? seek.deckId],
          run: async () => {
            const position = await this.audio.seek(seek.deckId, { target: seek.target, resume: seek.resume ?? 'keep' })
            return { result: { position }, effect: (draft) => applySeek(draft, seek.deckId, position, seek.resume) }
          },
        },
      }
    }
    if (command === 'deck.setGain') {
      const deck = parseDeckId(request.params)
      if ('error' in deck) return deck
      const gain = parseNumberParam(request.params, 'gain', 0, 1.5, false)
      if ('error' in gain) return gain
      const pre = this.deckPrecondition(request, deck.value)
      if (pre) return { error: pre }
      return {
        action: {
          domain: 'gain', target: { deckId: deck.value }, referenceDeckId: when.deckId ?? deck.value,
          bindingDependencies: [deck.value, when.deckId ?? deck.value],
          run: async () => {
            await this.audio.setGain(deck.value, gain.value)
            return { result: {}, effect: (draft) => { draft.decks[deck.value].gain = gain.value } }
          },
        },
      }
    }
    if (command === 'deck.setVelocity') {
      const deck = parseDeckId(request.params)
      if ('error' in deck) return deck
      const velocity = parseNumberParam(request.params, 'velocity', VELOCITY_RANGE.min, VELOCITY_RANGE.max, false)
      if ('error' in velocity) return velocity
      const pre = this.deckPrecondition(request, deck.value)
      if (pre) return { error: pre }
      return {
        action: {
          domain: 'velocity', target: { deckId: deck.value }, referenceDeckId: when.deckId ?? deck.value,
          bindingDependencies: [deck.value, when.deckId ?? deck.value],
          run: async () => {
            await this.audio.setVelocity(deck.value, velocity.value)
            return { result: {}, effect: (draft) => applyVelocity(draft, deck.value, velocity.value) }
          },
        },
      }
    }
    if (command === 'deck.sync') {
      const params = parseSync(request.params)
      if ('error' in params) return params
      const pre = this.deckPrecondition(request, params.value.deckId)
      if (pre) return { error: pre }
      if (params.value.mode !== 'tempo') {
        return { error: error('E_CAPABILITY_REQUIRED', 'Only tempo-only deck.sync is supported; phaseSync is not enabled.') }
      }
      const check = this.resolveSync(params.value.deckId, params.value.reference)
      if ('error' in check) return check
      const follower = params.value.deckId
      const reference = params.value.reference
      return {
        action: {
          domain: 'velocity', target: { deckId: follower }, referenceDeckId: when.deckId ?? follower,
          bindingDependencies: [follower, reference, when.deckId ?? follower],
          run: async () => {
            const resolved = this.resolveSync(follower, reference)
            if ('error' in resolved) throw new RuntimeAudioError(resolved.error)
            const sync = resolved.value.sync
            await this.audio.setVelocity(follower, sync.appliedVelocity)
            return { result: syncResult(sync), effect: (draft) => applyVelocity(draft, follower, sync.appliedVelocity) }
          },
        },
      }
    }
    if (command === 'mixer.setCrossfader') {
      const position = parseNumberParam(request.params, 'position', -1, 1, false)
      if ('error' in position) return position
      if (when.deckId === undefined) return { error: error('E_INVALID_PARAMS', 'Musical when on a mixer command requires deckId.') }
      return {
        action: {
          domain: 'crossfader', target: { mixer: 'crossfader' }, referenceDeckId: when.deckId,
          bindingDependencies: [when.deckId],
          run: async () => {
            await this.audio.setCrossfader(position.value)
            return {
              result: {},
              effect: (draft) => {
                draft.mixer.crossfader.base = position.value
                draft.mixer.crossfader.effective = position.value
                draft.mixer.crossfader.curve = 'dj'
                draft.mixer.crossfader.automation = null
              },
            }
          },
        },
      }
    }
    return { error: error('E_SCHEDULE_NOT_ALLOWED', `${command} does not support musical scheduling.`) }
  }

  // ── mixer.rampCrossfader ────────────────────────────────────────────────

  private async rampCrossfader(
    request: RuntimeRequestEnvelope,
    context: RuntimeRequestContext,
    when: P0When,
  ): Promise<DispatchResult> {
    if (request.expectedBindingId !== undefined) {
      return rejectedError(request.requestId, 'E_INVALID_PARAMS', 'Mixer commands cannot carry expectedBindingId.')
    }
    if (!this.beatSchedulingAvailable()) {
      return rejectedError(request.requestId, 'E_CAPABILITY_REQUIRED', 'The audio adapter does not support crossfader ramps.')
    }
    const params = parseRamp(request.params)
    if ('error' in params) return rejected(request.requestId, params.error)
    const { to, duration } = params.value

    // Reference deck (musical duration and/or musical start) feasibility.
    let durationSeconds: number
    if ('seconds' in duration) {
      durationSeconds = duration.seconds
    } else {
      if (params.value.referenceDeckId === undefined) {
        return rejectedError(request.requestId, 'E_INVALID_PARAMS', 'bars/beats duration requires referenceDeckId.')
      }
      const resolved = this.resolveMusicalDuration(params.value.referenceDeckId, duration)
      if ('error' in resolved) return rejected(request.requestId, resolved.error)
      durationSeconds = resolved.value
    }

    if (when.at !== 'immediate' && when.deckId === undefined) {
      return rejectedError(request.requestId, 'E_INVALID_PARAMS', 'Musical ramp start requires when.deckId.')
    }

    const from = this.store.getSnapshot().mixer.crossfader.effective

    if (when.at === 'immediate') {
      const startAt = this.now()
      const accepted = this.acceptGeneral(request, context, 'crossfader', { mixer: 'crossfader' }, { at: 'immediate' })
      if (!accepted.accepted) return accepted.rejection
      context.send(accepted.ack)
      this.routeForeignTerminals(accepted.cancelled)
      await this.startRamp(accepted.intentId, from, to, startAt, durationSeconds)
      return
    }

    // Musical start: reserve at the reference deck's next boundary.
    const feasibility = this.evaluateReference(when.deckId!, when)
    if (!feasibility.ok) {
      if (when.onGridUnavailable === 'immediate') {
        const startAt = this.now()
        const accepted = this.acceptGeneral(request, context, 'crossfader', { mixer: 'crossfader' }, { at: 'immediate' })
        if (!accepted.accepted) return accepted.rejection
        context.send(accepted.ack)
        this.routeForeignTerminals(accepted.cancelled)
        await this.startRamp(accepted.intentId, from, to, startAt, durationSeconds, 'immediate')
        return
      }
      return rejected(request.requestId, quantizeUnavailable(feasibility.reason))
    }
    if (feasibility.targetRuntimeTime - this.now() > MAX_SCHEDULE_HORIZON_SECONDS) {
      return rejectedError(request.requestId, 'E_HORIZON_EXCEEDED', 'Scheduled ramp start is beyond the runtime horizon.')
    }
    const scheduledFor: ScheduledFor = { runtimeTime: feasibility.targetRuntimeTime, estimate: true }
    const accepted = this.intents.accept({
      requestId: request.requestId,
      command: 'mixer.rampCrossfader',
      origin: context.origin,
      target: { mixer: 'crossfader' },
      domain: 'crossfader',
      when,
      scheduledFor,
    })
    if (!accepted.accepted) return userPriority(request.requestId)
    const intentId = accepted.intent.intentId
    // The ramp's reserved start boundary comes from the reference deck's grid, so
    // a binding change there must cancel this scheduled ramp (finding 5, §10.2).
    this.registerOwner(intentId, context, { mixer: 'crossfader' }, [when.deckId!])
    context.send(acceptedAck(request.requestId, intentId, accepted.revision, scheduledFor))
    this.routeForeignTerminals(accepted.cancelled)
    const startAt = feasibility.targetRuntimeTime
    const entry: RampEntry = {
      intentId, from, to, durationSeconds,
      startAtRuntimeTime: null,
      referenceDeckId: when.deckId,
      startTargetSourceSeconds: feasibility.targetSourceSeconds,
      when,
    }
    this.ramps.set(intentId, entry)
    const delaySeconds = startAt - this.now()
    if (delaySeconds < 0) {
      this.ramps.delete(intentId)
      return this.ownTerminal(this.intents.fail(intentId, scheduleInPast('The ramp boundary passed before it could be armed.'), rampResult(entry, this.now())))
    }
    const delayMs = delaySeconds * 1000
    entry.startTimer = this.timers.setTimer(() => { void this.beginScheduledRamp(intentId) }, delayMs)
    return
  }

  private async beginScheduledRamp(intentId: string): Promise<void> {
    const entry = this.ramps.get(intentId)
    if (!entry) return
    entry.startTimer = undefined
    let startAt = this.now()
    if (entry.referenceDeckId && entry.when && entry.startTargetSourceSeconds !== undefined) {
      const feasibility = this.reprojectReference(entry.referenceDeckId, entry.when, entry.startTargetSourceSeconds)
      if (!feasibility.ok) {
        this.ramps.delete(intentId)
        this.deliver(this.intents.fail(intentId, quantizeUnavailable(feasibility.reason), rampResult(entry, this.now())))
        return
      }
      startAt = feasibility.targetRuntimeTime
    }
    if (!this.intents.markExecuting(intentId)) {
      this.ramps.delete(intentId)
      return
    }
    await this.startRamp(intentId, entry.from, entry.to, startAt, entry.durationSeconds, undefined, entry)
  }

  /**
   * Begins the audio automation and arms the completion timer. `existing`
   * reuses an already-accepted (scheduled) intent; otherwise the caller has
   * accepted an immediate ramp intent under `intentId`.
   */
  private async startRamp(
    intentId: string,
    from: number,
    to: number,
    startAtRuntimeTime: number,
    durationSeconds: number,
    degraded?: 'immediate',
    existing?: RampEntry,
  ): Promise<void> {
    const entry: RampEntry = existing ?? { intentId, from, to, durationSeconds, startAtRuntimeTime: null }
    entry.startAtRuntimeTime = startAtRuntimeTime
    entry.degraded = degraded
    this.ramps.set(intentId, entry)
    try {
      await this.audio.scheduleCrossfaderRamp?.({ from, to, startAtRuntimeTime, durationSeconds, curve: 'equalPower' })
    } catch (cause) {
      this.ramps.delete(intentId)
      this.deliver(this.intents.fail(intentId, audioError(cause), rampResult(entry, this.now())))
      return
    }
    this.store.update((draft) => {
      draft.mixer.crossfader.curve = 'equalPower'
      draft.mixer.crossfader.base = from
      draft.mixer.crossfader.effective = from
      draft.mixer.crossfader.automation = {
        intentId, from, to, startedAtRuntimeTime: startAtRuntimeTime, durationSecondsEstimate: durationSeconds,
      }
    })
    const remainingSeconds = startAtRuntimeTime + durationSeconds - this.now()
    if (remainingSeconds < 0) {
      this.ramps.delete(intentId)
      this.deliver(this.intents.fail(intentId, scheduleInPast('The ramp end passed before completion could be armed.'), rampResult(entry, this.now())))
      return
    }
    const remainingMs = remainingSeconds * 1000
    entry.completionTimer = this.timers.setTimer(() => this.completeRamp(intentId), remainingMs)
  }

  private completeRamp(intentId: string): void {
    const entry = this.ramps.get(intentId)
    if (!entry) return
    this.ramps.delete(intentId)
    const endedAt = this.now()
    const terminal = this.intents.complete(
      intentId,
      rampResult(entry, endedAt),
      entry.degraded,
      (draft) => {
        draft.mixer.crossfader.base = entry.to
        draft.mixer.crossfader.effective = entry.to
        draft.mixer.crossfader.curve = 'equalPower'
        draft.mixer.crossfader.automation = null
      },
    )
    this.deliver(terminal)
  }

  private resolveMusicalDuration(
    deckId: DeckId,
    duration: { bars: number } | { beats: number },
  ): { value: number } | { error: VdapError } {
    const deck = this.store.getSnapshot().decks[deckId]
    if (!deck.binding || !deck.binding.analysis) return { error: quantizeUnavailable('noGrid') }
    const effectiveBpm = deck.tempo.effectiveBpm
    if (effectiveBpm === null || effectiveBpm <= 0) return { error: quantizeUnavailable('notAdvancing') }
    const secondsPerBeat = 60 / effectiveBpm
    const beats = 'bars' in duration ? duration.bars * deck.binding.analysis.beatsPerBar : duration.beats
    return { value: beats * secondsPerBeat }
  }

  /** Re-evaluates reference-dependent schedules/ramps after a deck stops advancing. */
  private reevaluateReferences(deckId: DeckId): void {
    for (const entry of [...this.transitions.values()]) {
      if (entry.activeDeckId !== deckId) continue
      const event = this.intents.fail(entry.intentId, quantizeUnavailable('notAdvancing'))
      if (event) this.routeForeignTerminals([event])
    }
    for (const entry of [...this.scheduled.values()]) {
      if (entry.referenceDeckId !== deckId) continue
      const feasibility = this.evaluateReference(deckId, entry.when)
      if (feasibility.ok) continue
      this.timers.clearTimer(entry.timer)
      this.scheduled.delete(entry.intentId)
      this.deliver(this.intents.fail(entry.intentId, quantizeUnavailable(feasibility.reason)))
    }
    for (const entry of [...this.ramps.values()]) {
      if (entry.referenceDeckId !== deckId) continue
      const feasibility = this.evaluateReference(deckId, { at: 'nextBar', deckId })
      if (feasibility.ok) continue
      this.clearRampTimers(entry)
      this.ramps.delete(entry.intentId)
      if (entry.startAtRuntimeTime !== null) {
        void this.audio.stopCrossfaderRamp?.(rampPositionAt(entry.from, entry.to, entry.startAtRuntimeTime, entry.durationSeconds, this.now()))
      }
      this.deliver(this.intents.fail(entry.intentId, quantizeUnavailable(feasibility.reason), rampResult(entry, this.now()), (draft) => {
        if (draft.mixer.crossfader.automation?.intentId === entry.intentId) draft.mixer.crossfader.automation = null
      }))
    }
  }

  private clearRampTimers(entry: RampEntry): void {
    if (entry.startTimer) this.timers.clearTimer(entry.startTimer)
    if (entry.completionTimer) this.timers.clearTimer(entry.completionTimer)
    entry.startTimer = undefined
    entry.completionTimer = undefined
  }

  private cancelAtomicTransitionsForDeck(deckId: DeckId, reason: 'userOverride' | 'clientCancel'): void {
    for (const entry of [...this.transitions.values()]) {
      if (entry.activeDeckId !== deckId && entry.targetDeckId !== deckId) continue
      const event = this.intents.cancel(entry.intentId, reason)
      if (event) this.routeForeignTerminals([event])
    }
  }

  /**
   * Stops audio + timers for scheduled/ramp intents that were terminated by
   * another path (user override, panic, schedule.cancel, binding change) and
   * attaches the required ramp terminal result to those events.
   */
  private cleanupTerminatedSchedules(events: readonly IntentTerminalEvent[]): void {
    for (const event of events) {
      const transition = this.transitions.get(event.intentId)
      if (transition) {
        this.transitions.delete(event.intentId)
        if (transition.sampleTimer) this.timers.clearTimer(transition.sampleTimer)
        const cancelled = transition.reservation.cancel()
        this.store.update((draft) => {
          const target = draft.decks[transition.targetDeckId]
          target.transport.phase = 'ready'
          target.playback.position = cancelled.targetPosition
          target.playback.headVelocity = 0
          target.playback.direction = 'stopped'
          draft.mixer.crossfader.base = cancelled.holdPosition
          draft.mixer.crossfader.effective = cancelled.holdPosition
          draft.mixer.crossfader.curve = 'equalPower'
          draft.mixer.crossfader.automation = null
        })
        if (event.event === 'intent.cancelled' || event.event === 'intent.failed') {
          ;(event as { result?: CommandResult }).result = {
            targetDeckId: transition.targetDeckId,
            targetBindingId: transition.targetBindingId,
            targetPosition: cancelled.targetPosition,
            from: transition.from,
            to: transition.to,
            startedAtRuntimeTime: transition.startedAtRuntimeTime,
            endedAtRuntimeTime: this.now(),
            durationSeconds: cancelled.progressedDurationSeconds,
          } satisfies TransitionStartResult
        }
      }
      const scheduled = this.scheduled.get(event.intentId)
      if (scheduled) {
        this.timers.clearTimer(scheduled.timer)
        this.scheduled.delete(event.intentId)
      }
      const ramp = this.ramps.get(event.intentId)
      if (!ramp) continue
      this.clearRampTimers(ramp)
      this.ramps.delete(event.intentId)
      const holdPosition = ramp.startAtRuntimeTime === null
        ? ramp.from
        : rampPositionAt(ramp.from, ramp.to, ramp.startAtRuntimeTime, ramp.durationSeconds, this.now())
      if (ramp.startAtRuntimeTime !== null) void this.audio.stopCrossfaderRamp?.(holdPosition)
      if (event.event === 'intent.cancelled' || event.event === 'intent.failed') {
        // §11.12: every ramp terminal MUST carry the ramp result.
        ;(event as { result?: CommandResult }).result = rampResult(ramp, this.now())
      }
    }
  }

  private deliver(event: IntentTerminalEvent | null): void {
    if (!event) return
    const owner = this.intentOwners.get(event.intentId)
    this.intentOwners.delete(event.intentId)
    owner?.send(event)
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
    this.cleanupTerminatedSchedules(events)
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

function validateWhen(command: string, value: unknown, beatScheduling: boolean): Validation<P0When> {
  if (value === undefined) return { value: { at: 'immediate' } }
  if (!isRecord(value)) return { error: error('E_INVALID_PARAMS', 'when must be an object.') }
  const at = String(value.at)
  if (!['immediate', 'nextBeat', 'nextBar'].includes(at)) {
    return { error: error('E_INVALID_PARAMS', 'when must use immediate, nextBeat, or nextBar.') }
  }
  if (at === 'immediate') return { value: { at: 'immediate' } }

  if (IMMEDIATE_ONLY.has(command) || !SCHEDULABLE.has(command)) {
    return { error: error('E_SCHEDULE_NOT_ALLOWED', `${command} is immediate-only.`) }
  }
  if (!beatScheduling) {
    return { error: error('E_CAPABILITY_REQUIRED', 'Musical scheduling requires the quantize capability, which is not available.') }
  }
  if (value.deckId !== undefined && value.deckId !== 'A' && value.deckId !== 'B') {
    return { error: error('E_INVALID_PARAMS', 'when.deckId must be A or B.') }
  }
  if (value.onGridUnavailable !== undefined && value.onGridUnavailable !== 'reject' && value.onGridUnavailable !== 'immediate') {
    return { error: error('E_INVALID_PARAMS', 'when.onGridUnavailable must be reject or immediate.') }
  }
  if (
    value.minConfidence !== undefined
    && !(typeof value.minConfidence === 'number' && value.minConfidence >= 0 && value.minConfidence <= 1)
  ) {
    return { error: error('E_INVALID_PARAMS', 'when.minConfidence must be between 0 and 1.') }
  }
  const when = {
    at: at as 'nextBeat' | 'nextBar',
    ...(value.deckId === undefined ? {} : { deckId: value.deckId as DeckId }),
    ...(value.onGridUnavailable === undefined ? {} : { onGridUnavailable: value.onGridUnavailable as 'reject' | 'immediate' }),
    ...(value.minConfidence === undefined ? {} : { minConfidence: value.minConfidence as number }),
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

function parseSync(value: unknown): Validation<{ deckId: DeckId; reference: DeckId; mode: 'tempo' | 'tempoPhase' | 'tempoBar' }> {
  const deck = parseDeckId(value)
  if ('error' in deck) return deck
  if (!isRecord(value) || (value.reference !== 'A' && value.reference !== 'B')) {
    return { error: error('E_INVALID_PARAMS', 'deck.sync requires reference A or B.') }
  }
  if (value.mode !== 'tempo' && value.mode !== 'tempoPhase' && value.mode !== 'tempoBar') {
    return { error: error('E_INVALID_PARAMS', 'deck.sync mode must be tempo, tempoPhase, or tempoBar.') }
  }
  return { value: { deckId: deck.value, reference: value.reference, mode: value.mode } }
}

function parseTransitionStart(value: unknown): Validation<TransitionStartParams> {
  if (!isRecord(value)) return { error: error('E_INVALID_PARAMS', 'transition.start requires params.') }
  if ((value.activeDeckId !== 'A' && value.activeDeckId !== 'B') || (value.targetDeckId !== 'A' && value.targetDeckId !== 'B')) {
    return { error: error('E_INVALID_PARAMS', 'transition.start deck IDs must be A or B.') }
  }
  if (typeof value.activeBindingId !== 'string' || value.activeBindingId.length === 0
    || typeof value.targetBindingId !== 'string' || value.targetBindingId.length === 0) {
    return { error: error('E_INVALID_PARAMS', 'transition.start requires both non-empty binding IDs.') }
  }
  if (value.at !== 'nextBar') return { error: error('E_INVALID_PARAMS', 'transition.start at must be nextBar.') }
  if (value.minConfidence !== undefined && !finiteInRange(value.minConfidence, 0, 1)) {
    return { error: error('E_OUT_OF_RANGE', 'minConfidence must be between 0 and 1.') }
  }
  if (!isRecord(value.crossfader)
    || !finiteInRange(value.crossfader.to, -1, 1)
    || value.crossfader.curve !== 'equalPower'
    || !isRecord(value.crossfader.duration)
    || !Number.isInteger(value.crossfader.duration.bars)
    || Number(value.crossfader.duration.bars) < 1) {
    return { error: error('E_INVALID_PARAMS', 'transition.start requires an equalPower crossfader with positive integer bars.') }
  }
  return {
    value: {
      activeDeckId: value.activeDeckId,
      activeBindingId: value.activeBindingId,
      targetDeckId: value.targetDeckId,
      targetBindingId: value.targetBindingId,
      at: 'nextBar',
      ...(value.minConfidence === undefined ? {} : { minConfidence: value.minConfidence as number }),
      crossfader: {
        to: value.crossfader.to as number,
        duration: { bars: value.crossfader.duration.bars as number },
        curve: 'equalPower',
      },
    },
  }
}

function parseRamp(value: unknown): Validation<{
  to: number
  duration: { bars: number } | { beats: number } | { seconds: number }
  curve: 'equalPower'
  referenceDeckId?: DeckId
}> {
  if (!isRecord(value)) return { error: error('E_INVALID_PARAMS', 'mixer.rampCrossfader requires params.') }
  if (!finiteInRange(value.to, -1, 1)) return { error: error('E_OUT_OF_RANGE', 'to must be between -1 and 1.') }
  if (value.curve !== 'equalPower') return { error: error('E_INVALID_PARAMS', 'curve must be equalPower.') }
  if (!isRecord(value.duration)) return { error: error('E_INVALID_PARAMS', 'duration is required.') }
  const d = value.duration
  const present = (['bars', 'beats', 'seconds'] as const).filter((key) => d[key] !== undefined)
  if (present.length !== 1) return { error: error('E_INVALID_PARAMS', 'duration must have exactly one of bars, beats, or seconds.') }
  let duration: { bars: number } | { beats: number } | { seconds: number }
  if (d.bars !== undefined) {
    if (!Number.isInteger(d.bars) || Number(d.bars) < 1) return { error: error('E_INVALID_PARAMS', 'duration.bars must be a positive integer.') }
    duration = { bars: d.bars as number }
  } else if (d.beats !== undefined) {
    if (!Number.isInteger(d.beats) || Number(d.beats) < 1) return { error: error('E_INVALID_PARAMS', 'duration.beats must be a positive integer.') }
    duration = { beats: d.beats as number }
  } else {
    if (typeof d.seconds !== 'number' || !Number.isFinite(d.seconds) || d.seconds <= 0) return { error: error('E_INVALID_PARAMS', 'duration.seconds must be a positive finite number.') }
    duration = { seconds: d.seconds as number }
  }
  if (value.referenceDeckId !== undefined && value.referenceDeckId !== 'A' && value.referenceDeckId !== 'B') {
    return { error: error('E_INVALID_PARAMS', 'referenceDeckId must be A or B.') }
  }
  return {
    value: {
      to: value.to as number,
      duration,
      curve: 'equalPower',
      ...(value.referenceDeckId === undefined ? {} : { referenceDeckId: value.referenceDeckId as DeckId }),
    },
  }
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

function acceptedAck(requestId: string, intentId: string, revision: number, scheduledFor?: ScheduledFor): VdapAcceptedAck {
  return {
    vdap: VDAP_VERSION,
    kind: 'ack',
    requestId,
    state: 'accepted',
    intentId,
    revision,
    ...(scheduledFor ? { scheduledFor } : {}),
  }
}

function quantizeUnavailable(reason: QuantizeUnavailableReason): VdapError {
  return { code: 'E_QUANTIZE_UNAVAILABLE', reason, message: `Musical scheduling is unavailable (${reason}).`, retryable: false }
}

function syncResult(sync: { appliedVelocity: number; requestedVelocity: number; targetBpm: number; exact: boolean }): SyncResult {
  return {
    appliedVelocity: sync.appliedVelocity,
    requestedVelocity: sync.requestedVelocity,
    targetBpm: sync.targetBpm,
    exact: sync.exact,
  }
}

function rampResult(entry: RampEntry, endedAtRuntimeTime: number): RampCrossfaderResult {
  return {
    from: entry.from,
    to: entry.to,
    startedAtRuntimeTime: entry.startAtRuntimeTime,
    endedAtRuntimeTime,
    durationSeconds: entry.startAtRuntimeTime === null ? 0 : endedAtRuntimeTime - entry.startAtRuntimeTime,
  }
}

function applyTransport(draft: RuntimeState, deckId: DeckId, command: 'deck.play' | 'deck.pause'): void {
  const target = draft.decks[deckId]
  target.transport.phase = command === 'deck.play' ? 'playing' : target.binding ? 'ready' : 'empty'
  target.playback.headVelocity = command === 'deck.play' ? target.playback.configuredVelocity : 0
  target.playback.direction = command === 'deck.play' ? 'forward' : 'stopped'
}

function applySeek(draft: RuntimeState, deckId: DeckId, position: { sourceSeconds: number; atRuntimeTime: number }, resume: DeckSeekParams['resume']): void {
  const target = draft.decks[deckId]
  target.playback.position = position
  if (resume === 'pause') {
    target.transport.phase = 'ready'
    target.playback.headVelocity = 0
    target.playback.direction = 'stopped'
  } else if (resume === 'play') {
    target.transport.phase = 'playing'
    target.playback.headVelocity = target.playback.configuredVelocity
    target.playback.direction = 'forward'
  }
}

function applyVelocity(draft: RuntimeState, deckId: DeckId, velocity: number): void {
  const target = draft.decks[deckId]
  target.playback.baseVelocity = velocity
  target.playback.configuredVelocity = velocity
  target.playback.headVelocity = target.transport.phase === 'playing' ? velocity : 0
  target.tempo.effectiveBpm = target.tempo.interpretedBpm === null ? null : target.tempo.interpretedBpm * velocity
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

function scheduleInPast(message: string): VdapError {
  return { code: 'E_SCHEDULE_IN_PAST', message, retryable: false }
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
