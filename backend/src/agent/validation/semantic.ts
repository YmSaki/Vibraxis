/**
 * Semantic validation applied AFTER JSON-schema validation. Schema validation
 * proves a payload is structurally a DjIntent/DjDecision; semantic validation
 * proves it is consistent with the concrete DjContext (real candidate ids, the
 * inactive deck, an allowed crossfade length, an in-range exact tempo rate, and
 * the beat grid the transition mode requires).
 *
 * Every check returns a typed failure. Nothing here mutates, clamps, rounds, or
 * substitutes a value: an out-of-range tempo rate or a disallowed crossfade
 * length is rejected, never snapped to a legal value (AGENTS.md §0.3, §0.6).
 */

import type { DjContext, DjDecision, DjIntent } from "@vibraxis/shared/dj";

export const INTENT_SEMANTIC_CODES = [
  "requestedTrackNotCandidate",
  "excludedTrackNotCandidate",
] as const;
export type IntentSemanticCode = (typeof INTENT_SEMANTIC_CODES)[number];

export const DECISION_SEMANTIC_CODES = [
  "nextTrackNotCandidate",
  "targetDeckNotInactive",
  "crossfadeBarsNotAllowed",
  "invalidReferenceBpm",
  "invalidCandidateBpm",
  "tempoRateOutOfRange",
  "beatGridMissing",
] as const;
export type DecisionSemanticCode = (typeof DECISION_SEMANTIC_CODES)[number];

export interface SemanticIssue<Code extends string> {
  code: Code;
  detail: string;
  trackId?: string;
}

export type SemanticValidation<Code extends string> =
  | { ok: true }
  | { ok: false; issues: SemanticIssue<Code>[] };

function ok<Code extends string>(): SemanticValidation<Code> {
  return { ok: true };
}

/**
 * A GPT-5.6 intent may only reference a track the application actually offered.
 * A `requestedTrackId` that is not among `context.candidates` is a fabrication
 * and is rejected rather than passed through to selection.
 */
export function validateIntentSemantics(
  intent: DjIntent,
  context: DjContext,
): SemanticValidation<IntentSemanticCode> {
  const candidateIds = new Set(context.candidates.map((c) => c.trackId));
  const issues: SemanticIssue<IntentSemanticCode>[] = [];
  if (intent.requestedTrackId !== null && !candidateIds.has(intent.requestedTrackId)) {
    issues.push({
      code: "requestedTrackNotCandidate",
      detail: "intent.requestedTrackId is not among context.candidates",
      trackId: intent.requestedTrackId,
    });
  }
  for (const trackId of intent.excludedTrackIds) {
    if (!candidateIds.has(trackId)) {
      issues.push({
        code: "excludedTrackNotCandidate",
        detail: "intent.excludedTrackIds contains an id not present in context.candidates",
        trackId,
      });
    }
  }
  return issues.length === 0 ? ok() : { ok: false, issues };
}

/**
 * Validates a Codex/AI decision against the concrete context and runtime limits.
 * Collects every violation (allErrors-style) so the caller sees the full reason.
 */
export function validateDecisionSemantics(
  decision: DjDecision,
  context: DjContext,
): SemanticValidation<DecisionSemanticCode> {
  const issues: SemanticIssue<DecisionSemanticCode>[] = [];

  const nextTrack = context.candidates.find(
    (c) => c.trackId === decision.nextTrackId,
  );
  if (nextTrack === undefined) {
    issues.push({
      code: "nextTrackNotCandidate",
      detail: "decision.nextTrackId is not among context.candidates",
      trackId: decision.nextTrackId,
    });
  }

  if (decision.targetDeckId !== context.inactiveDeckId) {
    issues.push({
      code: "targetDeckNotInactive",
      detail: `decision.targetDeckId ${decision.targetDeckId} is not the inactive deck ${context.inactiveDeckId}`,
    });
  }

  if (!context.limits.allowedCrossfadeBars.includes(decision.crossfadeBars)) {
    issues.push({
      code: "crossfadeBarsNotAllowed",
      detail: `decision.crossfadeBars ${decision.crossfadeBars} is not in limits.allowedCrossfadeBars`,
    });
  }

  // Tempo-sync requires an exact, in-range playback rate = currentBpm/nextBpm.
  // The rate is checked exactly; it is never clamped into range.
  const currentBpm = context.currentTrack.bpm;
  if (decision.tempoSync === "tempo") {
    if (!(currentBpm > 0)) {
      issues.push({
        code: "invalidReferenceBpm",
        detail: `current track bpm ${currentBpm} is not > 0`,
        trackId: context.currentTrack.trackId,
      });
    }
    if (nextTrack !== undefined) {
      if (!(nextTrack.bpm > 0)) {
        issues.push({
          code: "invalidCandidateBpm",
          detail: `next track bpm ${nextTrack.bpm} is not > 0`,
          trackId: nextTrack.trackId,
        });
      } else if (currentBpm > 0) {
        const rate = currentBpm / nextTrack.bpm;
        const { minPlaybackRate, maxPlaybackRate } = context.limits;
        if (rate < minPlaybackRate || rate > maxPlaybackRate) {
          issues.push({
            code: "tempoRateOutOfRange",
            detail: `exact tempo rate ${rate} is outside [${minPlaybackRate}, ${maxPlaybackRate}]`,
            trackId: nextTrack.trackId,
          });
        }
      }
    }
  }

  // Bar-aligned starts and tempo sync both need a beat grid on the current AND
  // next tracks. `startAt` is always "nextBar" per schema, so a next track
  // without a beat grid can never satisfy the transition.
  const needsBeatGrid =
    decision.startAt === "nextBar" || decision.tempoSync === "tempo";
  if (needsBeatGrid) {
    if (!context.currentTrack.hasBeatGrid) {
      issues.push({
        code: "beatGridMissing",
        detail: "current track has no beat grid for nextBar/tempo alignment",
        trackId: context.currentTrack.trackId,
      });
    }
    if (nextTrack !== undefined && !nextTrack.hasBeatGrid) {
      issues.push({
        code: "beatGridMissing",
        detail: "next track has no beat grid for nextBar/tempo alignment",
        trackId: nextTrack.trackId,
      });
    }
  }

  if (issues.length > 0) return { ok: false, issues };
  return ok();
}
