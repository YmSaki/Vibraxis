import type {
  BindingId,
  DeckGrid,
  DeckId,
  DeckLoadParams,
  PositionPair,
  RuntimePanicParams,
  SeekTarget,
  TrackBinding,
  VdapError,
} from '@vibraxis/shared/vdap'

export type AudioSeekRequest = {
  target: SeekTarget
  resume: 'keep' | 'pause' | 'play'
}

export type AudioLoadResult = {
  binding: TrackBinding
  position: PositionPair
  /** Publishes audio observers only after the canonical runtime binding commits. */
  finalize?: () => void
}

/**
 * Full beat grid for a bound track, minus the canonical `bindingId` which the
 * dispatcher supplies from the store. Held out of the high-frequency runtime
 * snapshot and fetched on demand via `deck.getGrid`.
 */
export type DeckGridPayload = Omit<DeckGrid, 'bindingId'>

/**
 * Scheduled equal-power crossfader automation reserved on the audio timeline.
 * The runtime supplies absolute runtime times; the adapter converts them to its
 * own audio clock so a single automation is queued (never a burst of setValue
 * updates). VDAP §11.12.
 */
export type CrossfaderRampSpec = {
  from: number
  to: number
  startAtRuntimeTime: number
  durationSeconds: number
  curve: 'equalPower'
}

export type BeatTransitionAudioSpec = CrossfaderRampSpec & {
  targetDeckId: DeckId
}

export type BeatTransitionCancellation = {
  targetPosition: PositionPair
  holdPosition: number
  progressedDurationSeconds: number
}

export type BeatTransitionAudioSample = BeatTransitionCancellation

/**
 * Receipt for one atomic audio-timeline reservation. These promises are driven
 * by AudioContext events, not the wall clock, so a suspended context cannot
 * falsely complete a transition.
 */
export type BeatTransitionAudioReservation = {
  started: Promise<PositionPair>
  completed: Promise<{ endedAtRuntimeTime: number; targetPosition: PositionPair }>
  sample(): BeatTransitionAudioSample
  cancel(holdPositionOverride?: number): BeatTransitionCancellation
}

/** Audio side effects injected into CommandDispatcher. */
export interface RuntimeAudioPort {
  load(params: DeckLoadParams): Promise<AudioLoadResult>
  unload(deckId: DeckId): Promise<void>
  play(deckId: DeckId): Promise<PositionPair>
  pause(deckId: DeckId): Promise<PositionPair>
  seek(deckId: DeckId, request: AudioSeekRequest): Promise<PositionPair>
  setGain(deckId: DeckId, gain: number): Promise<void>
  setEq(deckId: DeckId, band: 'low' | 'mid' | 'high', gainDb: number): Promise<void>
  setVelocity(deckId: DeckId, velocity: number): Promise<PositionPair | undefined>
  setCrossfader(position: number, curve?: 'dj' | 'equalPower'): Promise<void>
  setMasterGain(gain: number): Promise<void>
  panic(scope: RuntimePanicParams['scope']): Promise<Partial<Record<DeckId, PositionPair>>>
  /** Optional: notifies the runtime when a deck reaches the natural end of its track. */
  onTrackEnded?(listener: (deckId: DeckId, position: PositionPair) => void): () => void
  /**
   * Optional: returns the full analysis grid for a bound track, or null when no
   * grid is cached for that binding. Backs `deck.getGrid` without duplicating the
   * grid into every runtime snapshot.
   */
  getGrid?(bindingId: BindingId): DeckGridPayload | null
  /**
   * Optional (beat profile): starts a deck at an absolute runtime time by
   * queuing the source on the audio timeline, so a `nextBar` start lands within
   * the declared quantize tolerance. Resolves once the start is scheduled.
   */
  playAt?(deckId: DeckId, atRuntimeTime: number): Promise<PositionPair>
  /**
   * Optional (beat profile): queues one equal-power crossfader automation. The
   * runtime samples reported base/effective from the ramp math; the adapter owns
   * only the audio-timeline curve.
   */
  scheduleCrossfaderRamp?(spec: CrossfaderRampSpec): Promise<void>
  /**
   * Optional (beat profile): cancels the in-flight crossfader automation and
   * holds the crossfader at `holdPosition` (the sampled current value). Never
   * jumps to the ramp target. VDAP §11.12.
   */
  stopCrossfaderRamp?(holdPosition: number): Promise<void>
  /** Minimum future lead required for an atomic Web Audio reservation. */
  readonly minimumTransitionLeadSeconds?: number
  /** Atomically queues target playback and the crossfader ramp at one time. */
  scheduleBeatTransition?(spec: BeatTransitionAudioSpec): Promise<BeatTransitionAudioReservation>
}

export class RuntimeAudioError extends Error {
  readonly error: VdapError

  constructor(error: VdapError) {
    super(error.message)
    this.name = 'RuntimeAudioError'
    this.error = error
  }
}
