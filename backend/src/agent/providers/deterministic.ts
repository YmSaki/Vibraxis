/**
 * DeterministicProvider — a thin, faithful wrapper over Order 5's
 * `selectNextTrack`. It adds no behaviour: given the same context/intent/policy
 * it returns exactly what the pure engine returns, including the explicit
 * `noCandidate` variant. It never fabricates a decision when there is no
 * eligible candidate (AGENTS.md §0.7: reject/fail rather than invent).
 */

import {
  DEFAULT_DJ_POLICY,
  selectNextTrack,
  type DjCandidateScore,
  type DjContext,
  type DjIntent,
  type DjScoringPolicy,
  type DjSelectionResult,
} from "@vibraxis/shared/dj";

export class DeterministicProvider {
  private readonly policy: DjScoringPolicy;

  constructor(policy: DjScoringPolicy = DEFAULT_DJ_POLICY) {
    this.policy = policy;
  }

  /** Runs the pure engine. Malformed input throws (as documented by Order 5). */
  decide(context: DjContext, intent: DjIntent): DjSelectionResult {
    return selectNextTrack(context, intent, this.policy);
  }

  /**
   * Returns up to `size` eligible candidate ids, highest deterministic score
   * first. This is a hard Codex input boundary: only these ids are disclosed and
   * a resulting pick outside the shortlist is rejected. `size === null` returns
   * all eligible candidates.
   */
  shortlist(
    context: DjContext,
    intent: DjIntent,
    size: number | null,
  ): { rankedEligibleIds: string[]; ranking: DjCandidateScore[] } {
    const result = this.decide(context, intent);
    const ranking = result.ranking;
    const eligible = ranking.filter((r) => r.eligible);
    const ids = eligible.map((r) => r.trackId);
    return {
      rankedEligibleIds: size === null ? ids : ids.slice(0, size),
      ranking,
    };
  }
}
