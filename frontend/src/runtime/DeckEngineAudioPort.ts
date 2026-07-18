import type {
  BindingId,
  DeckId,
  DeckLoadParams,
  PositionPair,
  RuntimePanicParams,
  TrackBinding,
  VdapErrorCode,
} from '@vibraxis/shared/vdap'
import type { TrackAnalysis } from '@vibraxis/shared/analysis'
import {
  assertUsableAnalysis,
  fetchTrackAnalysis,
  toBindingAnalysis,
  toDeckGridPayload,
} from '../analysis'
import type { DeckEngine, PreparedDeckLoad } from '../audio/DeckEngine'
import { trackAudioUrl, type CatalogTrack } from '../catalog'
import {
  RuntimeAudioError,
  type AudioLoadResult,
  type AudioSeekRequest,
  type DeckGridPayload,
  type RuntimeAudioPort,
} from './RuntimeAudioPort'

export type TrackResolver = (trackId: string) => CatalogTrack | undefined

export type DeckEngineAudioPortOptions = {
  engine: DeckEngine
  resolveTrack: TrackResolver
  now: () => number
  nextBindingId?: () => string
  /** Test seam: overrides the /api/analysis fetch for catalog tracks. */
  fetchAnalysis?: (trackId: string) => Promise<TrackAnalysis>
}

/**
 * P0 adapter from the VDAP RuntimeAudioPort contract onto the Web Audio
 * DeckEngine. Analysis binding, staged load, and beat-grid seeks arrive with
 * the safe-audio stage; until then those requests fail with stable errors
 * instead of guessing.
 */
export class DeckEngineAudioPort implements RuntimeAudioPort {
  readonly #engine: DeckEngine
  readonly #resolveTrack: TrackResolver
  readonly #now: () => number
  readonly #nextBindingId: () => string
  readonly #fetchAnalysis: (trackId: string) => Promise<TrackAnalysis>
  /**
   * Full analysis grids kept outside the runtime snapshot and keyed by the
   * bindingId they belong to. `deck.getGrid` reads from here on demand so large
   * beat arrays are never cloned into every high-frequency snapshot. Superseded
   * bindings on a deck are evicted on the next load/unload.
   */
  readonly #grids = new Map<BindingId, DeckGridPayload>()
  readonly #deckBinding: Record<DeckId, BindingId | null> = { A: null, B: null }

  constructor(options: DeckEngineAudioPortOptions) {
    this.#engine = options.engine
    this.#resolveTrack = options.resolveTrack
    this.#now = options.now
    let sequence = 0
    this.#nextBindingId = options.nextBindingId ?? (() => `bind-${++sequence}`)
    this.#fetchAnalysis = options.fetchAnalysis ?? fetchTrackAnalysis
  }

  async load(params: DeckLoadParams): Promise<AudioLoadResult> {
    const source = this.resolveSource(params.source)
    const requireAnalysis = params.requireAnalysis ?? source.kind === 'catalog'

    // Audio and analysis are fetched in parallel; both must settle before the
    // binding commits so a binding is never half-analyzed.
    let analysisError: string | null = null
    const analysisPromise: Promise<TrackAnalysis | null> =
      source.kind === 'catalog'
        ? this.#fetchAnalysis(source.trackId).catch((cause: unknown) => {
            analysisError = cause instanceof Error ? cause.message : 'Analysis fetch failed.'
            return null
          })
        : Promise.resolve(null)

    let analysis: TrackAnalysis | null
    let preparedAudio: PreparedDeckLoad | null
    try {
      ;[preparedAudio, analysis] = await Promise.all([
        this.#engine.prepareUrl(params.deckId, source.uri, source.title),
        analysisPromise,
      ])
    } catch (cause) {
      throw audioPortError(
        'E_LOAD_FAILED',
        cause instanceof Error ? cause.message : 'Failed to load the audio source.',
        true,
      )
    }
    if (!preparedAudio || !this.#engine.isLoadCurrent(params.deckId, preparedAudio)) {
      throw audioPortError('E_LOAD_FAILED', 'Load was superseded by a newer load.', true)
    }
    if (requireAnalysis && !analysis) {
      this.#engine.discardPreparedLoad(preparedAudio)
      throw audioPortError(
        'E_ANALYSIS_UNAVAILABLE',
        analysisError ?? `No analysis is available for ${source.trackId}.`,
      )
    }
    let bindingAnalysis: TrackBinding['analysis'] = null
    let grid: DeckGridPayload | null = null
    if (analysis) {
      try {
        assertUsableAnalysis(analysis, source.trackId)
        bindingAnalysis = toBindingAnalysis(analysis)
        grid = toDeckGridPayload(analysis)
      } catch (cause) {
        if (requireAnalysis) {
          this.#engine.discardPreparedLoad(preparedAudio)
          throw audioPortError(
            'E_ANALYSIS_UNAVAILABLE',
            cause instanceof Error ? cause.message : `Analysis for ${source.trackId} is invalid.`,
          )
        }
        analysis = null
      }
    }
    const startSeconds = params.initialPosition?.sourceSeconds ?? 0
    if (!Number.isFinite(startSeconds) || startSeconds < 0 || startSeconds > preparedAudio.buffer.duration) {
      this.#engine.discardPreparedLoad(preparedAudio)
      throw audioPortError(
        'E_OUT_OF_RANGE',
        `initialPosition.sourceSeconds must be between 0 and ${preparedAudio.buffer.duration}.`,
      )
    }
    let bindingId: BindingId
    try {
      bindingId = this.#nextBindingId()
    } catch (cause) {
      this.#engine.discardPreparedLoad(preparedAudio)
      throw audioPortError(
        'E_LOAD_FAILED',
        cause instanceof Error ? cause.message : 'Failed to allocate a binding ID.',
      )
    }
    const binding: TrackBinding = {
      bindingId,
      trackId: source.trackId,
      source: { kind: source.kind, uri: source.uri, title: source.title },
      sha256: analysis?.source.sha256 ?? null,
      durationSeconds: preparedAudio.buffer.duration,
      analysis: bindingAnalysis,
    }
    const audioReceipt = this.#engine.commitPreparedLoad(preparedAudio, {
      emit: false,
      initialOffset: startSeconds,
    })
    if (!audioReceipt || !this.#engine.isLoadCurrent(params.deckId, audioReceipt)) {
      throw audioPortError('E_LOAD_FAILED', 'Load was superseded by a newer load.', true)
    }
    // The old binding on this deck is now unreachable; drop its grid before we
    // remember the new one so the cache stays bounded to live bindings.
    this.#evictDeckGrid(params.deckId)
    if (grid) {
      this.#grids.set(binding.bindingId, grid)
    }
    this.#deckBinding[params.deckId] = binding.bindingId
    let finalized = false
    return {
      binding,
      position: this.position(params.deckId),
      finalize: () => {
        if (finalized) return
        finalized = true
        this.#engine.finalizePreparedLoad(params.deckId, audioReceipt)
      },
    }
  }

  getGrid(bindingId: BindingId): DeckGridPayload | null {
    return this.#grids.get(bindingId) ?? null
  }

  onTrackEnded(listener: (deckId: DeckId, position: PositionPair) => void): () => void {
    return this.#engine.onEnded((deckId, positionSeconds) =>
      listener(deckId, { sourceSeconds: positionSeconds, atRuntimeTime: this.#now() }),
    )
  }

  async unload(deckId: DeckId): Promise<void> {
    this.#evictDeckGrid(deckId)
    this.#engine.unload(deckId)
  }

  #evictDeckGrid(deckId: DeckId): void {
    const previous = this.#deckBinding[deckId]
    if (previous !== null && this.#deckBinding[deckId === 'A' ? 'B' : 'A'] !== previous) {
      this.#grids.delete(previous)
    }
    this.#deckBinding[deckId] = null
  }

  async play(deckId: DeckId): Promise<PositionPair> {
    try {
      await this.#engine.play(deckId)
    } catch (cause) {
      throw audioPortError(
        'E_AUDIO_LOCKED',
        cause instanceof Error ? cause.message : 'AudioContext could not be resumed.',
        true,
      )
    }
    return this.position(deckId)
  }

  async pause(deckId: DeckId): Promise<PositionPair> {
    this.#engine.pause(deckId)
    return this.position(deckId)
  }

  async seek(deckId: DeckId, request: AudioSeekRequest): Promise<PositionPair> {
    const { target } = request
    if (target.type === 'pad') {
      throw audioPortError('E_PAD_EMPTY', 'Pad slots are empty in the P0 audio slice.')
    }
    if (target.type !== 'sourceSeconds') {
      throw new RuntimeAudioError({
        code: 'E_QUANTIZE_UNAVAILABLE',
        reason: 'noGrid',
        message:
          'Beat and bar seek targets require the analysis grid, which is not bound in the P0 audio slice.',
        retryable: false,
      })
    }
    const deck = this.#engine.snapshot().decks[deckId]
    if (
      !Number.isFinite(target.sourceSeconds)
      || target.sourceSeconds < 0
      || target.sourceSeconds > deck.duration
    ) {
      throw audioPortError(
        'E_OUT_OF_RANGE',
        `sourceSeconds must be between 0 and ${deck.duration}.`,
      )
    }
    if (request.resume === 'pause') this.#engine.pause(deckId)
    try {
      await this.#engine.seek(deckId, target.sourceSeconds)
    } catch (cause) {
      throw audioPortError(
        'E_AUDIO_LOCKED',
        cause instanceof Error ? cause.message : 'Audio playback could not be resumed after seek.',
        true,
      )
    }
    if (request.resume === 'play' && !this.#engine.snapshot().decks[deckId].playing) {
      await this.play(deckId)
    }
    return this.position(deckId)
  }

  async setGain(deckId: DeckId, gain: number): Promise<void> {
    this.#engine.setDeckGain(deckId, gain)
  }

  async setEq(deckId: DeckId, band: 'low' | 'mid' | 'high', gainDb: number): Promise<void> {
    this.#engine.setDeckEq(deckId, band, gainDb)
  }

  async setVelocity(deckId: DeckId, velocity: number): Promise<PositionPair | undefined> {
    this.#engine.setPlaybackRate(deckId, velocity)
    return this.position(deckId)
  }

  async setCrossfader(position: number, curve: 'dj' | 'equalPower' = 'dj'): Promise<void> {
    this.#engine.setCrossfader(position, curve)
  }

  async setMasterGain(gain: number): Promise<void> {
    this.#engine.setMasterVolume(gain)
  }

  async panic(
    scope: RuntimePanicParams['scope'],
  ): Promise<Partial<Record<DeckId, PositionPair>>> {
    const deckIds: DeckId[] = scope && scope !== 'all' ? [scope] : ['A', 'B']
    const positions: Partial<Record<DeckId, PositionPair>> = {}
    for (const deckId of deckIds) {
      this.#engine.pause(deckId)
      positions[deckId] = this.position(deckId)
    }
    return positions
  }

  private resolveSource(source: DeckLoadParams['source']): {
    kind: 'catalog' | 'url'
    uri: string
    title: string
    trackId: string
  } {
    if (source.kind === 'catalog') {
      const track = this.#resolveTrack(source.trackId)
      if (!track) {
        throw audioPortError('E_LOAD_FAILED', `Unknown catalog trackId: ${source.trackId}`)
      }
      return { kind: 'catalog', uri: trackAudioUrl(track), title: track.title, trackId: track.trackId }
    }
    return { kind: 'url', uri: source.url, title: source.title, trackId: source.url }
  }

  private position(deckId: DeckId): PositionPair {
    return {
      sourceSeconds: this.#engine.snapshot().decks[deckId].position,
      atRuntimeTime: this.#now(),
    }
  }
}

function audioPortError(
  code: Exclude<VdapErrorCode, 'E_QUANTIZE_UNAVAILABLE' | 'E_SCHEDULE_IN_PAST'>,
  message: string,
  retryable = false,
): RuntimeAudioError {
  return new RuntimeAudioError({ code, message, retryable })
}
