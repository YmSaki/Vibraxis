/**
 * Deterministic DJ selection logic (roadmap order 5).
 *
 * `selectNextTrack` is a pure function: given the same `DjContext`, `DjIntent`,
 * and `DjScoringPolicy` it always returns a byte-for-byte identical result. It
 * uses no time, randomness, I/O, or global mutable state, never mutates its
 * inputs, and never depends on the ordering of `context.candidates` to break a
 * tie (the final tie-break is the lexicographic `trackId`).
 *
 * Contract resolution (documented in ./DETERMINISTIC_SELECTION.md):
 * `DjDecision` cannot express "there is no valid next track" — `nextTrackId` is
 * required and every field is non-optional. Fabricating a decision when no
 * candidate qualifies would violate AGENTS.md §0 (report only the real result).
 * Therefore the deterministic logic returns a {@link DjSelectionResult}, which is
 * EITHER a `selected` variant carrying a validated `DjDecision` plus ranked
 * diagnostics, OR a `noCandidate` variant carrying machine-readable reasons plus
 * the same ranked diagnostics. The `DjDecision` shape itself is unchanged; the
 * adapter that converts a decision into VDAP commands still consumes exactly the
 * `DjDecision` from the `selected` variant.
 *
 * No user input is corrected, clamped, rounded, substituted, or silently
 * defaulted. A tempo-synced playback rate that falls outside the supplied
 * runtime limits excludes the candidate with a reason instead of being clamped.
 * The crossfade bar count is only ever chosen from `limits.allowedCrossfadeBars`;
 * an empty allow-list fails the decision rather than inventing a value. Scores,
 * confidence, and reason strings are DERIVED outputs, not user inputs; they are
 * rounded to a documented number of decimals purely for stable output.
 */

import type {
  DjContext,
  DjDecision,
  DjIntent,
  DjTrackSummary,
  EnergyDirection,
  HarmonicPriority,
  TempoDirection,
  TempoSyncMode,
  TransitionStart,
  TransitionUrgency,
} from "./index.ts";

/* ------------------------------------------------------------------ *
 * Machine-readable codes
 * ------------------------------------------------------------------ */

/** Why a single candidate was removed from (or scored inside) the ranking. */
export const DJ_EXCLUSION_CODES = [
  "isCurrentTrack",
  "recentlyPlayed",
  "explicitlyExcluded",
  "invalidBpm",
  "invalidPlaybackRate",
  "playbackRateBelowRange",
  "playbackRateAboveRange",
  "harmonicClash",
  "harmonicUnknown",
  "avoidedGenre",
  "avoidedMood",
] as const;
export type DjExclusionCode = (typeof DJ_EXCLUSION_CODES)[number];

/** Why the whole decision produced no next track. */
export const DJ_NO_CANDIDATE_CODES = [
  "emptyCandidateSet",
  "allCandidatesExcluded",
  "noAllowedCrossfadeBars",
  "invalidReferenceBpm",
  "requestedTrackNotFound",
  "requestedTrackIneligible",
] as const;
export type DjNoCandidateCode = (typeof DJ_NO_CANDIDATE_CODES)[number];

/** Harmonic (Camelot) relationship between the current track and a candidate. */
export const DJ_CAMELOT_RELATIONS = [
  "exact",
  "adjacent",
  "relative",
  "incompatible",
  "unknown",
] as const;
export type DjCamelotRelation = (typeof DJ_CAMELOT_RELATIONS)[number];

/* ------------------------------------------------------------------ *
 * Public result / diagnostic types
 * ------------------------------------------------------------------ */

export interface DjExclusion {
  code: DjExclusionCode;
  /** Human-readable context for debugging. Never affects behaviour. */
  detail: string;
}

export interface DjNoCandidateReason {
  code: DjNoCandidateCode;
  detail: string;
  /** Present when the reason is about one specific track. */
  trackId?: string;
}

/** Every scored sub-dimension for one candidate, each already in [0, 1]. */
export interface DjScoreComponents {
  rateSafety: number;
  tempoDirection: number;
  camelot: number;
  energy: number;
  genreMood: number;
  availability: number;
}

/** Inspectable per-candidate diagnostic: inclusion score AND exclusion reasons. */
export interface DjCandidateScore {
  trackId: string;
  /** Eligible for selection in the normal (no explicit request) path. */
  eligible: boolean;
  /** Weighted total in [0, 1], or `null` when the candidate could not be scored. */
  totalScore: number | null;
  components: DjScoreComponents | null;
  /** Exact tempo-sync playback rate = currentBpm / candidateBpm, or `null`. */
  playbackRate: number | null;
  camelotRelation: DjCamelotRelation;
  exclusions: DjExclusion[];
}

export type DjSelectionResult =
  | {
      status: "selected";
      decision: DjDecision;
      /** All candidates, selected first, then eligible by score, then excluded. */
      ranking: DjCandidateScore[];
    }
  | {
      status: "noCandidate";
      reasons: DjNoCandidateReason[];
      ranking: DjCandidateScore[];
    };

/* ------------------------------------------------------------------ *
 * Policy (every behaviour-affecting constant lives here)
 * ------------------------------------------------------------------ */

export interface DjScoringPolicy {
  /** Weights applied to each score component. MUST sum to 1. */
  readonly weights: {
    readonly rateSafety: number;
    readonly tempoDirection: number;
    readonly camelot: number;
    readonly energy: number;
    readonly genreMood: number;
    readonly availability: number;
  };
  /** Score contributed by each Camelot relation (when harmony is considered). */
  readonly camelotScores: {
    readonly exact: number;
    readonly adjacent: number;
    readonly relative: number;
    readonly incompatible: number;
    readonly unknown: number;
  };
  /** Target crossfade bar count per urgency, before intersecting the allow-list. */
  readonly crossfadeBarsByUrgency: Record<TransitionUrgency, number>;
  /** Half-width of the "similar tempo" band, as a BPM ratio (e.g. 0.02 = ±2%). */
  readonly tempoSimilarTolerance: number;
  /** Absolute energy delta that maps a "maintain" request to score 0. */
  readonly energyMaintainTolerance: number;
  /** Share of the availability score assigned to a usable beat grid (rest = cues). */
  readonly availabilityBeatGridShare: number;
  /** Decimal places derived scores/confidence are rounded to for stable output. */
  readonly roundingDecimals: number;
  /** Fixed decision fields (the deterministic logic always beat-matches on a bar). */
  readonly tempoSync: TempoSyncMode;
  readonly startAt: TransitionStart;
}

export const DEFAULT_DJ_POLICY: DjScoringPolicy = Object.freeze({
  weights: Object.freeze({
    rateSafety: 0.3,
    tempoDirection: 0.1,
    camelot: 0.2,
    energy: 0.2,
    genreMood: 0.1,
    availability: 0.1,
  }),
  camelotScores: Object.freeze({
    exact: 1,
    adjacent: 0.75,
    relative: 0.75,
    incompatible: 0,
    unknown: 0,
  }),
  crossfadeBarsByUrgency: Object.freeze({
    quick: 4,
    normal: 8,
    gradual: 16,
  }),
  tempoSimilarTolerance: 0.02,
  energyMaintainTolerance: 0.5,
  availabilityBeatGridShare: 0.7,
  roundingDecimals: 6,
  tempoSync: "tempo",
  startAt: "nextBar",
});

/* ------------------------------------------------------------------ *
 * Small deterministic helpers
 * ------------------------------------------------------------------ */

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  // Rounds derived scores only; user inputs are never routed through here.
  return Math.round(value * factor) / factor;
}

function clamp01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

interface CamelotKey {
  number: number;
  letter: "A" | "B";
}

/** Parses a Camelot code like "8A"/"12B". Returns null for anything malformed. */
export function parseCamelot(value: string): CamelotKey | null {
  const match = /^([1-9]|1[0-2])([AB])$/.exec(value);
  if (match === null) return null;
  return { number: Number(match[1]), letter: match[2] as "A" | "B" };
}

/** Classifies the harmonic relation from `current` to `candidate` on the wheel. */
export function classifyCamelot(current: string, candidate: string): DjCamelotRelation {
  const a = parseCamelot(current);
  const b = parseCamelot(candidate);
  if (a === null || b === null) return "unknown";
  if (a.number === b.number && a.letter === b.letter) return "exact";
  if (a.number === b.number) return "relative";
  if (a.letter === b.letter) {
    const forward = (a.number % 12) + 1;
    const backward = ((a.number + 10) % 12) + 1;
    if (b.number === forward || b.number === backward) return "adjacent";
  }
  return "incompatible";
}

/* ------------------------------------------------------------------ *
 * Structural validation (malformed inputs throw; unusable data excludes)
 * ------------------------------------------------------------------ */

function assertFiniteNumber(name: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${name} must be a finite number.`);
  }
  return value;
}

function assertString(name: string, value: unknown): string {
  if (typeof value !== "string") throw new TypeError(`${name} must be a string.`);
  return value;
}

function assertBoundedString(name: string, value: unknown, min: number, max: number): string {
  const result = assertString(name, value);
  if (result.length < min || result.length > max) {
    throw new RangeError(`${name} length must be in [${min}, ${max}].`);
  }
  return result;
}

function assertStringArray(
  name: string,
  value: unknown,
  maxItems: number,
  maxItemLength = 200,
): string[] {
  if (!Array.isArray(value)) throw new TypeError(`${name} must be an array.`);
  if (value.length > maxItems) throw new RangeError(`${name} must contain at most ${maxItems} items.`);
  value.forEach((item, index) =>
    assertBoundedString(`${name}[${index}]`, item, 1, maxItemLength),
  );
  return value as string[];
}

function assertEnum<T extends string>(name: string, value: unknown, allowed: readonly T[]): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new RangeError(`${name} must be one of: ${allowed.join(", ")}.`);
  }
  return value as T;
}

function assertUnitInterval(name: string, value: unknown): number {
  const result = assertFiniteNumber(name, value);
  if (result < 0 || result > 1) throw new RangeError(`${name} must be in [0, 1].`);
  return result;
}

function assertTrackSummary(name: string, track: unknown): DjTrackSummary {
  if (typeof track !== "object" || track === null) {
    throw new TypeError(`${name} must be an object.`);
  }
  const t = track as Record<string, unknown>;
  assertBoundedString(`${name}.trackId`, t.trackId, 1, 200);
  assertBoundedString(`${name}.title`, t.title, 1, 300);
  assertBoundedString(`${name}.artist`, t.artist, 1, 300);
  assertBoundedString(`${name}.camelot`, t.camelot, 1, 32);
  assertBoundedString(`${name}.genre`, t.genre, 1, 80);
  assertFiniteNumber(`${name}.bpm`, t.bpm);
  assertUnitInterval(`${name}.energy`, t.energy);
  if (!Array.isArray(t.mood) || t.mood.some((m) => typeof m !== "string")) {
    throw new TypeError(`${name}.mood must be an array of strings.`);
  }
  if (t.mood.length > 32) throw new RangeError(`${name}.mood must contain at most 32 items.`);
  t.mood.forEach((m, index) => assertBoundedString(`${name}.mood[${index}]`, m, 1, 80));
  if (typeof t.hasBeatGrid !== "boolean") {
    throw new TypeError(`${name}.hasBeatGrid must be a boolean.`);
  }
  if (typeof t.hasSectionCues !== "boolean") {
    throw new TypeError(`${name}.hasSectionCues must be a boolean.`);
  }
  return track as DjTrackSummary;
}

function validateInputs(context: DjContext, intent: DjIntent, policy: DjScoringPolicy): void {
  if (typeof context !== "object" || context === null) {
    throw new TypeError("context must be an object.");
  }
  if (typeof intent !== "object" || intent === null) {
    throw new TypeError("intent must be an object.");
  }
  assertEnum("context.activeDeckId", context.activeDeckId, ["A", "B"] as const);
  assertEnum("context.inactiveDeckId", context.inactiveDeckId, ["A", "B"] as const);
  if (context.activeDeckId === context.inactiveDeckId) {
    throw new RangeError("context.activeDeckId and inactiveDeckId must differ.");
  }
  assertTrackSummary("context.currentTrack", context.currentTrack);
  if (!Array.isArray(context.candidates)) {
    throw new TypeError("context.candidates must be an array.");
  }
  context.candidates.forEach((candidate, index) =>
    assertTrackSummary(`context.candidates[${index}]`, candidate),
  );
  const candidateIds = context.candidates.map((candidate) => candidate.trackId);
  if (new Set(candidateIds).size !== candidateIds.length) {
    throw new RangeError("context.candidates trackId values must be unique.");
  }
  assertStringArray("context.recentlyPlayedTrackIds", context.recentlyPlayedTrackIds, 1000);
  const limits = context.limits;
  if (typeof limits !== "object" || limits === null) {
    throw new TypeError("context.limits must be an object.");
  }
  const min = assertFiniteNumber("limits.minPlaybackRate", limits.minPlaybackRate);
  const max = assertFiniteNumber("limits.maxPlaybackRate", limits.maxPlaybackRate);
  if (min <= 0 || max < min) {
    throw new RangeError("limits requires 0 < minPlaybackRate <= maxPlaybackRate.");
  }
  if (!Array.isArray(limits.allowedCrossfadeBars)) {
    throw new TypeError("limits.allowedCrossfadeBars must be an array.");
  }
  limits.allowedCrossfadeBars.forEach((bars, index) => {
    const value = assertFiniteNumber(`limits.allowedCrossfadeBars[${index}]`, bars);
    if (!Number.isInteger(value) || value <= 0) {
      throw new RangeError(`limits.allowedCrossfadeBars[${index}] must be a positive integer.`);
    }
  });

  assertEnum("intent.energyDirection", intent.energyDirection, ["decrease", "maintain", "increase"] as const);
  if (intent.targetEnergy !== null) assertUnitInterval("intent.targetEnergy", intent.targetEnergy);
  assertStringArray("intent.preferredGenres", intent.preferredGenres, 8, 80);
  assertStringArray("intent.avoidedGenres", intent.avoidedGenres, 8, 80);
  assertStringArray("intent.preferredMoods", intent.preferredMoods, 8, 80);
  assertStringArray("intent.avoidedMoods", intent.avoidedMoods, 8, 80);
  assertEnum("intent.tempoDirection", intent.tempoDirection, ["slower", "similar", "faster", "any"] as const);
  assertEnum("intent.harmonicPriority", intent.harmonicPriority, ["strict", "compatible", "ignore"] as const);
  assertEnum("intent.transitionUrgency", intent.transitionUrgency, ["quick", "normal", "gradual"] as const);
  if (intent.requestedTrackId !== null) {
    assertBoundedString("intent.requestedTrackId", intent.requestedTrackId, 1, 200);
  }
  assertStringArray("intent.excludedTrackIds", intent.excludedTrackIds, 50);
  assertBoundedString("intent.rationale", intent.rationale, 1, 500);
  assertUnitInterval("intent.confidence", intent.confidence);

  if (typeof policy !== "object" || policy === null) throw new TypeError("policy must be an object.");
  if (typeof policy.weights !== "object" || policy.weights === null) {
    throw new TypeError("policy.weights must be an object.");
  }
  const weightKeys = [
    "rateSafety",
    "tempoDirection",
    "camelot",
    "energy",
    "genreMood",
    "availability",
  ] as const;
  const suppliedWeightKeys = Object.keys(policy.weights).sort();
  const expectedWeightKeys = [...weightKeys].sort();
  if (
    suppliedWeightKeys.length !== expectedWeightKeys.length ||
    suppliedWeightKeys.some((key, index) => key !== expectedWeightKeys[index])
  ) {
    throw new RangeError(`policy.weights keys must be exactly: ${weightKeys.join(", ")}.`);
  }
  weightKeys.forEach((key) => assertUnitInterval(`policy.weights.${key}`, policy.weights[key]));

  const weightSum =
    policy.weights.rateSafety +
    policy.weights.tempoDirection +
    policy.weights.camelot +
    policy.weights.energy +
    policy.weights.genreMood +
    policy.weights.availability;
  if (Math.abs(weightSum - 1) > 1e-9) {
    throw new RangeError("policy.weights must sum to 1.");
  }
  for (const relation of DJ_CAMELOT_RELATIONS) {
    assertUnitInterval(`policy.camelotScores.${relation}`, policy.camelotScores?.[relation]);
  }
  for (const urgency of ["quick", "normal", "gradual"] as const) {
    const bars = assertFiniteNumber(
      `policy.crossfadeBarsByUrgency.${urgency}`,
      policy.crossfadeBarsByUrgency?.[urgency],
    );
    if (!Number.isInteger(bars) || bars <= 0) {
      throw new RangeError(`policy.crossfadeBarsByUrgency.${urgency} must be a positive integer.`);
    }
  }
  const tempoTolerance = assertFiniteNumber("policy.tempoSimilarTolerance", policy.tempoSimilarTolerance);
  if (tempoTolerance <= 0) throw new RangeError("policy.tempoSimilarTolerance must be > 0.");
  const energyTolerance = assertFiniteNumber("policy.energyMaintainTolerance", policy.energyMaintainTolerance);
  if (energyTolerance <= 0) throw new RangeError("policy.energyMaintainTolerance must be > 0.");
  assertUnitInterval("policy.availabilityBeatGridShare", policy.availabilityBeatGridShare);
  const decimals = assertFiniteNumber("policy.roundingDecimals", policy.roundingDecimals);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 12) {
    throw new RangeError("policy.roundingDecimals must be an integer in [0, 12].");
  }
  if (policy.tempoSync !== "tempo") throw new RangeError('policy.tempoSync must be "tempo".');
  if (policy.startAt !== "nextBar") throw new RangeError('policy.startAt must be "nextBar".');
}

/* ------------------------------------------------------------------ *
 * Scoring components
 * ------------------------------------------------------------------ */

function rateSafetyScore(rate: number, minRate: number, maxRate: number): number {
  const upperSpan = maxRate - 1;
  const lowerSpan = 1 - minRate;
  const denom = Math.max(upperSpan, lowerSpan, 1e-9);
  return clamp01(1 - Math.abs(rate - 1) / denom);
}

function tempoDirectionScore(
  currentBpm: number,
  candidateBpm: number,
  direction: TempoDirection,
  tolerance: number,
): number {
  if (direction === "any") return 1;
  const ratio = candidateBpm / currentBpm;
  if (direction === "similar") {
    return clamp01(1 - Math.abs(ratio - 1) / Math.max(tolerance * 4, 1e-9));
  }
  if (direction === "faster") {
    if (ratio >= 1 + tolerance) return 1;
    if (ratio > 1) return 0.5;
    return 0;
  }
  // slower
  if (ratio <= 1 - tolerance) return 1;
  if (ratio < 1) return 0.5;
  return 0;
}

function energyScore(
  currentEnergy: number,
  candidateEnergy: number,
  direction: EnergyDirection,
  targetEnergy: number | null,
  maintainTolerance: number,
): number {
  if (targetEnergy !== null) {
    return clamp01(1 - Math.abs(candidateEnergy - targetEnergy));
  }
  const delta = candidateEnergy - currentEnergy;
  if (direction === "increase") return clamp01(0.5 + delta / 2);
  if (direction === "decrease") return clamp01(0.5 - delta / 2);
  // maintain
  return clamp01(1 - Math.abs(delta) / Math.max(maintainTolerance, 1e-9));
}

function camelotScore(
  relation: DjCamelotRelation,
  priority: HarmonicPriority,
  scores: DjScoringPolicy["camelotScores"],
): number {
  if (priority === "ignore") return 1; // neutral: harmony must not affect ranking
  return scores[relation];
}

function genreMoodScore(candidate: DjTrackSummary, intent: DjIntent): number {
  const genreScore =
    intent.preferredGenres.length === 0
      ? 1
      : intent.preferredGenres.includes(candidate.genre)
        ? 1
        : 0;
  let moodScore = 1;
  if (intent.preferredMoods.length > 0) {
    const overlap = candidate.mood.filter((m) => intent.preferredMoods.includes(m)).length;
    moodScore = clamp01(overlap / intent.preferredMoods.length);
  }
  return 0.5 * genreScore + 0.5 * moodScore;
}

function availabilityScore(candidate: DjTrackSummary, beatGridShare: number): number {
  const cueShare = 1 - beatGridShare;
  return (candidate.hasBeatGrid ? beatGridShare : 0) + (candidate.hasSectionCues ? cueShare : 0);
}

/* ------------------------------------------------------------------ *
 * Per-candidate evaluation
 * ------------------------------------------------------------------ */

interface Evaluation {
  track: DjTrackSummary;
  score: DjCandidateScore;
  /** Hard exclusions: never-select / physical limits (apply even to a request). */
  hardCodes: DjExclusionCode[];
  /** Preference exclusions: overridable by an explicit requestedTrackId. */
  prefCodes: DjExclusionCode[];
}

function evaluateCandidate(
  candidate: DjTrackSummary,
  context: DjContext,
  intent: DjIntent,
  policy: DjScoringPolicy,
  currentBpm: number,
): Evaluation {
  const hard: DjExclusion[] = [];
  const pref: DjExclusion[] = [];
  const { minPlaybackRate, maxPlaybackRate } = context.limits;

  // Hard: never select current / recent / explicitly excluded.
  if (candidate.trackId === context.currentTrack.trackId) {
    hard.push({ code: "isCurrentTrack", detail: "candidate is the current track" });
  }
  if (context.recentlyPlayedTrackIds.includes(candidate.trackId)) {
    hard.push({ code: "recentlyPlayed", detail: "candidate is in recentlyPlayedTrackIds" });
  }
  if (intent.excludedTrackIds.includes(candidate.trackId)) {
    hard.push({ code: "explicitlyExcluded", detail: "candidate is in intent.excludedTrackIds" });
  }

  // Hard: exact tempo-sync playback rate must be computable and in range.
  let playbackRate: number | null = null;
  let rateUsable = false;
  if (candidate.bpm <= 0) {
    hard.push({ code: "invalidBpm", detail: `candidate bpm ${candidate.bpm} is not > 0` });
  } else {
    const computedRate = currentBpm / candidate.bpm;
    if (!Number.isFinite(computedRate)) {
      hard.push({
        code: "invalidPlaybackRate",
        detail: `computed rate ${computedRate} is not finite`,
      });
    } else {
      playbackRate = computedRate;
    }
    if (playbackRate !== null && playbackRate < minPlaybackRate) {
      hard.push({
        code: "playbackRateBelowRange",
        detail: `rate ${playbackRate} < minPlaybackRate ${minPlaybackRate}`,
      });
    } else if (playbackRate !== null && playbackRate > maxPlaybackRate) {
      hard.push({
        code: "playbackRateAboveRange",
        detail: `rate ${playbackRate} > maxPlaybackRate ${maxPlaybackRate}`,
      });
    } else if (playbackRate !== null) {
      rateUsable = true;
    }
  }

  // Preference: harmonic priority.
  const relation = classifyCamelot(context.currentTrack.camelot, candidate.camelot);
  if (intent.harmonicPriority === "strict") {
    if (relation === "unknown") {
      pref.push({
        code: "harmonicUnknown",
        detail: `camelot ${context.currentTrack.camelot}->${candidate.camelot} not parseable`,
      });
    } else if (relation === "incompatible") {
      pref.push({
        code: "harmonicClash",
        detail: `camelot ${context.currentTrack.camelot}->${candidate.camelot} incompatible`,
      });
    }
  }

  // Preference: avoided genre / mood.
  if (intent.avoidedGenres.includes(candidate.genre)) {
    pref.push({ code: "avoidedGenre", detail: `genre ${candidate.genre} is avoided` });
  }
  const avoidedMoodHit = candidate.mood.find((m) => intent.avoidedMoods.includes(m));
  if (avoidedMoodHit !== undefined) {
    pref.push({ code: "avoidedMood", detail: `mood ${avoidedMoodHit} is avoided` });
  }

  // Components are computed whenever the rate is usable, so excluded candidates
  // still expose inspectable inclusion scores.
  let components: DjScoreComponents | null = null;
  let totalScore: number | null = null;
  if (rateUsable && playbackRate !== null) {
    const raw: DjScoreComponents = {
      rateSafety: rateSafetyScore(playbackRate, minPlaybackRate, maxPlaybackRate),
      tempoDirection: tempoDirectionScore(
        currentBpm,
        candidate.bpm,
        intent.tempoDirection,
        policy.tempoSimilarTolerance,
      ),
      camelot: camelotScore(relation, intent.harmonicPriority, policy.camelotScores),
      energy: energyScore(
        context.currentTrack.energy,
        candidate.energy,
        intent.energyDirection,
        intent.targetEnergy,
        policy.energyMaintainTolerance,
      ),
      genreMood: genreMoodScore(candidate, intent),
      availability: availabilityScore(candidate, policy.availabilityBeatGridShare),
    };
    components = {
      rateSafety: roundTo(raw.rateSafety, policy.roundingDecimals),
      tempoDirection: roundTo(raw.tempoDirection, policy.roundingDecimals),
      camelot: roundTo(raw.camelot, policy.roundingDecimals),
      energy: roundTo(raw.energy, policy.roundingDecimals),
      genreMood: roundTo(raw.genreMood, policy.roundingDecimals),
      availability: roundTo(raw.availability, policy.roundingDecimals),
    };
    const weighted =
      raw.rateSafety * policy.weights.rateSafety +
      raw.tempoDirection * policy.weights.tempoDirection +
      raw.camelot * policy.weights.camelot +
      raw.energy * policy.weights.energy +
      raw.genreMood * policy.weights.genreMood +
      raw.availability * policy.weights.availability;
    totalScore = roundTo(weighted, policy.roundingDecimals);
  }

  const exclusions = [...hard, ...pref];
  const eligible = exclusions.length === 0;
  return {
    track: candidate,
    hardCodes: hard.map((e) => e.code),
    prefCodes: pref.map((e) => e.code),
    score: {
      trackId: candidate.trackId,
      eligible,
      totalScore,
      components,
      playbackRate,
      camelotRelation: relation,
      exclusions,
    },
  };
}

/* ------------------------------------------------------------------ *
 * Ranking / tie-breaking
 * ------------------------------------------------------------------ */

/**
 * Total order over eligible candidates, independent of input array order.
 * Returns negative when `a` should rank before `b`.
 */
function compareEligible(a: DjCandidateScore, b: DjCandidateScore): number {
  const at = a.totalScore ?? -1;
  const bt = b.totalScore ?? -1;
  if (at !== bt) return bt - at;
  const ac = a.components;
  const bc = b.components;
  if (ac !== null && bc !== null) {
    if (ac.camelot !== bc.camelot) return bc.camelot - ac.camelot;
    if (ac.energy !== bc.energy) return bc.energy - ac.energy;
    if (ac.rateSafety !== bc.rateSafety) return bc.rateSafety - ac.rateSafety;
  }
  return a.trackId < b.trackId ? -1 : a.trackId > b.trackId ? 1 : 0;
}

function buildRanking(evaluations: Evaluation[], selectedTrackId: string | null): DjCandidateScore[] {
  const group = (score: DjCandidateScore): number => {
    if (score.trackId === selectedTrackId) return 0;
    if (score.eligible) return 1;
    return 2;
  };
  return evaluations
    .map((e) => e.score)
    .slice()
    .sort((a, b) => {
      const ga = group(a);
      const gb = group(b);
      if (ga !== gb) return ga - gb;
      if (ga === 2) return a.trackId < b.trackId ? -1 : a.trackId > b.trackId ? 1 : 0;
      return compareEligible(a, b);
    });
}

/* ------------------------------------------------------------------ *
 * Crossfade bar selection
 * ------------------------------------------------------------------ */

/**
 * Chooses a crossfade bar count from the runtime allow-list only. Returns the
 * allowed value nearest the urgency target, breaking ties toward the smaller
 * (quicker, safer) value. Returns null when the allow-list is empty.
 */
export function selectCrossfadeBars(allowed: readonly number[], target: number): number | null {
  if (!Array.isArray(allowed)) throw new TypeError("allowed must be an array.");
  if (!Number.isFinite(target) || !Number.isInteger(target) || target <= 0) {
    throw new RangeError("target must be a positive integer.");
  }
  let best: number | null = null;
  for (const [index, value] of allowed.entries()) {
    if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
      throw new RangeError(`allowed[${index}] must be a positive integer.`);
    }
    if (best === null) {
      best = value;
      continue;
    }
    const dNew = Math.abs(value - target);
    const dBest = Math.abs(best - target);
    if (dNew < dBest || (dNew === dBest && value < best)) {
      best = value;
    }
  }
  return best;
}

/* ------------------------------------------------------------------ *
 * Decision assembly
 * ------------------------------------------------------------------ */

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(4);
}

function buildReasons(
  selected: DjCandidateScore,
  context: DjContext,
  intent: DjIntent,
  crossfadeBars: number,
): string[] {
  const track = context.candidates.find((c) => c.trackId === selected.trackId);
  const reasons: string[] = [
    `select:${selected.trackId} score=${formatNumber(selected.totalScore ?? 0)}`,
  ];
  if (selected.playbackRate !== null) {
    reasons.push(
      `tempo:sync rate=${formatNumber(selected.playbackRate)} in [${formatNumber(
        context.limits.minPlaybackRate,
      )},${formatNumber(context.limits.maxPlaybackRate)}]`,
    );
  }
  if (track) {
    reasons.push(
      `tempoDir:${intent.tempoDirection} ${formatNumber(context.currentTrack.bpm)}->${formatNumber(track.bpm)}`,
    );
    reasons.push(
      `camelot:${context.currentTrack.camelot}->${track.camelot} ${selected.camelotRelation} priority=${intent.harmonicPriority}`,
    );
    const energyRef = intent.targetEnergy !== null ? `target=${formatNumber(intent.targetEnergy)}` : intent.energyDirection;
    reasons.push(
      `energy:${energyRef} ${formatNumber(context.currentTrack.energy)}->${formatNumber(track.energy)}`,
    );
    reasons.push(`grid:beat=${track.hasBeatGrid} section=${track.hasSectionCues}`);
  }
  reasons.push(`crossfade:${crossfadeBars}bars urgency=${intent.transitionUrgency}`);
  return reasons.slice(0, 8);
}

function noCandidate(
  reasons: DjNoCandidateReason[],
  ranking: DjCandidateScore[],
): DjSelectionResult {
  return { status: "noCandidate", reasons, ranking };
}

/* ------------------------------------------------------------------ *
 * Entry point
 * ------------------------------------------------------------------ */

export function selectNextTrack(
  context: DjContext,
  intent: DjIntent,
  policy: DjScoringPolicy = DEFAULT_DJ_POLICY,
): DjSelectionResult {
  validateInputs(context, intent, policy);

  const currentBpm = context.currentTrack.bpm;

  // A tempo-synced rate cannot be computed against an invalid reference BPM; we
  // reject the whole decision rather than invent a rate.
  if (currentBpm <= 0) {
    const ranking = context.candidates
      .map<DjCandidateScore>((c) => ({
        trackId: c.trackId,
        eligible: false,
        totalScore: null,
        components: null,
        playbackRate: null,
        camelotRelation: classifyCamelot(context.currentTrack.camelot, c.camelot),
        exclusions: [{ code: "invalidBpm", detail: "reference (current) bpm is not > 0" }],
      }))
      .slice()
      .sort((a, b) => (a.trackId < b.trackId ? -1 : a.trackId > b.trackId ? 1 : 0));
    return noCandidate(
      [
        {
          code: "invalidReferenceBpm",
          detail: `current track bpm ${currentBpm} is not > 0`,
          trackId: context.currentTrack.trackId,
        },
      ],
      ranking,
    );
  }

  const evaluations = context.candidates.map((candidate) =>
    evaluateCandidate(candidate, context, intent, policy, currentBpm),
  );

  const target = policy.crossfadeBarsByUrgency[intent.transitionUrgency];
  const crossfadeBars = selectCrossfadeBars(context.limits.allowedCrossfadeBars, target);

  // Requested-track path: an explicit trackId overrides preference exclusions
  // but never the hard never-select / rate rules.
  if (intent.requestedTrackId !== null) {
    const requestedId = intent.requestedTrackId;
    const match = evaluations.find((e) => e.track.trackId === requestedId);
    if (match === undefined) {
      return noCandidate(
        [
          {
            code: "requestedTrackNotFound",
            detail: "requestedTrackId is not among context.candidates",
            trackId: requestedId,
          },
        ],
        buildRanking(evaluations, null),
      );
    }
    if (match.hardCodes.length > 0) {
      return noCandidate(
        [
          {
            code: "requestedTrackIneligible",
            detail: `requested track blocked by: ${match.hardCodes.join(", ")}`,
            trackId: requestedId,
          },
        ],
        buildRanking(evaluations, null),
      );
    }
    if (crossfadeBars === null) {
      return noCandidate(
        [
          {
            code: "noAllowedCrossfadeBars",
            detail: "limits.allowedCrossfadeBars is empty",
          },
        ],
        buildRanking(evaluations, requestedId),
      );
    }
    const ranking = buildRanking(evaluations, requestedId);
    return {
      status: "selected",
      decision: {
        nextTrackId: requestedId,
        targetDeckId: context.inactiveDeckId,
        tempoSync: policy.tempoSync,
        startAt: policy.startAt,
        crossfadeBars,
        confidence: match.score.totalScore ?? 0,
        reasons: buildReasons(match.score, context, intent, crossfadeBars),
      },
      ranking,
    };
  }

  // Normal path: rank fully eligible candidates.
  const eligible = evaluations.filter((e) => e.score.eligible);
  if (eligible.length === 0) {
    return noCandidate(
      [
        context.candidates.length === 0
          ? { code: "emptyCandidateSet", detail: "context.candidates is empty" }
          : {
              code: "allCandidatesExcluded",
              detail: "every candidate hit at least one exclusion",
            },
      ],
      buildRanking(evaluations, null),
    );
  }

  const winner = eligible.map((e) => e.score).slice().sort(compareEligible)[0];

  if (crossfadeBars === null) {
    return noCandidate(
      [{ code: "noAllowedCrossfadeBars", detail: "limits.allowedCrossfadeBars is empty" }],
      buildRanking(evaluations, winner.trackId),
    );
  }

  return {
    status: "selected",
    decision: {
      nextTrackId: winner.trackId,
      targetDeckId: context.inactiveDeckId,
      tempoSync: policy.tempoSync,
      startAt: policy.startAt,
      crossfadeBars,
      confidence: winner.totalScore ?? 0,
      reasons: buildReasons(winner, context, intent, crossfadeBars),
    },
    ranking: buildRanking(evaluations, winner.trackId),
  };
}
