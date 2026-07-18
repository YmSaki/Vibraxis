/**
 * Pure timing math for the minimal Beat Transition (roadmap 順序4).
 *
 * These functions carry the input values through unchanged: they never clamp,
 * round, or substitute a caller's request silently. {@link resolveTempoSync}
 * computes the exact velocity a tempo sync requires and reports whether it lies
 * inside the runtime velocity range; it never clamps an out-of-range request —
 * the caller rejects it (AGENTS §0.6/§0.7, VDAP §11.11).
 */

import type { PositionPair } from '@vibraxis/shared/vdap'
import { equalPowerGains } from '../../audio/audioMath'

export type TempoSyncResolution = {
  /** Reference deck effectiveBpm the follower is matched to. */
  targetBpm: number
  /** Velocity that would land the follower exactly on targetBpm. */
  requestedVelocity: number
  /** True when requestedVelocity is inside [range.min, range.max]. */
  withinRange: boolean
  /** The velocity range the request was checked against, echoed for the caller. */
  range: { min: number; max: number }
}

/**
 * Resolves a tempo-only `deck.sync`: computes the exact playback rate that lands
 * the follower on the reference effectiveBpm and reports whether it is inside
 * the runtime velocity range. It does NOT clamp — an out-of-range request is
 * returned verbatim with `withinRange:false` so the caller can reject it with
 * `E_OUT_OF_RANGE` without changing the input value (AGENTS §0.6/§0.7).
 */
export function resolveTempoSync(
  referenceEffectiveBpm: number,
  followerInterpretedBpm: number,
  range: { min: number; max: number },
): TempoSyncResolution {
  if (
    !Number.isFinite(referenceEffectiveBpm) || referenceEffectiveBpm <= 0
    || !Number.isFinite(followerInterpretedBpm) || followerInterpretedBpm <= 0
  ) {
    throw new RangeError('Tempo sync requires positive BPM values on both decks.')
  }
  const targetBpm = referenceEffectiveBpm
  const requestedVelocity = targetBpm / followerInterpretedBpm
  const withinRange = requestedVelocity >= range.min && requestedVelocity <= range.max
  return { targetBpm, requestedVelocity, withinRange, range }
}

/**
 * Returns the smallest boundary strictly greater than `currentSourceSeconds`,
 * or null when no such boundary exists in the grid (caller must treat this as
 * `beyondGrid`, never as an extrapolated guess).
 */
export function nextBoundarySeconds(
  boundaries: readonly number[],
  currentSourceSeconds: number,
): number | null {
  let best: number | null = null
  for (const value of boundaries) {
    if (!Number.isFinite(value)) continue
    if (value > currentSourceSeconds && (best === null || value < best)) best = value
  }
  return best
}

/**
 * Projects the runtime time at which the reference deck's head reaches
 * `targetSourceSeconds`, using its published position pair and headVelocity.
 * `headVelocity` MUST be > 0; feasibility is the caller's responsibility.
 */
export function boundaryRuntimeTime(
  position: PositionPair,
  headVelocity: number,
  targetSourceSeconds: number,
): number {
  if (!Number.isFinite(headVelocity) || headVelocity <= 0) {
    throw new RangeError('boundaryRuntimeTime requires a positive headVelocity.')
  }
  return position.atRuntimeTime + (targetSourceSeconds - position.sourceSeconds) / headVelocity
}

/**
 * Linearly interpolated crossfader position of an in-flight equal-power ramp at
 * `atTime`, clamped to the [startAt, startAt+durationSeconds] window. Position
 * (not gain) is interpolated linearly; the equal-power gains are derived from it
 * so the power-preservation invariant holds at every instant (VDAP §11.12).
 */
export function rampPositionAt(
  from: number,
  to: number,
  startAtRuntimeTime: number,
  durationSeconds: number,
  atTime: number,
): number {
  if (durationSeconds <= 0) return to
  const fraction = (atTime - startAtRuntimeTime) / durationSeconds
  const clamped = Math.min(1, Math.max(0, fraction))
  return from + (to - from) * clamped
}

export type RampSample = { fraction: number; position: number; gainA: number; gainB: number }

/**
 * Samples an equal-power crossfader ramp at `count`+1 evenly spaced fractions in
 * [0,1]. Exposed for invariant tests: A gain monotonic non-increasing / B gain
 * monotonic non-decreasing when `to > from`, and gainA²+gainB²≈1 everywhere.
 */
export function equalPowerRampSamples(from: number, to: number, count: number): RampSample[] {
  if (!Number.isInteger(count) || count < 1) {
    throw new RangeError('equalPowerRampSamples requires count >= 1.')
  }
  const samples: RampSample[] = []
  for (let index = 0; index <= count; index += 1) {
    const fraction = index / count
    const position = from + (to - from) * fraction
    const { a, b } = equalPowerGains(position)
    samples.push({ fraction, position, gainA: a, gainB: b })
  }
  return samples
}
