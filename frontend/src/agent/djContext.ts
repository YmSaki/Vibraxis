/**
 * Truthful assembly of a {@link DjContext} from the live UI/runtime/catalog
 * state (Order 7 §4). This module never invents metadata: every field is either
 * copied verbatim from the catalog, read from canonical runtime state, or taken
 * from the runtime-published velocity limits. When a required input is missing
 * or ambiguous it returns a typed unavailability reason so the caller can
 * reject/disable with a precise, visible explanation instead of guessing
 * (AGENTS.md §0.7).
 */

import type { RuntimeState, DeckId } from '@vibraxis/shared/vdap'
import type { CatalogTrack } from '../catalog'
import type { DjContext, DjRuntimeLimits, DjTrackSummary } from './contract'

/**
 * Crossfade bar counts this application offers the deterministic engine. These
 * are an inspectable application policy (disclosed per AGENTS.md §0.9), not a
 * user input and not a runtime hard limit — `transition.start` accepts any
 * positive bar count. They mirror the deterministic policy's urgency targets
 * (quick=4 / normal=8 / gradual=16).
 */
export const SUPPORTED_CROSSFADE_BARS: readonly number[] = [4, 8, 16]

export type VelocityLimits = { min: number; max: number }

export type DjContextUnavailableCode =
  | 'runtimeNotReady'
  | 'velocityLimitsUnavailable'
  | 'catalogEmpty'
  | 'noActiveDeck'
  | 'ambiguousActiveDeck'
  | 'activeDeckNotInCatalog'
  | 'playHistoryUnavailable'
  | 'effectiveTempoUnavailable'
  | 'noCandidateTracks'

export interface DjContextUnavailable {
  code: DjContextUnavailableCode
  detail: string
}

export interface DjContextReady {
  context: DjContext
  activeDeckId: DeckId
  inactiveDeckId: DeckId
  /** The catalog entry currently bound on the active deck (source of currentTrack). */
  currentTrack: CatalogTrack
}

export type DjContextResult =
  | ({ ok: true } & DjContextReady)
  | { ok: false; reason: DjContextUnavailable }

/**
 * Maps a catalog track to the provider-facing summary. Documented derivation:
 * - hasBeatGrid   ← catalog `beatCount` is a positive integer.
 * - hasSectionCues ← the catalog carries at least one semantic section.
 * Capability status and performance pads are not used as substitutes for
 * concrete analysis output.
 * Both are derived only from data actually present in the catalog.
 */
export function catalogTrackToSummary(track: CatalogTrack): DjTrackSummary {
  return {
    trackId: track.trackId,
    title: track.title,
    artist: track.artist,
    genre: track.genre,
    mood: [...track.mood],
    bpm: track.bpm,
    camelot: track.camelot,
    energy: track.energy,
    hasBeatGrid: Number.isInteger(track.beatCount) && track.beatCount > 0,
    hasSectionCues: track.sectionSummary.length > 0,
  }
}

export interface BuildDjContextInput {
  runtimeState: RuntimeState | null
  tracks: CatalogTrack[]
  velocity: VelocityLimits | null
  /** Session play history captured from actual playing bindings. null means unknown. */
  recentlyPlayedTrackIds: string[] | null
}

function otherDeck(id: DeckId): DeckId {
  return id === 'A' ? 'B' : 'A'
}

/**
 * Builds the DjContext for the "what should I mix next" decision. The active
 * (audience) deck is the single deck that is currently playing with a binding;
 * the other deck is the mix target. Zero or two playing decks is ambiguous and
 * is reported, not resolved by guessing.
 */
export function buildDjContext(input: BuildDjContextInput): DjContextResult {
  const { runtimeState, tracks, velocity, recentlyPlayedTrackIds } = input
  if (runtimeState === null) {
    return { ok: false, reason: { code: 'runtimeNotReady', detail: 'Runtime state has not loaded yet.' } }
  }
  if (velocity === null) {
    return {
      ok: false,
      reason: {
        code: 'velocityLimitsUnavailable',
        detail: 'Runtime velocity limits are unknown (session.hello result not captured).',
      },
    }
  }
  if (tracks.length === 0) {
    return { ok: false, reason: { code: 'catalogEmpty', detail: 'The track catalog is empty.' } }
  }
  if (recentlyPlayedTrackIds === null) {
    return {
      ok: false,
      reason: {
        code: 'playHistoryUnavailable',
        detail: 'Session play history is unavailable; it cannot be represented as an empty history.',
      },
    }
  }

  const playing = (['A', 'B'] as DeckId[]).filter(
    (id) => runtimeState.decks[id].transport.phase === 'playing' && runtimeState.decks[id].binding !== null,
  )
  if (playing.length === 0) {
    return {
      ok: false,
      reason: {
        code: 'noActiveDeck',
        detail: 'Play exactly one deck to designate it as the active (audience) deck.',
      },
    }
  }
  if (playing.length > 1) {
    return {
      ok: false,
      reason: {
        code: 'ambiguousActiveDeck',
        detail: 'Both decks are playing; the active deck cannot be determined unambiguously.',
      },
    }
  }

  const activeDeckId = playing[0]
  const inactiveDeckId = otherDeck(activeDeckId)
  const activeTrackId = runtimeState.decks[activeDeckId].binding?.trackId
  const currentTrack = tracks.find((track) => track.trackId === activeTrackId)
  if (currentTrack === undefined) {
    return {
      ok: false,
      reason: {
        code: 'activeDeckNotInCatalog',
        detail: `The active deck's track "${String(activeTrackId)}" is not in the catalog (e.g. a file/URL load); its metadata cannot be assembled truthfully.`,
      },
    }
  }

  // The reference BPM for the "what mixes next" decision is the active deck's
  // ACTUAL playing tempo, not the catalog's nominal value: a user tempo/velocity
  // change moves the beat that the next track must be matched against. We use the
  // runtime-published effective tempo verbatim and, when it is not a usable
  // positive-finite value, reject with a typed reason instead of guessing or
  // silently falling back to the catalog BPM (AGENTS.md §0.7/§0.10). Candidate
  // tracks are not playing, so they keep their catalog BPM.
  const effectiveBpm = runtimeState.decks[activeDeckId].tempo.effectiveBpm
  if (typeof effectiveBpm !== 'number' || !Number.isFinite(effectiveBpm) || effectiveBpm <= 0) {
    return {
      ok: false,
      reason: {
        code: 'effectiveTempoUnavailable',
        detail: `The active deck ${activeDeckId} has no usable effective tempo (${String(effectiveBpm)} BPM); the reference tempo cannot be assembled truthfully.`,
      },
    }
  }

  const candidates = tracks
    .filter((track) => track.trackId !== currentTrack.trackId)
    .map(catalogTrackToSummary)
  if (candidates.length === 0) {
    return {
      ok: false,
      reason: { code: 'noCandidateTracks', detail: 'No catalog tracks are available besides the current one.' },
    }
  }

  const limits: DjRuntimeLimits = {
    minPlaybackRate: velocity.min,
    maxPlaybackRate: velocity.max,
    allowedCrossfadeBars: [...SUPPORTED_CROSSFADE_BARS],
  }

  const context: DjContext = {
    activeDeckId,
    inactiveDeckId,
    // currentTrack identity/metadata from the catalog, but bpm from the active
    // runtime's effective tempo (validated above) — never the nominal catalog bpm.
    currentTrack: { ...catalogTrackToSummary(currentTrack), bpm: effectiveBpm },
    candidates,
    recentlyPlayedTrackIds: [...recentlyPlayedTrackIds],
    limits,
  }

  return { ok: true, context, activeDeckId, inactiveDeckId, currentTrack }
}
