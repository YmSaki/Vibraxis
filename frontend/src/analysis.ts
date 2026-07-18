import type { TrackAnalysis } from '@vibraxis/shared/analysis'
import type { BindingAnalysis, DeckGridChord } from '@vibraxis/shared/vdap'
import type { DeckGridPayload } from './runtime/RuntimeAudioPort'

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
  const harmony = analysis.harmony
  const structure = analysis.structure
  const capabilities = analysis.capabilities as
    | { beatGrid?: { status?: unknown } }
    | undefined
  const problems: string[] = []
  if (!isPositiveFinite(tempo?.bpm)) problems.push('tempo.bpm')
  if (typeof tempo?.timeSignature !== 'string' || !isUsableTimeSignature(tempo.timeSignature)) {
    problems.push('tempo.timeSignature')
  }
  if (!isAscendingNonNegativeNumberArray(tempo?.beatsSeconds)) problems.push('tempo.beatsSeconds')
  if (!isAscendingNonNegativeNumberArray(tempo?.downbeatsSeconds)) problems.push('tempo.downbeatsSeconds')
  if (!isAscendingNonNegativeNumberArray(tempo?.barsSeconds)) problems.push('tempo.barsSeconds')
  if (typeof tonal?.key !== 'string') problems.push('tonal.key')
  if (tonal?.scale !== 'major' && tonal?.scale !== 'minor') problems.push('tonal.scale')
  if (typeof tonal?.camelot !== 'string') problems.push('tonal.camelot')
  if (!isPositiveFinite(features?.energy) && features?.energy !== 0) problems.push('features.energy')
  if (!['complete', 'partial', 'failed', 'skipped'].includes(String(capabilities?.beatGrid?.status))) {
    problems.push('capabilities.beatGrid.status')
  }
  if (!isNullableConfidence((capabilities?.beatGrid as { confidence?: unknown } | undefined)?.confidence)) {
    problems.push('capabilities.beatGrid.confidence')
  }
  if (!Array.isArray(harmony?.chords) || !harmony.chords.every(isUsableChord)) {
    problems.push('harmony.chords')
  }
  if (!Array.isArray(structure?.sections) || !structure.sections.every(isUsableSection)) {
    problems.push('structure.sections')
  }
  if (!Array.isArray(structure?.phrases) || !structure.phrases.every(isUsablePhrase)) {
    problems.push('structure.phrases')
  }
  if (problems.length > 0) {
    throw new Error(`Analysis for ${trackId} is missing usable fields: ${problems.join(', ')}`)
  }
}

export function toBindingAnalysis(analysis: TrackAnalysis): BindingAnalysis {
  const beats = analysis.tempo.beatsSeconds
  const bars = analysis.tempo.barsSeconds
  const grid = analysis.capabilities.beatGrid
  const gridStatus = grid.status
  return {
    analysisRef: `analysis:${analysis.trackId}`,
    schemaVersion: analysis.schemaVersion,
    bpm: analysis.tempo.bpm,
    timeSignature: analysis.tempo.timeSignature,
    beatsPerBar: parseBeatsPerBar(analysis.tempo.timeSignature),
    firstDownbeatSeconds: analysis.tempo.downbeatsSeconds[0] ?? null,
    beatCount: beats.length,
    barCount: bars.length,
    key: analysis.tonal.key,
    scale: analysis.tonal.scale,
    camelot: analysis.tonal.camelot,
    energy: analysis.features.energy,
    grid: {
      available: gridStatus !== 'failed' && beats.length > 0,
      confidence: grid.confidence,
      status: gridStatus,
    },
  }
}

/**
 * Projects the full analysis grid into the {@link DeckGridPayload} returned by
 * `deck.getGrid`. Beat/downbeat/bar arrays and structure come straight from the
 * shared Analysis Schema; chords are an optional superset kept only when the
 * harmony track carries them. No timing values are invented here.
 */
export function toDeckGridPayload(analysis: TrackAnalysis): DeckGridPayload {
  const chords: DeckGridChord[] = analysis.harmony.chords.map((chord) => ({
    startSeconds: chord.startSeconds,
    endSeconds: chord.endSeconds,
    symbol: chord.symbol,
    degree: chord.degree,
    confidence: chord.confidence,
  }))
  return {
    timeSignature: analysis.tempo.timeSignature,
    beatsPerBar: parseBeatsPerBar(analysis.tempo.timeSignature),
    bpm: analysis.tempo.bpm,
    confidence: analysis.capabilities.beatGrid.confidence,
    beatsSeconds: [...analysis.tempo.beatsSeconds],
    downbeatsSeconds: [...analysis.tempo.downbeatsSeconds],
    barsSeconds: [...analysis.tempo.barsSeconds],
    // Structure records are schema-validated plain JSON; the cast only widens
    // the analysis interfaces to the DeckGrid JsonValue array shape.
    sections: analysis.structure.sections.map((section) => ({
      startSeconds: section.startSeconds,
      endSeconds: section.endSeconds,
      startBeat: section.startBeat,
      endBeat: section.endBeat,
      startBar: section.startBar,
      endBar: section.endBar,
      label: section.label,
      rawLabel: section.rawLabel,
      confidence: section.confidence,
      energy: section.energy,
    })),
    phrases: analysis.structure.phrases.map((phrase) => ({
      startSeconds: phrase.startSeconds,
      endSeconds: phrase.endSeconds,
      startBar: phrase.startBar,
      endBar: phrase.endBar,
      sectionIndex: phrase.sectionIndex,
    })),
    ...(chords.length > 0 ? { chords } : {}),
  }
}

export function parseBeatsPerBar(timeSignature: string): number {
  const numerator = Number.parseInt(timeSignature.split('/')[0] ?? '', 10)
  if (!isUsableTimeSignature(timeSignature)) {
    throw new RangeError('timeSignature must contain positive integer numerator and denominator.')
  }
  return numerator
}

function isPositiveFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function isAscendingNonNegativeNumberArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((item, index) =>
    typeof item === 'number'
    && Number.isFinite(item)
    && item >= 0
    && (index === 0 || item >= value[index - 1]))
}

function isNullableConfidence(value: unknown): value is number | null {
  return value === null
    || (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1)
}

function isUsableTimeSignature(value: string): boolean {
  if (!/^[1-9][0-9]*\/[1-9][0-9]*$/.test(value)) return false
  const [numerator, denominator] = value.split('/').map(Number)
  return Number.isSafeInteger(numerator) && Number.isSafeInteger(denominator)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasFiniteFields(value: Record<string, unknown>, fields: readonly string[]): boolean {
  return fields.every((field) => typeof value[field] === 'number' && Number.isFinite(value[field]))
}

function isUsableChord(value: unknown): boolean {
  return isRecord(value)
    && hasFiniteFields(value, ['startSeconds', 'endSeconds', 'confidence'])
    && (value.startSeconds as number) >= 0
    && (value.endSeconds as number) > (value.startSeconds as number)
    && (value.confidence as number) >= 0
    && (value.confidence as number) <= 1
    && typeof value.symbol === 'string' && value.symbol.length > 0
    && typeof value.degree === 'string' && value.degree.length > 0
}

function isUsableSection(value: unknown): boolean {
  const sectionLabels = new Set([
    'intro', 'verse', 'preChorus', 'chorus', 'build', 'drop', 'breakdown',
    'bridge', 'instrumental', 'outro', 'other',
  ])
  return isRecord(value)
    && hasFiniteFields(value, [
      'startSeconds', 'endSeconds', 'startBeat', 'endBeat', 'startBar', 'endBar',
      'confidence', 'energy',
    ])
    && (value.startSeconds as number) >= 0
    && (value.endSeconds as number) > (value.startSeconds as number)
    && ['startBeat', 'endBeat', 'startBar', 'endBar'].every(
      (field) => Number.isInteger(value[field]) && (value[field] as number) >= 0,
    )
    && (value.confidence as number) >= 0 && (value.confidence as number) <= 1
    && (value.energy as number) >= 0 && (value.energy as number) <= 1
    && typeof value.label === 'string' && sectionLabels.has(value.label)
    && typeof value.rawLabel === 'string'
}

function isUsablePhrase(value: unknown): boolean {
  return isRecord(value)
    && hasFiniteFields(value, ['startSeconds', 'endSeconds', 'startBar', 'endBar', 'sectionIndex'])
    && (value.startSeconds as number) >= 0
    && (value.endSeconds as number) > (value.startSeconds as number)
    && ['startBar', 'endBar', 'sectionIndex'].every(
      (field) => Number.isInteger(value[field]) && (value[field] as number) >= 0,
    )
}
