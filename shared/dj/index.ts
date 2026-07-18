/**
 * High-level contracts shared by the DJ providers, scoring logic, UI, and
 * TransitionExecutor. LLM outputs are deliberately limited to DjIntent and
 * DjDecision; neither type can contain VDAP commands, media URLs, or Web Audio
 * operations.
 */

export type DeckId = "A" | "B";

export type EnergyDirection = "decrease" | "maintain" | "increase";
export type TempoDirection = "slower" | "similar" | "faster" | "any";
export type HarmonicPriority = "strict" | "compatible" | "ignore";
export type TransitionUrgency = "quick" | "normal" | "gradual";
export type TempoSyncMode = "none" | "tempo";
export type TransitionStart = "nextBar";

/** Input sent to an intent provider. User text remains input-only. */
export interface UserDjRequest {
  text: string;
  context: DjContext;
}

/**
 * Structured interpretation of the user's words. Every preference is bounded
 * and machine-actionable so deterministic scoring can consume it.
 */
export interface DjIntent {
  energyDirection: EnergyDirection;
  targetEnergy: number | null;
  preferredGenres: string[];
  avoidedGenres: string[];
  preferredMoods: string[];
  avoidedMoods: string[];
  tempoDirection: TempoDirection;
  harmonicPriority: HarmonicPriority;
  transitionUrgency: TransitionUrgency;
  requestedTrackId: string | null;
  excludedTrackIds: string[];
  rationale: string;
  confidence: number;
}

/** Catalog information that providers may use when comparing tracks. */
export interface DjTrackSummary {
  trackId: string;
  title: string;
  artist: string;
  genre: string;
  mood: string[];
  bpm: number;
  camelot: string;
  energy: number;
  hasBeatGrid: boolean;
  hasSectionCues: boolean;
}

/** Stable numeric limits supplied by the runtime rather than invented by AI. */
export interface DjRuntimeLimits {
  minPlaybackRate: number;
  maxPlaybackRate: number;
  allowedCrossfadeBars: number[];
}

/**
 * Trusted context assembled by the application. Providers select only from
 * candidates in this object; they do not discover tracks or resolve URLs.
 */
export interface DjContext {
  activeDeckId: DeckId;
  inactiveDeckId: DeckId;
  currentTrack: DjTrackSummary;
  candidates: DjTrackSummary[];
  recentlyPlayedTrackIds: string[];
  limits: DjRuntimeLimits;
}

/**
 * A provider's high-level choice. The application must still validate that
 * nextTrackId is a supplied candidate, targetDeckId is inactive, and the
 * requested transition fits DjContext.limits before executing it.
 */
export interface DjDecision {
  nextTrackId: string;
  targetDeckId: DeckId;
  tempoSync: TempoSyncMode;
  startAt: TransitionStart;
  crossfadeBars: number;
  confidence: number;
  reasons: string[];
}

/**
 * Application-derived input for TransitionExecutor. This is not an LLM output;
 * it binds a validated decision to the active track observed by the runtime.
 */
export interface TransitionPlan {
  fromTrackId: string;
  /**
   * Canonical bindingId of the track playing on the active deck when the plan was
   * built. The executor passes it as `expectedBindingId` on the final active-deck
   * pause so a user reload of the active deck mid-transition is never paused
   * (fromTrackId is insufficient — the same track can be re-bound). Finding 6.
   */
  fromBindingId: string;
  activeDeckId: DeckId;
  nextTrackId: string;
  targetDeckId: DeckId;
  tempoSync: TempoSyncMode;
  startAt: TransitionStart;
  crossfadeBars: number;
  confidence: number;
  reasons: string[];
}
