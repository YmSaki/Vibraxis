import type {
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
}

/** Audio side effects injected into CommandDispatcher. */
export interface RuntimeAudioPort {
  load(params: DeckLoadParams): Promise<AudioLoadResult>
  unload(deckId: DeckId): Promise<void>
  play(deckId: DeckId): Promise<PositionPair>
  pause(deckId: DeckId): Promise<PositionPair>
  seek(deckId: DeckId, request: AudioSeekRequest): Promise<PositionPair>
  setGain(deckId: DeckId, gain: number): Promise<void>
  setVelocity(deckId: DeckId, velocity: number): Promise<PositionPair | undefined>
  setCrossfader(position: number): Promise<void>
  setMasterGain(gain: number): Promise<void>
  panic(scope: RuntimePanicParams['scope']): Promise<Partial<Record<DeckId, PositionPair>>>
}

export class RuntimeAudioError extends Error {
  readonly error: VdapError

  constructor(error: VdapError) {
    super(error.message)
    this.name = 'RuntimeAudioError'
    this.error = error
  }
}
