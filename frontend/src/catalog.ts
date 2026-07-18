import type { AnalysisSection, TrackAnalysis } from '@vibraxis/shared/analysis'
import type { PerformancePad } from '@vibraxis/shared/vdap'

export type SectionSummary = Pick<
  AnalysisSection,
  | 'label'
  | 'startSeconds'
  | 'endSeconds'
  | 'startBeat'
  | 'endBeat'
  | 'startBar'
  | 'endBar'
>

/** Per-analysis-stage availability the catalog reports for a track. */
export type TrackCapabilityStatus =
  | 'complete'
  | 'partial'
  | 'failed'
  | 'skipped'
  | 'unavailable'

/**
 * Truthful, catalog-sourced availability of each analysis stage. Present in the
 * generated catalog; optional here so a minimal catalog entry (or a test
 * fixture) without it stays valid. The Agent context builder reads these rather
 * than inventing beat-grid / section availability (AGENTS.md §0.6).
 */
export type TrackCapabilities = {
  features: TrackCapabilityStatus
  beatGrid: TrackCapabilityStatus
  harmony: TrackCapabilityStatus
  structure: TrackCapabilityStatus
}

export type CatalogTrack = {
  trackId: string
  title: string
  artist: string
  file: string
  genre: string
  mood: string[]
  bpm: TrackAnalysis['tempo']['bpm']
  key: TrackAnalysis['tonal']['key']
  scale: TrackAnalysis['tonal']['scale']
  camelot: TrackAnalysis['tonal']['camelot']
  energy: TrackAnalysis['features']['energy']
  /** Number of concrete beat positions emitted by analysis (not a status proxy). */
  beatCount: number
  sectionSummary: SectionSummary[]
  performancePads: PerformancePad[]
  degreeFingerprint: string[]
  license: string
  licenseStatus: 'verified' | 'unverified'
  capabilities?: TrackCapabilities
}

type CatalogResponse = {
  catalogVersion: 2
  tracks: CatalogTrackWire[]
}

type CatalogPadWire = Omit<PerformancePad, 'sourceSeconds'> & {
  timeSeconds: number
}

type CatalogTrackWire = Omit<CatalogTrack, 'performancePads'> & {
  performancePads: CatalogPadWire[]
}

export async function fetchCatalog(signal?: AbortSignal): Promise<CatalogTrack[]> {
  const response = await fetch('/api/catalog', { signal })
  if (!response.ok) throw new Error(`楽曲カタログを取得できませんでした (${response.status})`)
  const data = await response.json() as CatalogResponse
  if (data.catalogVersion !== 2 || !Array.isArray(data.tracks)) {
    throw new Error('楽曲カタログの形式またはversionが不正です。')
  }
  for (const track of data.tracks) {
    if (
      typeof track !== 'object' || track === null
      || !Number.isInteger(track.beatCount) || track.beatCount < 0
      || !Array.isArray(track.sectionSummary)
      || !Array.isArray(track.performancePads)
    ) {
      throw new Error('楽曲カタログの解析可用性データが不正です。')
    }
  }
  return data.tracks.map((track) => ({
    ...track,
    performancePads: track.performancePads.map(({ timeSeconds, ...pad }) => ({
      ...pad,
      sourceSeconds: timeSeconds,
    })),
  }))
}

export function trackAudioUrl(track: CatalogTrack): string {
  return `/tracks/${encodeURIComponent(track.file)}`
}
