export type SectionSummary = {
  label: string
  startSeconds: number
  endSeconds: number
  startBeat: number
  endBeat: number
  startBar: number
  endBar: number
}

export type PerformancePad = {
  slot: number
  type: 'hotCue'
  label: string
  timeSeconds: number
  beatIndex: number
  barIndex: number
  beatInBar: number
  source: 'auto' | 'user'
  locked: boolean
}

export type CatalogTrack = {
  trackId: string
  title: string
  artist: string
  file: string
  genre: string
  mood: string[]
  bpm: number
  key: string
  scale: 'major' | 'minor'
  camelot: string
  energy: number
  sectionSummary: SectionSummary[]
  performancePads: PerformancePad[]
  degreeFingerprint: string[]
  license: string
  licenseStatus: 'verified' | 'unverified'
}

type CatalogResponse = {
  catalogVersion: number
  tracks: CatalogTrack[]
}

export async function fetchCatalog(signal?: AbortSignal): Promise<CatalogTrack[]> {
  const response = await fetch('/api/catalog', { signal })
  if (!response.ok) throw new Error(`楽曲カタログを取得できませんでした (${response.status})`)
  const data = await response.json() as CatalogResponse
  if (!Array.isArray(data.tracks)) throw new Error('楽曲カタログの形式が不正です。')
  return data.tracks
}

export function trackAudioUrl(track: CatalogTrack): string {
  return `/tracks/${encodeURIComponent(track.file)}`
}
