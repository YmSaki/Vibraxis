export const MIN_PLAYBACK_RATE = 0.5
export const MAX_PLAYBACK_RATE = 1.5
export type TempoMultiplier = 0.5 | 1 | 2

export function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

export type TempoSyncResult = {
  playbackRate: number
  requestedRate: number
  targetBpm: number
  exact: boolean
}

export function interpretedBpm(bpm: number, multiplier: TempoMultiplier): number {
  if (!Number.isFinite(bpm) || bpm <= 0) throw new RangeError('BPM must be positive.')
  return bpm * multiplier
}

export function calculateTempoSync(
  masterBpm: number,
  masterPlaybackRate: number,
  followerBpm: number,
): TempoSyncResult {
  if (![masterBpm, masterPlaybackRate, followerBpm].every((value) => Number.isFinite(value) && value > 0)) {
    throw new RangeError('Tempo sync requires positive BPM and playback-rate values.')
  }

  const targetBpm = masterBpm * masterPlaybackRate
  const requestedRate = targetBpm / followerBpm
  const playbackRate = clamp(requestedRate, MIN_PLAYBACK_RATE, MAX_PLAYBACK_RATE)

  return {
    playbackRate,
    requestedRate,
    targetBpm,
    exact: Math.abs(playbackRate - requestedRate) < Number.EPSILON,
  }
}

export function equalPowerGains(position: number): { a: number; b: number } {
  const normalized = (clamp(position, -1, 1) + 1) / 2
  return {
    a: Math.cos(normalized * Math.PI * 0.5),
    b: Math.sin(normalized * Math.PI * 0.5),
  }
}

/**
 * Manual DJ crossfader curve. The deck on the selected side remains at unity
 * through the center while only the opposite deck is attenuated. Unlike an
 * equal-power crossfade, moving a solo deck from center to its edge therefore
 * does not add 3 dB.
 */
export function djCrossfaderGains(position: number): { a: number; b: number } {
  const clamped = clamp(position, -1, 1)
  return {
    a: clamped <= 0 ? 1 : 1 - clamped,
    b: clamped >= 0 ? 1 : 1 + clamped,
  }
}

export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '00:00'
  const whole = Math.floor(seconds)
  const minutes = Math.floor(whole / 60)
  return `${String(minutes).padStart(2, '0')}:${String(whole % 60).padStart(2, '0')}`
}
