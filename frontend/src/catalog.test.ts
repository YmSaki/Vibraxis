import { describe, expect, it } from 'vitest'
import { fetchCatalog, trackAudioUrl, type CatalogTrack } from './catalog'

const track: CatalogTrack = {
  trackId: 'hello-world',
  title: 'Hello',
  artist: 'World',
  file: 'hello world.mp3',
  genre: 'Test',
  mood: [],
  bpm: 120,
  key: 'C',
  scale: 'major',
  camelot: '8B',
  energy: 0.5,
  sectionSummary: [],
  performancePads: [],
  degreeFingerprint: [],
  license: 'test',
  licenseStatus: 'verified',
}

describe('catalog client', () => {
  it('encodes track filenames for the local audio route', () => {
    expect(trackAudioUrl(track)).toBe('/tracks/hello%20world.mp3')
  })

  it('loads the track list from the catalog endpoint', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = async () => new Response(JSON.stringify({ catalogVersion: 1, tracks: [track] }))
    try {
      await expect(fetchCatalog()).resolves.toEqual([track])
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
