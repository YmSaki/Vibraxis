/**
 * Three-band waveform generation.
 *
 * Splits a decoded track into LOW / MID / HI energy bins for the full-song
 * waveform view. The output is compact derived visualization data (a few
 * thousand floats per band) that lives entirely on the UI side — it is built
 * once per track/load, cached, and never copied into the VDAP runtime snapshot.
 *
 * The band split uses two one-pole filters:
 *   low  = lowpass(≈250 Hz)
 *   high = signal − lowpass(≈4 kHz)
 *   mid  = lowpass(4 kHz) − lowpass(250 Hz)
 * so LOW + MID + HI reconstruct the signal. Each bin stores the per-band RMS
 * plus the full-band peak used for the column envelope.
 */

export type WaveformBands = {
  bins: number
  durationSeconds: number
  /** Per-bin RMS for each band, normalized to 0..1 against the loudest band bin. */
  low: Float32Array
  mid: Float32Array
  high: Float32Array
  /** Per-bin full-band peak envelope, normalized to 0..1. */
  peak: Float32Array
}

/**
 * Keep enough source-time detail for a zoomed DJ waveform. 80 bins/second is
 * finer than a display pixel at the closest supported zoom, while the cap
 * keeps exceptionally long recordings from growing without bound.
 */
export function recommendedWaveformBinCount(durationSeconds: number): number {
  if (!Number.isFinite(durationSeconds) || durationSeconds < 0) {
    throw new RangeError('Waveform duration must be a non-negative finite number.')
  }
  return Math.min(120_000, Math.max(4_096, Math.ceil(durationSeconds * 80)))
}

const LOW_CROSSOVER_HZ = 250
const HIGH_CROSSOVER_HZ = 4000

/** One-pole smoothing coefficient for a given cutoff at a sample rate. */
function onePoleCoefficient(cutoffHz: number, sampleRate: number): number {
  if (sampleRate <= 0) return 1
  const x = Math.exp((-2 * Math.PI * cutoffHz) / sampleRate)
  return 1 - x
}

/**
 * Computes normalized 3-band bins from a mono signal. Pure and synchronous so it
 * is deterministically testable; the async builder below feeds it chunk state
 * for long tracks. The requested `binCount` is preserved exactly.
 */
export function computeWaveformBands(
  mono: Float32Array,
  sampleRate: number,
  binCount: number,
): WaveformBands {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new RangeError('Waveform sample rate must be positive.')
  }
  if (!Number.isSafeInteger(binCount) || binCount < 1) {
    throw new RangeError('Waveform binCount must be a positive integer.')
  }
  const samples = mono.length
  const bins = binCount
  const low = new Float32Array(bins)
  const mid = new Float32Array(bins)
  const high = new Float32Array(bins)
  const peak = new Float32Array(bins)

  const lowCoeff = onePoleCoefficient(LOW_CROSSOVER_HZ, sampleRate)
  const highCoeff = onePoleCoefficient(HIGH_CROSSOVER_HZ, sampleRate)

  const lowSum = new Float64Array(bins)
  const midSum = new Float64Array(bins)
  const highSum = new Float64Array(bins)
  const counts = new Float64Array(bins)

  let lpLow = 0
  let lpHigh = 0
  for (let i = 0; i < samples; i += 1) {
    const x = mono[i]
    lpLow += lowCoeff * (x - lpLow)
    lpHigh += highCoeff * (x - lpHigh)
    const lowBand = lpLow
    const midBand = lpHigh - lpLow
    const highBand = x - lpHigh

    // Map by fraction of the whole track so the last bin is always inclusive.
    const bin = Math.min(bins - 1, Math.floor((i / samples) * bins))
    lowSum[bin] += lowBand * lowBand
    midSum[bin] += midBand * midBand
    highSum[bin] += highBand * highBand
    counts[bin] += 1
    const magnitude = Math.abs(x)
    if (magnitude > peak[bin]) peak[bin] = magnitude
  }

  let maxBand = 0
  let maxPeak = 0
  for (let b = 0; b < bins; b += 1) {
    const count = counts[b] || 1
    const l = Math.sqrt(lowSum[b] / count)
    const m = Math.sqrt(midSum[b] / count)
    const h = Math.sqrt(highSum[b] / count)
    low[b] = l
    mid[b] = m
    high[b] = h
    if (l > maxBand) maxBand = l
    if (m > maxBand) maxBand = m
    if (h > maxBand) maxBand = h
    if (peak[b] > maxPeak) maxPeak = peak[b]
  }

  const bandScale = maxBand > 0 ? 1 / maxBand : 0
  const peakScale = maxPeak > 0 ? 1 / maxPeak : 0
  for (let b = 0; b < bins; b += 1) {
    low[b] *= bandScale
    mid[b] *= bandScale
    high[b] *= bandScale
    peak[b] *= peakScale
  }

  return {
    bins,
    durationSeconds: sampleRate > 0 ? samples / sampleRate : 0,
    low,
    mid,
    high,
    peak,
  }
}

/** Cooperative yield so a long build never blocks a single animation frame. */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/**
 * Builds a 3-band overview from a decoded buffer without blocking the UI for
 * long tracks: channels are averaged into a mono buffer in chunks that yield to
 * the event loop between passes. Returns compact normalized bins ready to draw.
 */
export async function buildWaveform(
  buffer: AudioBuffer,
  binCount = recommendedWaveformBinCount(buffer.duration),
  chunkSamples = 1 << 20,
): Promise<WaveformBands> {
  const length = buffer.length
  if (!Number.isSafeInteger(chunkSamples) || chunkSamples < 1) {
    throw new RangeError('Waveform chunkSamples must be a positive integer.')
  }
  if (!Number.isSafeInteger(buffer.numberOfChannels) || buffer.numberOfChannels < 1) {
    throw new RangeError('AudioBuffer must contain at least one channel.')
  }
  const channelCount = buffer.numberOfChannels
  const mono = new Float32Array(length)
  const channels: Float32Array[] = []
  for (let c = 0; c < channelCount; c += 1) channels.push(buffer.getChannelData(c))

  for (let start = 0; start < length; start += chunkSamples) {
    const end = Math.min(length, start + chunkSamples)
    for (let c = 0; c < channelCount; c += 1) {
      const data = channels[c]
      for (let i = start; i < end; i += 1) mono[i] += data[i]
    }
    if (channelCount > 1) {
      for (let i = start; i < end; i += 1) mono[i] /= channelCount
    }
    if (end < length) await yieldToEventLoop()
  }

  return computeWaveformBands(mono, buffer.sampleRate, binCount)
}
