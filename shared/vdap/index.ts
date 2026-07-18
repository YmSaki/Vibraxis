/**
 * Shared TypeScript contract for the Vibraxis DJ Agent Protocol P0 subset.
 *
 * The prose specification remains authoritative for runtime behaviour. These
 * types describe the messages and canonical state used by the hackathon
 * golden path; they intentionally do not model the Scratch extension or every
 * future scheduling form.
 */

export const VDAP_VERSION = '1.0' as const

export type VdapVersion = typeof VDAP_VERSION
export type DeckId = 'A' | 'B'
export type RequestId = string
export type IntentId = string
export type BindingId = string
export type VdapRole = 'agent' | 'ui' | 'observer'
export type VdapOrigin = 'user' | 'agent' | 'system'
export type VdapProfile = 'core' | 'beat' | 'scratch'

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }
export type JsonObject = { [key: string]: JsonValue }

export const VDAP_ERROR_CODES = [
  'E_PROTOCOL',
  'E_UNSUPPORTED_VERSION',
  'E_ROLE_MISMATCH',
  'E_UNSUPPORTED_COMMAND',
  'E_CAPABILITY_REQUIRED',
  'E_SCHEDULE_NOT_ALLOWED',
  'E_INVALID_PARAMS',
  'E_OUT_OF_RANGE',
  'E_DECK_UNKNOWN',
  'E_DECK_EMPTY',
  'E_DECK_PLAYING',
  'E_PAD_EMPTY',
  'E_BINDING_MISMATCH',
  'E_STALE_REVISION',
  'E_USER_PRIORITY',
  'E_ANALYSIS_UNAVAILABLE',
  'E_QUANTIZE_UNAVAILABLE',
  'E_SCHEDULE_IN_PAST',
  'E_HORIZON_EXCEEDED',
  'E_AUDIO_LOCKED',
  'E_LOAD_FAILED',
  'E_BUSY',
  'E_TIMEOUT',
  'E_INTERNAL',
] as const

export type VdapErrorCode = (typeof VDAP_ERROR_CODES)[number]
export type QuantizeUnavailableReason =
  | 'noGrid'
  | 'lowConfidence'
  | 'notAdvancing'
  | 'beyondGrid'
export type ScheduleInPastReason = 'alreadyPassed' | 'positionSkipped'
export type IntentCancelReason =
  | 'clientCancel'
  | 'userOverride'
  | 'bindingChanged'
  | 'panic'
  | 'disconnect'
export type VdapErrorReason = QuantizeUnavailableReason | ScheduleInPastReason

type VdapErrorBase = {
  retryable: boolean
  message: string
  details?: JsonValue
}

export type VdapError =
  | (VdapErrorBase & {
      code: 'E_QUANTIZE_UNAVAILABLE'
      reason: QuantizeUnavailableReason
    })
  | (VdapErrorBase & {
      code: 'E_SCHEDULE_IN_PAST'
      /** May be omitted when an absolute runtimeTime is already in the past. */
      reason?: ScheduleInPastReason
    })
  | (VdapErrorBase & {
      code: Exclude<VdapErrorCode, 'E_QUANTIZE_UNAVAILABLE' | 'E_SCHEDULE_IN_PAST'>
      reason?: never
    })

export type PositionPair = {
  sourceSeconds: number
  atRuntimeTime: number
}

export type ScheduledFor = {
  runtimeTime: number
  estimate: boolean
}

type MusicalWhenOptions = {
  deckId?: DeckId
  onGridUnavailable?: 'reject' | 'immediate'
  minConfidence?: number
}

export type ImmediateWhen = { at: 'immediate' }
export type NextBeatWhen = MusicalWhenOptions & { at: 'nextBeat' }
export type NextBarWhen = MusicalWhenOptions & { at: 'nextBar' }

/** Scheduling forms required by the hackathon P0 contract. */
export type P0When = ImmediateWhen | NextBeatWhen | NextBarWhen
export type MixerP0When =
  | ImmediateWhen
  | (NextBeatWhen & { deckId: DeckId })
  | (NextBarWhen & { deckId: DeckId })

export type SessionHelloParams = {
  protocolVersions: string[]
  client: { name: string; version: string }
  role: VdapRole
  token?: string
  cancelOnDisconnect?: boolean
}

export type CatalogLoadSource = { kind: 'catalog'; trackId: string }
export type UrlLoadSource = { kind: 'url'; url: string; title: string }
export type LoadSource = CatalogLoadSource | UrlLoadSource

export type DeckLoadParams = {
  deckId: DeckId
  source: LoadSource
  requireAnalysis?: boolean
  initialPosition?: { sourceSeconds: number }
  replacePlaying?: boolean
}

export type DeckParams = { deckId: DeckId }

export type SeekTarget =
  | { type: 'sourceSeconds'; sourceSeconds: number }
  | { type: 'beat'; beatIndex: number }
  | { type: 'bar'; barIndex: number }
  | { type: 'pad'; slot: number }

export type DeckSeekParams = {
  deckId: DeckId
  target: SeekTarget
  resume?: 'keep' | 'pause' | 'play'
}

export type DeckSelectPadParams = { deckId: DeckId; slot: number }
export type DeckSetPadParams = {
  deckId: DeckId
  slot: number
  sourceSeconds: number
  label?: string
}
export type DeckClearPadParams = { deckId: DeckId; slot: number }
export type DeckSetGainParams = { deckId: DeckId; gain: number }
export type EqBand = 'low' | 'mid' | 'high'
export type DeckEqState = {
  lowDb: number
  midDb: number
  highDb: number
}
export type DeckSetEqParams = {
  deckId: DeckId
  band: EqBand
  gainDb: number
}
export type DeckSetVelocityParams = { deckId: DeckId; velocity: number }
export type TempoInterpretation = 'half' | 'normal' | 'double'
export type DeckSetTempoInterpretationParams = {
  deckId: DeckId
  interpretation: TempoInterpretation
}
export type DeckSyncParams = {
  deckId: DeckId
  reference: DeckId
  mode: 'tempo' | 'tempoPhase' | 'tempoBar'
}

export type MixerSetCrossfaderParams = { position: number }
export type RampDuration =
  | { bars: number; beats?: never; seconds?: never }
  | { beats: number; bars?: never; seconds?: never }
  | { seconds: number; bars?: never; beats?: never }
type BarsRampDuration = Extract<RampDuration, { bars: number }>
type BeatsRampDuration = Extract<RampDuration, { beats: number }>
type SecondsRampDuration = Extract<RampDuration, { seconds: number }>
type RampCrossfaderBaseParams = {
  to: number
  curve: 'equalPower'
}
export type RampCrossfaderParams = RampCrossfaderBaseParams &
  (
    | { duration: SecondsRampDuration; referenceDeckId?: DeckId }
    | { duration: BeatsRampDuration; referenceDeckId: DeckId }
    | { duration: BarsRampDuration; referenceDeckId: DeckId }
  )
export type MixerSetMasterGainParams = { gain: number }

export type ScheduleCancelFilter =
  | { intentId: IntentId; deckId?: never; domain?: never; all?: never }
  | { deckId: DeckId; domain?: IntentDomain; intentId?: never; all?: never }
  | { all: true; intentId?: never; deckId?: never; domain?: never }
export type ScheduleCancelParams = { filter: ScheduleCancelFilter }
export type RuntimePanicParams = { scope?: 'all' | DeckId }

type RequestEnvelope<C extends string, P> = {
  vdap: VdapVersion
  kind: 'request'
  requestId: RequestId
  command: C
  params: P
}

type QueryRequest<C extends string, P> = RequestEnvelope<C, P>

type MutationRequest<C extends string, P, W extends P0When | ImmediateWhen> =
  RequestEnvelope<C, P> & {
    expectedRevision?: number
    when?: W
  }

type DeckMutationRequest<C extends string, P, W extends P0When | ImmediateWhen> =
  MutationRequest<C, P, W> & {
    expectedBindingId?: BindingId
  }

export type SessionHelloRequest = QueryRequest<'session.hello', SessionHelloParams>
export type StateGetRequest = QueryRequest<'state.get', Record<string, never>>
export type DeckGetGridRequest = QueryRequest<'deck.getGrid', DeckParams>

export type StateSubscribeRequest = MutationRequest<
  'state.subscribe',
  Record<string, never>,
  ImmediateWhen
>
export type StateUnsubscribeRequest = MutationRequest<
  'state.unsubscribe',
  Record<string, never>,
  ImmediateWhen
>
type DeckLoadRequestEnvelope = MutationRequest<
  'deck.load',
  DeckLoadParams,
  ImmediateWhen
>
export type DeckLoadRequest = DeckLoadRequestEnvelope &
  (
    | {
        params: DeckLoadParams & { replacePlaying: true }
        expectedBindingId: BindingId
      }
    | {
        params: DeckLoadParams & { replacePlaying?: false }
        expectedBindingId?: BindingId
      }
  )
export type DeckUnloadRequest = DeckMutationRequest<'deck.unload', DeckParams, ImmediateWhen>
export type DeckPlayRequest = DeckMutationRequest<'deck.play', DeckParams, P0When>
export type DeckPauseRequest = DeckMutationRequest<'deck.pause', DeckParams, P0When>
export type DeckSeekRequest = DeckMutationRequest<'deck.seek', DeckSeekParams, P0When>
export type DeckSelectPadRequest = DeckMutationRequest<
  'deck.selectPad',
  DeckSelectPadParams,
  P0When
>
export type DeckSetPadRequest = DeckMutationRequest<'deck.setPad', DeckSetPadParams, ImmediateWhen>
export type DeckClearPadRequest = DeckMutationRequest<
  'deck.clearPad',
  DeckClearPadParams,
  ImmediateWhen
>
export type DeckSetGainRequest = DeckMutationRequest<'deck.setGain', DeckSetGainParams, P0When>
export type DeckSetEqRequest = DeckMutationRequest<'deck.setEq', DeckSetEqParams, P0When>
export type DeckSetVelocityRequest = DeckMutationRequest<
  'deck.setVelocity',
  DeckSetVelocityParams,
  P0When
>
export type DeckSetTempoInterpretationRequest = DeckMutationRequest<
  'deck.setTempoInterpretation',
  DeckSetTempoInterpretationParams,
  ImmediateWhen
>
export type DeckSyncRequest = DeckMutationRequest<'deck.sync', DeckSyncParams, P0When>
export type MixerSetCrossfaderRequest = MutationRequest<
  'mixer.setCrossfader',
  MixerSetCrossfaderParams,
  MixerP0When
>
export type MixerRampCrossfaderRequest = MutationRequest<
  'mixer.rampCrossfader',
  RampCrossfaderParams,
  MixerP0When
>
export type MixerSetMasterGainRequest = MutationRequest<
  'mixer.setMasterGain',
  MixerSetMasterGainParams,
  ImmediateWhen
>
export type ScheduleCancelRequest = MutationRequest<
  'schedule.cancel',
  ScheduleCancelParams,
  ImmediateWhen
>
export type RuntimePanicRequest = MutationRequest<
  'runtime.panic',
  RuntimePanicParams,
  ImmediateWhen
>

export type VdapRequest =
  | SessionHelloRequest
  | StateGetRequest
  | DeckGetGridRequest
  | StateSubscribeRequest
  | StateUnsubscribeRequest
  | DeckLoadRequest
  | DeckUnloadRequest
  | DeckPlayRequest
  | DeckPauseRequest
  | DeckSeekRequest
  | DeckSelectPadRequest
  | DeckSetPadRequest
  | DeckClearPadRequest
  | DeckSetGainRequest
  | DeckSetEqRequest
  | DeckSetVelocityRequest
  | DeckSetTempoInterpretationRequest
  | DeckSyncRequest
  | MixerSetCrossfaderRequest
  | MixerRampCrossfaderRequest
  | MixerSetMasterGainRequest
  | ScheduleCancelRequest
  | RuntimePanicRequest

export type VdapCommand = VdapRequest['command']
export type VdapQueryCommand = 'session.hello' | 'state.get' | 'deck.getGrid'
export type VdapMutationCommand = Exclude<VdapCommand, VdapQueryCommand>
export type RequestFor<C extends VdapCommand> = Extract<VdapRequest, { command: C }>

export type VelocityCapability = { min: number; max: number; reverse: boolean }
export type QuantizeCapability = {
  units: Array<'beat' | 'bar'>
  toleranceSeconds: number
}
export type VdapCapabilities = {
  velocity?: VelocityCapability
  quantize?: QuantizeCapability
  phaseSync?: Record<string, never>
  grid?: { source: 'analysis' }
  crossfaderRamp?: {
    curves: Array<'equalPower'>
    durationUnits: Array<'seconds' | 'beats' | 'bars'>
  }
  padEdit?: Record<string, never>
}
export type VdapLimits = {
  maxScheduleHorizonSeconds: number
  maxPendingIntents: number
  idempotencyWindowSeconds: number
  gainRange: { min: number; max: number }
  masterRange: { min: number; max: number }
}

export type SessionHelloResult = {
  protocolVersion: VdapVersion
  runtime: { name: string; version: string }
  role: VdapRole
  profile: VdapProfile
  deckIds: DeckId[]
  capabilities: VdapCapabilities
  limits: VdapLimits
  revision: number
}

export type TerminalSummary = {
  intentId: IntentId
  event: TerminalEventName
  revision: number
}

export type VdapAcceptedAck = {
  vdap: VdapVersion
  kind: 'ack'
  requestId: RequestId
  state: 'accepted'
  intentId: IntentId
  revision: number
  scheduledFor?: ScheduledFor
  terminalSummary?: TerminalSummary
}

export type VdapRejectedAck = {
  vdap: VdapVersion
  kind: 'ack'
  requestId: RequestId
  state: 'rejected'
  error: VdapError
  revision?: number
}

export type QueryResult =
  | SessionHelloResult
  | RuntimeState
  | DeckGrid
  | JsonObject

export type VdapCompletedAck = {
  vdap: VdapVersion
  kind: 'ack'
  requestId: RequestId
  state: 'completed'
  revision: number
  result: QueryResult
}

export type VdapAck = VdapAcceptedAck | VdapRejectedAck | VdapCompletedAck

export type AudioState = {
  contextState: 'suspended' | 'running' | 'closed' | 'interrupted'
  sampleRate: number
  outputLatencySeconds: number
}

export type CrossfaderOverride = {
  active: true
  source: 'gesture' | 'manual'
  position: number
  intentId?: IntentId
}

export type CrossfaderAutomation = {
  intentId: IntentId
  from: number
  to: number
  startedAtRuntimeTime: number
  durationSecondsEstimate: number
}

export type MixerState = {
  crossfader: {
    base: number
    override: CrossfaderOverride | null
    effective: number
    curve: 'dj' | 'equalPower'
    automation: CrossfaderAutomation | null
  }
  masterGain: number
}

export type BindingAnalysis = {
  analysisRef: string
  schemaVersion: number
  bpm: number
  timeSignature: string
  beatsPerBar: number
  firstDownbeatSeconds: number
  beatCount: number
  barCount: number
  key: string
  scale: 'major' | 'minor'
  camelot: string
  energy: number
  grid: {
    available: boolean
    confidence: number
    status: 'complete' | 'partial' | 'failed' | 'skipped'
  }
}

export type BoundTrackSource = {
  kind: 'catalog' | 'url'
  uri: string
  title: string
}

export type TrackBinding = {
  bindingId: BindingId
  trackId: string
  source: BoundTrackSource
  sha256: string | null
  durationSeconds: number
  analysis: BindingAnalysis | null
}

export type DeckLoadState =
  | { phase: 'idle'; intentId: null; progress: null }
  | { phase: 'loading'; intentId: IntentId; progress: number | null }

export type TransportState = { phase: 'empty' | 'ready' | 'playing' | 'ended' }

export type PlaybackOverride = {
  active: true
  source: 'gesture' | 'manual'
  velocity: number
  intentId?: IntentId
}

export type PlaybackState = {
  position: PositionPair
  baseVelocity: number
  override: PlaybackOverride | null
  configuredVelocity: number
  headVelocity: number
  direction: 'forward' | 'stopped'
}

export type TempoState = {
  interpretation: TempoInterpretation
  baseBpm: number | null
  interpretedBpm: number | null
  effectiveBpm: number | null
}

export type PerformancePad = {
  slot: number
  type: 'hotCue'
  label: string
  sourceSeconds: number
  beatIndex?: number
  barIndex?: number
  beatInBar?: number
  source: 'auto' | 'user'
  locked: boolean
}

export type PadState = {
  selectedSlot: number
  slots: PerformancePad[]
}

export type DeckState = {
  deckId: DeckId
  load: DeckLoadState
  binding: TrackBinding | null
  transport: TransportState
  playback: PlaybackState
  tempo: TempoState
  gain: number
  eq: DeckEqState
  pads: PadState
}

export type IntentDomain =
  | 'binding'
  | 'transport'
  | 'padSelection'
  | 'padEdit'
  | 'velocity'
  | 'gain'
  | 'eq'
  | 'crossfader'
  | 'master'
  | 'subscription'
  | 'schedule'
  | 'runtime'

export type IntentTarget =
  | { deckId: DeckId }
  | { mixer: 'crossfader' | 'master' }
  | { scope: 'all' | DeckId }
  | { connectionId: string }
  | { runtime: true }

export type IntentState = {
  intentId: IntentId
  requestId: RequestId
  command: VdapMutationCommand
  origin: VdapOrigin
  state: 'scheduled' | 'executing'
  target: IntentTarget
  domain: IntentDomain
  when: P0When
  scheduledFor?: ScheduledFor
}

export type RuntimeState = {
  revision: number
  runtimeTime: number
  audio: AudioState
  mixer: MixerState
  decks: Record<DeckId, DeckState>
  intents: Record<IntentId, IntentState>
}

export type DeckGrid = {
  bindingId: BindingId
  timeSignature: string
  beatsPerBar: number
  bpm: number
  confidence: number
  beatsSeconds: number[]
  downbeatsSeconds: number[]
  sections: JsonValue[]
  phrases: JsonValue[]
}

export type RampCrossfaderResult = {
  from: number
  to: number
  startedAtRuntimeTime: number | null
  endedAtRuntimeTime: number
  durationSeconds: number
}

export type LoadResult = { binding: TrackBinding }
export type SeekResult = { position: PositionPair }
export type SyncResult = {
  appliedVelocity: number
  requestedVelocity: number
  targetBpm: number
  exact: boolean
  phaseErrorSeconds?: number
}
export type ScheduleCancelResult = { cancelledCount: number; skippedCount: number }
export type CommandResult =
  | RampCrossfaderResult
  | LoadResult
  | SeekResult
  | SyncResult
  | ScheduleCancelResult
  | JsonObject

type EventEnvelope<E extends string> = {
  vdap: VdapVersion
  kind: 'event'
  event: E
  revision: number
  runtimeTime: number
}

type IntentEventEnvelope<E extends string> = EventEnvelope<E> & {
  intentId: IntentId
  requestId: RequestId
}

export type IntentCompletedEvent = IntentEventEnvelope<'intent.completed'> & {
  result: CommandResult
  degraded?: 'immediate'
}

export type IntentFailedEvent = IntentEventEnvelope<'intent.failed'> & {
  error: VdapError
  /** Required for rampCrossfader terminal events; absent for other commands. */
  result?: CommandResult
}

export type IntentCancelledEvent = IntentEventEnvelope<'intent.cancelled'> & {
  reason: IntentCancelReason
  /** Required for rampCrossfader terminal events; absent for other commands. */
  result?: CommandResult
}

export type IntentSupersededEvent = IntentEventEnvelope<'intent.superseded'> & {
  supersededBy: IntentId
}

export type DeckEndedEvent = EventEnvelope<'deck.ended'> & {
  deckId: DeckId
  position: PositionPair
}

export type RuntimeWarningEvent = EventEnvelope<'runtime.warning'> & {
  code: string
  message: string
}

export type VdapEvent =
  | IntentCompletedEvent
  | IntentFailedEvent
  | IntentCancelledEvent
  | IntentSupersededEvent
  | DeckEndedEvent
  | RuntimeWarningEvent

export type TerminalEventName = Extract<
  VdapEvent['event'],
  'intent.completed' | 'intent.failed' | 'intent.cancelled' | 'intent.superseded'
>

export type VdapSnapshot = {
  vdap: VdapVersion
  kind: 'snapshot'
} & RuntimeState

export type JsonPatchOperation =
  | { op: 'add'; path: string; value: JsonValue }
  | { op: 'remove'; path: string }
  | { op: 'replace'; path: string; value: JsonValue }

export type VdapDelta = {
  vdap: VdapVersion
  kind: 'delta'
  fromRevision: number
  toRevision: number
  runtimeTime: number
  patch: JsonPatchOperation[]
}

export type VdapMessage = VdapRequest | VdapAck | VdapEvent | VdapSnapshot | VdapDelta
