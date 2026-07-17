import type { TrackAnalysis } from '@vibraxis/shared/analysis'
import type { BindingAnalysis } from '@vibraxis/shared/vdap'

/**
 * Fetches the analyze-tool output for a catalog track.
 *
 * The served files are produced and schema-validated by analyze-tool, and every
 * shipped fixture is re-validated against the shared Analysis Schema by
 * `npm run test:contracts`. At runtime we therefore verify the exact fields the
 * timing-critical code consumes (assertUsableAnalysis) instead of shipping a
 * full JSON Schema validator into the browser bundle.
 */
export async function fetchTrackAnalysis(
  trackId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<TrackAnalysis> {
  const response = await fetchImpl(`/api/analysis/${encodeURIComponent(trackId)}`)
  if (!response.ok) {
    throw new Error(`Analysis for ${trackId} is unavailable (${response.status})`)
  }
  const data: unknown = await response.json()
  assertUsableAnalysis(data, trackId)
  return data
}

export function assertUsableAnalysis(
  data: unknown,
  trackId: string,
): asserts data is TrackAnalysis {
  if (typeof data !== 'object' || data === null) {
    throw new Error(`Analysis for ${trackId} is not an object.`)
  }
  const analysis = data as Record<string, Record<string, unknown>>
  const tempo = analysis.tempo
  const tonal = analysis.tonal
  const features = analysis.features
  const capabilities = analysis.capabilities as
    | { beatGrid?: { status?: unknown } }
    | undefined
  const problems: string[] = []
  if (!isPositiveFinite(tempo?.bpm)) problems.push('tempo.bpm')
  if (typeof tempo?.timeSignature !== 'string') problems.push('tempo.timeSignature')
  if (!isFiniteNumberArray(tempo?.beatsSeconds)) problems.push('tempo.beatsSeconds')
  if (!isFiniteNumberArray(tempo?.downbeatsSeconds)) problems.push('tempo.downbeatsSeconds')
  if (!isFiniteNumberArray(tempo?.barsSeconds)) problems.push('tempo.barsSeconds')
  if (typeof tonal?.key !== 'string') problems.push('tonal.key')
  if (tonal?.scale !== 'major' && tonal?.scale !== 'minor') problems.push('tonal.scale')
  if (typeof tonal?.camelot !== 'string') problems.push('tonal.camelot')
  if (!isPositiveFinite(features?.energy) && features?.energy !== 0) problems.push('features.energy')
  if (typeof capabilities?.beatGrid?.status !== 'string') problems.push('capabilities.beatGrid.status')
  if (problems.length > 0) {
    throw new Error(`Analysis for ${trackId} is missing usable fields: ${problems.join(', ')}`)
  }
}

export function toBindingAnalysis(analysis: TrackAnalysis): BindingAnalysis {
  const beats = analysis.tempo.beatsSeconds
  const bars = analysis.tempo.barsSeconds
  const grid = analysis.capabilities.beatGrid
  const gridStatus =
    grid.status === 'complete' || grid.status === 'partial' || grid.status === 'skipped'
      ? grid.status
      : 'failed'
  return {
    analysisRef: `analysis:${analysis.trackId}`,
    schemaVersion: analysis.schemaVersion,
    bpm: analysis.tempo.bpm,
    timeSignature: analysis.tempo.timeSignature,
    beatsPerBar: parseBeatsPerBar(analysis.tempo.timeSignature),
    firstDownbeatSeconds: analysis.tempo.downbeatsSeconds[0] ?? beats[0] ?? 0,
    beatCount: beats.length,
    barCount: bars.length,
    key: analysis.tonal.key,
    scale: analysis.tonal.scale,
    camelot: analysis.tonal.camelot,
    energy: analysis.features.energy,
    grid: {
      available: gridStatus !== 'failed' && beats.length > 0,
      confidence: grid.confidence ?? 0,
      status: gridStatus,
    },
  }
}

export function parseBeatsPerBar(timeSignature: string): number {
  const numerator = Number.parseInt(timeSignature.split('/')[0] ?? '', 10)
  return Number.isInteger(numerator) && numerator >= 1 && numerator <= 12 ? numerator : 4
}

function isPositiveFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function isFiniteNumberArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'number' && Number.isFinite(item))
}
