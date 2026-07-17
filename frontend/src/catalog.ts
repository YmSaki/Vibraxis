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
  sectionSummary: SectionSummary[]
  performancePads: PerformancePad[]
  degreeFingerprint: string[]
  license: string
  licenseStatus: 'verified' | 'unverified'
}

type CatalogResponse = {
  catalogVersion: number
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
  if (!Array.isArray(data.tracks)) throw new Error('楽曲カタログの形式が不正です。')
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
