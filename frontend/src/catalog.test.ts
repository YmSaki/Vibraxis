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
  beatCount: 0,
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
    globalThis.fetch = async () => new Response(JSON.stringify({ catalogVersion: 2, tracks: [track] }))
    try {
      await expect(fetchCatalog()).resolves.toEqual([track])
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('rejects a catalog whose required beatCount is missing', async () => {
    const originalFetch = globalThis.fetch
    const { beatCount: _beatCount, ...withoutBeatCount } = track
    globalThis.fetch = async () => new Response(JSON.stringify({ catalogVersion: 2, tracks: [withoutBeatCount] }))
    try {
      await expect(fetchCatalog()).rejects.toThrow('解析可用性データが不正')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('normalizes catalog pad timeSeconds into the shared sourceSeconds field', async () => {
    const originalFetch = globalThis.fetch
    const wireTrack = {
      ...track,
      performancePads: [{
        slot: 1,
        type: 'hotCue',
        label: 'INTRO',
        timeSeconds: 1.25,
        beatIndex: 0,
        barIndex: 0,
        beatInBar: 1,
        source: 'auto',
        locked: false,
      }],
    }
    globalThis.fetch = async () => new Response(JSON.stringify({ catalogVersion: 2, tracks: [wireTrack] }))
    try {
      const [loaded] = await fetchCatalog()
      expect(loaded.performancePads[0].sourceSeconds).toBe(1.25)
      expect(loaded.performancePads[0]).not.toHaveProperty('timeSeconds')
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
