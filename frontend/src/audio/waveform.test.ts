import { describe, expect, it } from 'vitest'
import { computeWaveformBands, recommendedWaveformBinCount } from './waveform'

const SAMPLE_RATE = 44100

function tone(frequencyHz: number, seconds: number, sampleRate = SAMPLE_RATE): Float32Array {
  const count = Math.floor(seconds * sampleRate)
  const data = new Float32Array(count)
  for (let i = 0; i < count; i += 1) {
    data[i] = Math.sin((2 * Math.PI * frequencyHz * i) / sampleRate)
  }
  return data
}

function dominantBand(bands: { low: Float32Array; mid: Float32Array; high: Float32Array }, bin: number) {
  const entries: Array<['low' | 'mid' | 'high', number]> = [
    ['low', bands.low[bin]],
    ['mid', bands.mid[bin]],
    ['high', bands.high[bin]],
  ]
  return entries.sort((a, b) => b[1] - a[1])[0][0]
}

describe('computeWaveformBands', () => {
  it('routes a sub-bass tone into the LOW band', () => {
    const bands = computeWaveformBands(tone(60, 1), SAMPLE_RATE, 32)
    expect(dominantBand(bands, 16)).toBe('low')
  })

  it('routes a treble tone into the HI band', () => {
    const bands = computeWaveformBands(tone(9000, 1), SAMPLE_RATE, 32)
    expect(dominantBand(bands, 16)).toBe('high')
  })

  it('routes a midrange tone into the MID band', () => {
    const bands = computeWaveformBands(tone(1000, 1), SAMPLE_RATE, 32)
    expect(dominantBand(bands, 16)).toBe('mid')
  })

  it('produces the requested bin count and 0..1 normalization', () => {
    const bands = computeWaveformBands(tone(440, 1), SAMPLE_RATE, 100)
    expect(bands.bins).toBe(100)
    expect(bands.low).toHaveLength(100)
    for (const value of [...bands.low, ...bands.mid, ...bands.high, ...bands.peak]) {
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThanOrEqual(1.0001)
    }
    expect(bands.durationSeconds).toBeCloseTo(1, 1)
  })

  it('degrades gracefully on empty input', () => {
    const bands = computeWaveformBands(new Float32Array(0), SAMPLE_RATE, 64)
    expect(bands.bins).toBe(64)
    expect(bands.durationSeconds).toBe(0)
    expect(bands.peak[0]).toBe(0)
  })

  it('preserves the requested bin count even when it exceeds the sample count', () => {
    const bands = computeWaveformBands(tone(440, 0.0001), SAMPLE_RATE, 1024)
    expect(bands.bins).toBe(1024)
  })

  it('rejects invalid bin and sample-rate inputs instead of substituting values', () => {
    expect(() => computeWaveformBands(new Float32Array(1), SAMPLE_RATE, 0))
      .toThrow('Waveform binCount must be a positive integer.')
    expect(() => computeWaveformBands(new Float32Array(1), 0, 1))
      .toThrow('Waveform sample rate must be positive.')
  })
})

describe('recommendedWaveformBinCount', () => {
  it('keeps source-time resolution for long tracks instead of a fixed overview size', () => {
    expect(recommendedWaveformBinCount(60)).toBe(4_800)
    expect(recommendedWaveformBinCount(600)).toBe(48_000)
  })

  it('bounds tiny and exceptionally long inputs', () => {
    expect(recommendedWaveformBinCount(1)).toBe(4_096)
    expect(recommendedWaveformBinCount(10_000)).toBe(120_000)
  })

  it('rejects an invalid duration instead of substituting zero', () => {
    expect(() => recommendedWaveformBinCount(Number.NaN))
      .toThrow('Waveform duration must be a non-negative finite number.')
  })
})
