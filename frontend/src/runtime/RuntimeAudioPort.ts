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
}

export class RuntimeAudioError extends Error {
  readonly error: VdapError

  constructor(error: VdapError) {
    super(error.message)
    this.name = 'RuntimeAudioError'
    this.error = error
  }
}
