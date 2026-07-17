import type {
  DeckId,
  DeckLoadParams,
  PositionPair,
  RuntimePanicParams,
  TrackBinding,
  VdapErrorCode,
} from '@vibraxis/shared/vdap'
import type { DeckEngine } from '../audio/DeckEngine'
import { trackAudioUrl, type CatalogTrack } from '../catalog'
import {
  RuntimeAudioError,
  type AudioLoadResult,
  type AudioSeekRequest,
  type RuntimeAudioPort,
} from './RuntimeAudioPort'

export type TrackResolver = (trackId: string) => CatalogTrack | undefined

export type DeckEngineAudioPortOptions = {
  engine: DeckEngine
  resolveTrack: TrackResolver
  now: () => number
  nextBindingId?: () => string
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

  constructor(options: DeckEngineAudioPortOptions) {
    this.#engine = options.engine
    this.#resolveTrack = options.resolveTrack
    this.#now = options.now
    let sequence = 0
    this.#nextBindingId = options.nextBindingId ?? (() => `bind-${++sequence}`)
  }

  async load(params: DeckLoadParams): Promise<AudioLoadResult> {
    if (params.requireAnalysis) {
      throw audioPortError(
        'E_ANALYSIS_UNAVAILABLE',
        'Analysis binding is not available in the P0 audio slice.',
      )
    }
    const source = this.resolveSource(params.source)
    try {
      await this.#engine.loadUrl(params.deckId, source.uri, source.title)
    } catch (cause) {
      throw audioPortError(
        'E_LOAD_FAILED',
        cause instanceof Error ? cause.message : 'Failed to load the audio source.',
        true,
      )
    }
    const deck = this.#engine.snapshot().decks[params.deckId]
    if (!deck.loaded) {
      throw audioPortError('E_LOAD_FAILED', 'Load was superseded by a newer load.', true)
    }
    const startSeconds = params.initialPosition?.sourceSeconds ?? 0
    if (startSeconds > 0) this.#engine.seek(params.deckId, startSeconds)

    const binding: TrackBinding = {
      bindingId: this.#nextBindingId(),
      trackId: source.trackId,
      source: { kind: source.kind, uri: source.uri, title: source.title },
      sha256: null,
      durationSeconds: deck.duration,
      analysis: null,
    }
    return { binding, position: this.position(params.deckId) }
  }

  async unload(deckId: DeckId): Promise<void> {
    this.#engine.unload(deckId)
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
    if (request.resume === 'pause') this.#engine.pause(deckId)
    this.#engine.seek(deckId, target.sourceSeconds)
    if (request.resume === 'play' && !this.#engine.snapshot().decks[deckId].playing) {
      await this.play(deckId)
    }
    return this.position(deckId)
  }

  async setGain(deckId: DeckId, gain: number): Promise<void> {
    this.#engine.setDeckGain(deckId, gain)
  }

  async setVelocity(deckId: DeckId, velocity: number): Promise<PositionPair | undefined> {
    this.#engine.setPlaybackRate(deckId, velocity)
    return this.position(deckId)
  }

  async setCrossfader(position: number): Promise<void> {
    this.#engine.setCrossfader(position)
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
