import { describe, expect, it } from 'vitest'
import { calculateTempoSync, djCrossfaderGains, equalPowerGains, formatTime, interpretedBpm } from './audioMath'

describe('interpretedBpm', () => {
  it('supports half-time and double-time interpretations without changing audio speed', () => {
    expect(interpretedBpm(155, 0.5)).toBe(77.5)
    expect(interpretedBpm(155, 2)).toBe(310)
  })
})

describe('calculateTempoSync', () => {
  it('matches the follower to the master effective tempo', () => {
    const result = calculateTempoSync(120, 1.05, 100)

    expect(result.targetBpm).toBeCloseTo(126)
    expect(result.playbackRate).toBeCloseTo(1.26)
    expect(result.exact).toBe(true)
  })

  it('clamps rates that the deck cannot reach', () => {
    const result = calculateTempoSync(180, 1, 80)

    expect(result.requestedRate).toBeCloseTo(2.25)
    expect(result.playbackRate).toBe(1.5)
    expect(result.exact).toBe(false)
  })

  it('rejects invalid tempo data', () => {
    expect(() => calculateTempoSync(0, 1, 120)).toThrow(RangeError)
  })
})

describe('equalPowerGains', () => {
  it('isolates the opposite deck at each edge', () => {
    expect(equalPowerGains(-1).a).toBeCloseTo(1)
    expect(equalPowerGains(-1).b).toBeCloseTo(0)
    expect(equalPowerGains(1).a).toBeCloseTo(0)
    expect(equalPowerGains(1).b).toBeCloseTo(1)
  })

  it('keeps constant power at the center', () => {
    const gains = equalPowerGains(0)
    expect(gains.a).toBeCloseTo(Math.SQRT1_2)
    expect(gains.b).toBeCloseTo(Math.SQRT1_2)
    expect(gains.a ** 2 + gains.b ** 2).toBeCloseTo(1)
  })
})

describe('djCrossfaderGains', () => {
  it('keeps both decks at unity in the center', () => {
    expect(djCrossfaderGains(0)).toEqual({ a: 1, b: 1 })
  })

  it('only attenuates the deck opposite the selected side', () => {
    expect(djCrossfaderGains(-1)).toEqual({ a: 1, b: 0 })
    expect(djCrossfaderGains(-0.5)).toEqual({ a: 1, b: 0.5 })
    expect(djCrossfaderGains(0.5)).toEqual({ a: 0.5, b: 1 })
    expect(djCrossfaderGains(1)).toEqual({ a: 0, b: 1 })
  })

  it('clamps positions outside the fader range', () => {
    expect(djCrossfaderGains(-3)).toEqual({ a: 1, b: 0 })
    expect(djCrossfaderGains(3)).toEqual({ a: 0, b: 1 })
  })
})

describe('formatTime', () => {
  it('formats elapsed seconds', () => {
    expect(formatTime(65.9)).toBe('01:05')
    expect(formatTime(Number.NaN)).toBe('00:00')
  })
})
