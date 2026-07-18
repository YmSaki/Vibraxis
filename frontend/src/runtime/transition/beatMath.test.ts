import { describe, expect, it } from 'vitest'
import {
  boundaryRuntimeTime,
  equalPowerRampSamples,
  nextBoundarySeconds,
  rampPositionAt,
  resolveTempoSync,
} from './beatMath'

describe('resolveTempoSync', () => {
  it('reports withinRange when the follower stays in range', () => {
    const result = resolveTempoSync(128, 128, { min: 0.5, max: 1.5 })
    expect(result).toEqual({ targetBpm: 128, requestedVelocity: 1, withinRange: true, range: { min: 0.5, max: 1.5 } })
  })

  it('returns the exact request with withinRange:false out of range — never clamps (§11.11, AGENTS §0.6)', () => {
    // 200 -> 90 requires 2.22x, above the 1.5 ceiling: report it verbatim so the
    // caller can reject with E_OUT_OF_RANGE. No clamping, no substitution.
    const result = resolveTempoSync(200, 90, { min: 0.5, max: 1.5 })
    expect(result.requestedVelocity).toBeCloseTo(200 / 90, 10)
    expect(result.withinRange).toBe(false)
    // The boundary is inclusive: exactly 1.5x is still in range.
    expect(resolveTempoSync(180, 120, { min: 0.5, max: 1.5 }).withinRange).toBe(true)
  })

  it('rejects non-positive BPM instead of substituting a value', () => {
    expect(() => resolveTempoSync(0, 120, { min: 0.5, max: 1.5 })).toThrow(RangeError)
    expect(() => resolveTempoSync(120, -1, { min: 0.5, max: 1.5 })).toThrow(RangeError)
  })
})

describe('nextBoundarySeconds', () => {
  it('returns the smallest boundary strictly greater than the current position', () => {
    expect(nextBoundarySeconds([0, 1, 2, 3], 1)).toBe(2)
    expect(nextBoundarySeconds([0, 1, 2, 3], 1.0001)).toBe(2)
  })

  it('returns null past the end of the grid rather than extrapolating', () => {
    expect(nextBoundarySeconds([0, 1, 2], 2)).toBeNull()
    expect(nextBoundarySeconds([], 0)).toBeNull()
  })
})

describe('boundaryRuntimeTime', () => {
  it('projects the runtime time the head reaches the target source second', () => {
    const position = { sourceSeconds: 10, atRuntimeTime: 100 }
    // 2 seconds of source at 1x = 2 seconds of runtime.
    expect(boundaryRuntimeTime(position, 1, 12)).toBe(102)
    // At 2x source advances twice as fast, so the boundary arrives sooner.
    expect(boundaryRuntimeTime(position, 2, 12)).toBe(101)
  })

  it('requires a positive headVelocity', () => {
    expect(() => boundaryRuntimeTime({ sourceSeconds: 0, atRuntimeTime: 0 }, 0, 1)).toThrow(RangeError)
  })
})

describe('rampPositionAt', () => {
  it('interpolates linearly and clamps to the ramp window', () => {
    expect(rampPositionAt(-1, 1, 100, 4, 100)).toBe(-1)
    expect(rampPositionAt(-1, 1, 100, 4, 102)).toBe(0)
    expect(rampPositionAt(-1, 1, 100, 4, 104)).toBe(1)
    expect(rampPositionAt(-1, 1, 100, 4, 110)).toBe(1)
    expect(rampPositionAt(-1, 1, 100, 4, 90)).toBe(-1)
  })
})

describe('equalPowerRampSamples', () => {
  it('keeps A monotonic non-increasing and B monotonic non-decreasing for an A->B ramp', () => {
    const samples = equalPowerRampSamples(-1, 1, 64)
    for (let i = 1; i < samples.length; i += 1) {
      expect(samples[i].gainA).toBeLessThanOrEqual(samples[i - 1].gainA + 1e-12)
      expect(samples[i].gainB).toBeGreaterThanOrEqual(samples[i - 1].gainB - 1e-12)
    }
  })

  it('preserves equal power at every sample (|gainA²+gainB²-1| <= 0.01)', () => {
    for (const [from, to] of [[-1, 1], [1, -1], [-0.3, 0.8]] as const) {
      for (const sample of equalPowerRampSamples(from, to, 128)) {
        const power = sample.gainA ** 2 + sample.gainB ** 2
        expect(Math.abs(power - 1)).toBeLessThanOrEqual(0.01)
      }
    }
  })
})
