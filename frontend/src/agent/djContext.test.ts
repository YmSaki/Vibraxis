import { describe, expect, it } from 'vitest'
import { buildDjContext as assembleDjContext, catalogTrackToSummary, SUPPORTED_CROSSFADE_BARS } from './djContext'
import { catalogTrack, runtimeState } from './fixtures'

const velocity = { min: 0.5, max: 1.5 }
const history: string[] = []

function buildDjContext(
  input: Omit<Parameters<typeof assembleDjContext>[0], 'recentlyPlayedTrackIds'>,
) {
  return assembleDjContext({ ...input, recentlyPlayedTrackIds: history })
}

describe('catalogTrackToSummary', () => {
  it('derives beat-grid / section-cue availability only from catalog data', () => {
    const withGrid = catalogTrackToSummary(
      catalogTrack({
        trackId: 't1',
        beatCount: 100,
        sectionSummary: [{ label: 'intro', startSeconds: 0, endSeconds: 8, startBeat: 0, endBeat: 16, startBar: 0, endBar: 4 }],
        performancePads: [{ slot: 1, type: 'hotCue', label: 'x', sourceSeconds: 1, source: 'auto', locked: false }],
      }),
    )
    expect(withGrid.hasBeatGrid).toBe(true)
    expect(withGrid.hasSectionCues).toBe(true)

    const noSignals = catalogTrackToSummary(
      catalogTrack({ trackId: 't2', beatCount: 0, performancePads: [], capabilities: { features: 'complete', beatGrid: 'failed', harmony: 'skipped', structure: 'skipped' } }),
    )
    expect(noSignals.hasBeatGrid).toBe(false)
    expect(noSignals.hasSectionCues).toBe(false)
  })

  it('does not reinterpret a FIRST BEAT performance pad as a semantic section cue', () => {
    const summary = catalogTrackToSummary(catalogTrack({
      trackId: 'first-beat-only',
      sectionSummary: [],
      beatCount: 0,
      performancePads: [{ slot: 1, type: 'hotCue', label: 'FIRST BEAT', sourceSeconds: 1, source: 'auto', locked: false }],
      capabilities: { features: 'complete', beatGrid: 'partial', harmony: 'failed', structure: 'failed' },
    }))
    expect(summary.hasBeatGrid).toBe(false)
    expect(summary.hasSectionCues).toBe(false)
  })

  it('does not claim a grid or section from partial status without concrete output', () => {
    const summary = catalogTrackToSummary(catalogTrack({
      trackId: 'status-only',
      beatCount: 0,
      sectionSummary: [],
      capabilities: { features: 'complete', beatGrid: 'partial', harmony: 'partial', structure: 'partial' },
    }))
    expect(summary.hasBeatGrid).toBe(false)
    expect(summary.hasSectionCues).toBe(false)
  })

  it('does not invent availability when capabilities are absent', () => {
    const summary = catalogTrackToSummary(catalogTrack({ trackId: 't3', beatCount: 0, capabilities: undefined, performancePads: [] }))
    expect(summary.hasBeatGrid).toBe(false)
    expect(summary.hasSectionCues).toBe(false)
  })
})

describe('buildDjContext', () => {
  const tracks = [
    catalogTrack({ trackId: 'cur', bpm: 120, camelot: '8B', energy: 0.6 }),
    catalogTrack({ trackId: 'next-a', bpm: 122 }),
    catalogTrack({ trackId: 'next-b', bpm: 118 }),
  ]

  it('reports runtimeNotReady before state loads', () => {
    const result = buildDjContext({ runtimeState: null, tracks, velocity })
    expect(result).toMatchObject({ ok: false, reason: { code: 'runtimeNotReady' } })
  })

  it('reports velocityLimitsUnavailable when limits are unknown', () => {
    const rs = runtimeState({ playing: true, trackId: 'cur' }, {})
    const result = buildDjContext({ runtimeState: rs, tracks, velocity: null })
    expect(result).toMatchObject({ ok: false, reason: { code: 'velocityLimitsUnavailable' } })
  })

  it('reports playHistoryUnavailable instead of replacing unknown with an empty list', () => {
    const rs = runtimeState({ playing: true, trackId: 'cur' }, {})
    const result = assembleDjContext({ runtimeState: rs, tracks, velocity, recentlyPlayedTrackIds: null })
    expect(result).toMatchObject({ ok: false, reason: { code: 'playHistoryUnavailable' } })
  })

  it('reports noActiveDeck when nothing is playing', () => {
    const rs = runtimeState({ trackId: 'cur' }, { trackId: 'next-a' })
    const result = buildDjContext({ runtimeState: rs, tracks, velocity })
    expect(result).toMatchObject({ ok: false, reason: { code: 'noActiveDeck' } })
  })

  it('reports ambiguousActiveDeck when both decks play', () => {
    const rs = runtimeState({ playing: true, trackId: 'cur' }, { playing: true, trackId: 'next-a' })
    const result = buildDjContext({ runtimeState: rs, tracks, velocity })
    expect(result).toMatchObject({ ok: false, reason: { code: 'ambiguousActiveDeck' } })
  })

  it('reports activeDeckNotInCatalog for a non-catalog binding', () => {
    const rs = runtimeState({ playing: true, trackId: 'file-load' }, {})
    const result = buildDjContext({ runtimeState: rs, tracks, velocity })
    expect(result).toMatchObject({ ok: false, reason: { code: 'activeDeckNotInCatalog' } })
  })

  it('reports noCandidateTracks when only the current track exists', () => {
    const rs = runtimeState({ playing: true, trackId: 'cur' }, {})
    const result = buildDjContext({ runtimeState: rs, tracks: [tracks[0]], velocity })
    expect(result).toMatchObject({ ok: false, reason: { code: 'noCandidateTracks' } })
  })

  it('assembles a truthful context from the single playing deck', () => {
    const rs = runtimeState({ playing: true, trackId: 'cur' }, { trackId: 'next-a' })
    const result = buildDjContext({ runtimeState: rs, tracks, velocity })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.activeDeckId).toBe('A')
    expect(result.inactiveDeckId).toBe('B')
    expect(result.context.currentTrack.trackId).toBe('cur')
    expect(result.context.candidates.map((c) => c.trackId)).toEqual(['next-a', 'next-b'])
    expect(result.context.recentlyPlayedTrackIds).toEqual([])
    expect(result.context.limits).toEqual({
      minPlaybackRate: 0.5,
      maxPlaybackRate: 1.5,
      allowedCrossfadeBars: [...SUPPORTED_CROSSFADE_BARS],
    })
  })

  it('passes the actual session history without rewriting it', () => {
    const rs = runtimeState({ playing: true, trackId: 'cur' }, {})
    const result = assembleDjContext({
      runtimeState: rs,
      tracks,
      velocity,
      recentlyPlayedTrackIds: ['next-a', 'cur'],
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.context.recentlyPlayedTrackIds).toEqual(['next-a', 'cur'])
  })

  it('treats deck B as active when B is the one playing', () => {
    const rs = runtimeState({ trackId: 'next-a' }, { playing: true, trackId: 'cur' })
    const result = buildDjContext({ runtimeState: rs, tracks, velocity })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.activeDeckId).toBe('B')
    expect(result.inactiveDeckId).toBe('A')
  })

  it('uses the active deck effective runtime tempo for currentTrack.bpm, not the catalog value', () => {
    // Catalog cur bpm is 120 but the deck is running faster (effective 132).
    const rs = runtimeState({ playing: true, trackId: 'cur', effectiveBpm: 132 }, { trackId: 'next-a' })
    const result = buildDjContext({ runtimeState: rs, tracks, velocity })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.context.currentTrack.bpm).toBe(132)
    // Candidates keep their catalog BPM.
    expect(result.context.candidates.find((c) => c.trackId === 'next-a')?.bpm).toBe(122)
  })

  it('rejects (effectiveTempoUnavailable) when the effective tempo is null', () => {
    const rs = runtimeState({ playing: true, trackId: 'cur', effectiveBpm: null }, { trackId: 'next-a' })
    const result = buildDjContext({ runtimeState: rs, tracks, velocity })
    expect(result).toMatchObject({ ok: false, reason: { code: 'effectiveTempoUnavailable' } })
  })

  it('rejects (effectiveTempoUnavailable) when the effective tempo is not positive-finite', () => {
    for (const bpm of [0, -10, Number.NaN, Number.POSITIVE_INFINITY]) {
      const rs = runtimeState({ playing: true, trackId: 'cur', effectiveBpm: bpm }, { trackId: 'next-a' })
      const result = buildDjContext({ runtimeState: rs, tracks, velocity })
      expect(result).toMatchObject({ ok: false, reason: { code: 'effectiveTempoUnavailable' } })
    }
  })
})
