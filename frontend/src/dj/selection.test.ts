import { describe, expect, it } from 'vitest'
import {
  DEFAULT_DJ_POLICY,
  classifyCamelot,
  parseCamelot,
  selectCrossfadeBars,
  selectNextTrack,
  type DjContext,
  type DjIntent,
  type DjDecision,
  type DjScoringPolicy,
  type DjSelectionResult,
  type DjTrackSummary,
} from '@vibraxis/shared/dj'

/* ------------------------------------------------------------------ *
 * Factories — every test overrides only the fields it exercises.
 * ------------------------------------------------------------------ */

function track(overrides: Partial<DjTrackSummary> & { trackId: string }): DjTrackSummary {
  return {
    title: overrides.trackId,
    artist: 'artist',
    genre: 'house',
    mood: ['uplifting'],
    bpm: 128,
    camelot: '8A',
    energy: 0.5,
    hasBeatGrid: true,
    hasSectionCues: true,
    ...overrides,
  }
}

function intent(overrides: Partial<DjIntent> = {}): DjIntent {
  return {
    energyDirection: 'maintain',
    targetEnergy: null,
    preferredGenres: [],
    avoidedGenres: [],
    preferredMoods: [],
    avoidedMoods: [],
    tempoDirection: 'any',
    harmonicPriority: 'ignore',
    transitionUrgency: 'normal',
    requestedTrackId: null,
    excludedTrackIds: [],
    rationale: 'test',
    confidence: 0.9,
    ...overrides,
  }
}

function context(overrides: Partial<DjContext> = {}): DjContext {
  return {
    activeDeckId: 'A',
    inactiveDeckId: 'B',
    currentTrack: track({ trackId: 'current', bpm: 128, camelot: '8A', energy: 0.5 }),
    candidates: [],
    recentlyPlayedTrackIds: [],
    limits: {
      minPlaybackRate: 0.9,
      maxPlaybackRate: 1.1,
      allowedCrossfadeBars: [2, 4, 8, 16],
    },
    ...overrides,
  }
}

function selected(result: DjSelectionResult): DjDecision {
  if (result.status !== 'selected') {
    throw new Error(`expected selected, got noCandidate: ${JSON.stringify(result.reasons)}`)
  }
  return result.decision
}

function exclusionCodes(result: DjSelectionResult, trackId: string): string[] {
  const entry = result.ranking.find((r) => r.trackId === trackId)
  if (!entry) throw new Error(`no ranking entry for ${trackId}`)
  return entry.exclusions.map((e) => e.code)
}

/* ------------------------------------------------------------------ *
 * Pure helpers
 * ------------------------------------------------------------------ */

describe('parseCamelot / classifyCamelot', () => {
  it('parses valid codes and rejects malformed ones', () => {
    expect(parseCamelot('8A')).toEqual({ number: 8, letter: 'A' })
    expect(parseCamelot('12B')).toEqual({ number: 12, letter: 'B' })
    expect(parseCamelot('0A')).toBeNull()
    expect(parseCamelot('13A')).toBeNull()
    expect(parseCamelot('8C')).toBeNull()
    expect(parseCamelot('8a')).toBeNull()
    expect(parseCamelot('')).toBeNull()
  })

  it('classifies harmonic relations including 12<->1 wrap', () => {
    expect(classifyCamelot('8A', '8A')).toBe('exact')
    expect(classifyCamelot('8A', '8B')).toBe('relative')
    expect(classifyCamelot('8A', '9A')).toBe('adjacent')
    expect(classifyCamelot('8A', '7A')).toBe('adjacent')
    expect(classifyCamelot('12B', '1B')).toBe('adjacent')
    expect(classifyCamelot('1A', '12A')).toBe('adjacent')
    expect(classifyCamelot('8A', '2B')).toBe('incompatible')
    expect(classifyCamelot('8A', 'nope')).toBe('unknown')
  })
})

describe('selectCrossfadeBars', () => {
  it('picks the nearest allowed value and breaks ties toward smaller', () => {
    expect(selectCrossfadeBars([2, 4, 8, 16], 8)).toBe(8)
    expect(selectCrossfadeBars([3, 10], 8)).toBe(10)
    expect(selectCrossfadeBars([6, 10], 8)).toBe(6) // tie -> smaller
    expect(selectCrossfadeBars([], 8)).toBeNull()
  })

  it('rejects invalid direct helper inputs instead of correcting them', () => {
    expect(() => selectCrossfadeBars([0, 8], 8)).toThrow(/allowed\[0\]/)
    expect(() => selectCrossfadeBars([4, 8], 7.5)).toThrow(/target/)
  })
})

/* ------------------------------------------------------------------ *
 * Determinism & purity
 * ------------------------------------------------------------------ */

describe('determinism and purity', () => {
  it('returns byte-identical results for identical inputs', () => {
    const ctx = context({
      candidates: [track({ trackId: 'a', bpm: 128 }), track({ trackId: 'b', bpm: 130 })],
    })
    const first = selectNextTrack(ctx, intent())
    const second = selectNextTrack(ctx, intent())
    expect(JSON.stringify(first)).toBe(JSON.stringify(second))
  })

  it('does not mutate frozen inputs', () => {
    const candidates = [track({ trackId: 'a' }), track({ trackId: 'b' })]
    candidates.forEach((c) => Object.freeze(c.mood) && Object.freeze(c))
    const ctx = Object.freeze(context({ candidates: Object.freeze(candidates) as DjTrackSummary[] }))
    const dj = Object.freeze(intent())
    expect(() => selectNextTrack(ctx as DjContext, dj)).not.toThrow()
  })

  it('does not depend on candidate array order for tie resolution', () => {
    const a = track({ trackId: 'aaa', bpm: 128, camelot: '8A', energy: 0.5 })
    const b = track({ trackId: 'zzz', bpm: 128, camelot: '8A', energy: 0.5 })
    const forward = selectNextTrack(context({ candidates: [a, b] }), intent())
    const reversed = selectNextTrack(context({ candidates: [b, a] }), intent())
    expect(selected(forward).nextTrackId).toBe('aaa') // lexicographic tie-break
    expect(selected(reversed).nextTrackId).toBe('aaa')
    expect(forward.ranking.map((r) => r.trackId)).toEqual(reversed.ranking.map((r) => r.trackId))
  })
})

/* ------------------------------------------------------------------ *
 * BPM / playback-rate boundaries and no-clamping
 * ------------------------------------------------------------------ */

describe('tempo-sync playback rate', () => {
  it('accepts candidates exactly on the rate boundaries (inclusive)', () => {
    // rate = current.bpm / candidate.bpm
    const atMin = context({
      currentTrack: track({ trackId: 'current', bpm: 90 }),
      candidates: [track({ trackId: 'onMin', bpm: 100 })], // 90/100 = 0.9 == min
    })
    expect(selected(selectNextTrack(atMin, intent())).nextTrackId).toBe('onMin')

    const atMax = context({
      currentTrack: track({ trackId: 'current', bpm: 110 }),
      candidates: [track({ trackId: 'onMax', bpm: 100 })], // 110/100 = 1.1 == max
    })
    expect(selected(selectNextTrack(atMax, intent())).nextTrackId).toBe('onMax')
  })

  it('rejects out-of-range rates without clamping', () => {
    const belowCtx = context({
      currentTrack: track({ trackId: 'current', bpm: 90 }),
      candidates: [track({ trackId: 'tooFast', bpm: 101 })], // 90/101 ≈ 0.8911 < 0.9
    })
    const below = selectNextTrack(belowCtx, intent())
    expect(below.status).toBe('noCandidate')
    expect(exclusionCodes(below, 'tooFast')).toContain('playbackRateBelowRange')
    const entry = below.ranking.find((r) => r.trackId === 'tooFast')
    // Rate is preserved exactly, never clamped to 0.9.
    expect(entry?.playbackRate).toBeCloseTo(90 / 101, 10)
    expect(entry?.playbackRate).not.toBe(0.9)

    const aboveCtx = context({
      currentTrack: track({ trackId: 'current', bpm: 111 }),
      candidates: [track({ trackId: 'tooSlow', bpm: 100 })], // 1.11 > 1.1
    })
    const above = selectNextTrack(aboveCtx, intent())
    expect(exclusionCodes(above, 'tooSlow')).toContain('playbackRateAboveRange')
    expect(above.ranking.find((r) => r.trackId === 'tooSlow')?.playbackRate).toBeCloseTo(1.11, 10)
  })

  it('excludes non-positive candidate bpm as invalidBpm', () => {
    const ctx = context({ candidates: [track({ trackId: 'bad', bpm: 0 })] })
    const result = selectNextTrack(ctx, intent())
    expect(result.status).toBe('noCandidate')
    expect(exclusionCodes(result, 'bad')).toContain('invalidBpm')
    expect(result.ranking.find((r) => r.trackId === 'bad')?.playbackRate).toBeNull()
  })

  it('excludes a non-finite computed rate instead of publishing Infinity', () => {
    const ctx = context({
      currentTrack: track({ trackId: 'current', bpm: Number.MAX_VALUE }),
      candidates: [track({ trackId: 'overflow', bpm: Number.MIN_VALUE })],
    })
    const result = selectNextTrack(ctx, intent())
    expect(result.status).toBe('noCandidate')
    expect(exclusionCodes(result, 'overflow')).toContain('invalidPlaybackRate')
    expect(result.ranking[0].playbackRate).toBeNull()
  })

  it('fails with invalidReferenceBpm when the current track bpm is not > 0', () => {
    const ctx = context({
      currentTrack: track({ trackId: 'current', bpm: 0 }),
      candidates: [track({ trackId: 'a', bpm: 128 })],
    })
    const result = selectNextTrack(ctx, intent())
    expect(result.status).toBe('noCandidate')
    if (result.status === 'noCandidate') {
      expect(result.reasons[0].code).toBe('invalidReferenceBpm')
    }
  })
})

/* ------------------------------------------------------------------ *
 * Camelot compatibility across harmonic priorities
 * ------------------------------------------------------------------ */

describe('Camelot compatibility', () => {
  it('strict excludes incompatible and unknown keys', () => {
    const ctx = context({
      currentTrack: track({ trackId: 'current', camelot: '8A' }),
      candidates: [
        track({ trackId: 'clash', camelot: '2B' }),
        track({ trackId: 'unknown', camelot: 'zzz' }),
        track({ trackId: 'ok', camelot: '9A' }),
      ],
    })
    const result = selectNextTrack(ctx, intent({ harmonicPriority: 'strict' }))
    expect(selected(result).nextTrackId).toBe('ok')
    expect(exclusionCodes(result, 'clash')).toContain('harmonicClash')
    expect(exclusionCodes(result, 'unknown')).toContain('harmonicUnknown')
  })

  it('compatible keeps incompatible keys but ranks harmonic matches higher', () => {
    const ctx = context({
      currentTrack: track({ trackId: 'current', camelot: '8A' }),
      candidates: [
        track({ trackId: 'clash', camelot: '2B' }),
        track({ trackId: 'exact', camelot: '8A' }),
      ],
    })
    const result = selectNextTrack(ctx, intent({ harmonicPriority: 'compatible' }))
    expect(selected(result).nextTrackId).toBe('exact')
    // Not excluded, just scored lower.
    expect(exclusionCodes(result, 'clash')).toHaveLength(0)
  })

  it('ignore makes the camelot component neutral so other factors decide', () => {
    const ctx = context({
      currentTrack: track({ trackId: 'current', camelot: '8A', energy: 0.5 }),
      candidates: [
        track({ trackId: 'clashHiEnergy', camelot: '2B', energy: 0.9 }),
        track({ trackId: 'exactLoEnergy', camelot: '8A', energy: 0.1 }),
      ],
    })
    const result = selectNextTrack(ctx, intent({ harmonicPriority: 'ignore', energyDirection: 'increase' }))
    // Camelot no longer matters; the higher-energy (incompatible) track wins.
    expect(selected(result).nextTrackId).toBe('clashHiEnergy')
  })
})

/* ------------------------------------------------------------------ *
 * Energy direction / target
 * ------------------------------------------------------------------ */

describe('energy scoring', () => {
  it('prefers higher energy when increasing and lower when decreasing', () => {
    const cands = [
      track({ trackId: 'low', energy: 0.2 }),
      track({ trackId: 'high', energy: 0.9 }),
    ]
    const ctx = context({ currentTrack: track({ trackId: 'current', energy: 0.5 }), candidates: cands })
    expect(selected(selectNextTrack(ctx, intent({ energyDirection: 'increase' }))).nextTrackId).toBe('high')
    expect(selected(selectNextTrack(ctx, intent({ energyDirection: 'decrease' }))).nextTrackId).toBe('low')
  })

  it('uses targetEnergy closeness when provided', () => {
    const ctx = context({
      currentTrack: track({ trackId: 'current', energy: 0.5 }),
      candidates: [
        track({ trackId: 'near', energy: 0.71 }),
        track({ trackId: 'far', energy: 0.95 }),
      ],
    })
    const result = selectNextTrack(ctx, intent({ energyDirection: 'increase', targetEnergy: 0.7 }))
    expect(selected(result).nextTrackId).toBe('near')
  })
})

/* ------------------------------------------------------------------ *
 * History / explicit exclusions
 * ------------------------------------------------------------------ */

describe('current / recent / explicit exclusions', () => {
  it('never selects the current track', () => {
    const ctx = context({
      currentTrack: track({ trackId: 'current' }),
      candidates: [track({ trackId: 'current' }), track({ trackId: 'other' })],
    })
    const result = selectNextTrack(ctx, intent())
    expect(selected(result).nextTrackId).toBe('other')
    expect(exclusionCodes(result, 'current')).toContain('isCurrentTrack')
  })

  it('never selects recently played or explicitly excluded tracks', () => {
    const ctx = context({
      candidates: [
        track({ trackId: 'recent' }),
        track({ trackId: 'banned' }),
        track({ trackId: 'fresh' }),
      ],
      recentlyPlayedTrackIds: ['recent'],
    })
    const result = selectNextTrack(ctx, intent({ excludedTrackIds: ['banned'] }))
    expect(selected(result).nextTrackId).toBe('fresh')
    expect(exclusionCodes(result, 'recent')).toContain('recentlyPlayed')
    expect(exclusionCodes(result, 'banned')).toContain('explicitlyExcluded')
  })
})

/* ------------------------------------------------------------------ *
 * Genres / moods
 * ------------------------------------------------------------------ */

describe('genres and moods', () => {
  it('prefers matching genre and mood, and excludes avoided ones', () => {
    const ctx = context({
      candidates: [
        track({ trackId: 'preferred', genre: 'techno', mood: ['dark'] }),
        track({ trackId: 'plain', genre: 'pop', mood: ['happy'] }),
        track({ trackId: 'avoidedGenre', genre: 'trance', mood: ['happy'] }),
        track({ trackId: 'avoidedMood', genre: 'pop', mood: ['sad'] }),
      ],
    })
    const result = selectNextTrack(
      ctx,
      intent({
        preferredGenres: ['techno'],
        preferredMoods: ['dark'],
        avoidedGenres: ['trance'],
        avoidedMoods: ['sad'],
      }),
    )
    expect(selected(result).nextTrackId).toBe('preferred')
    expect(exclusionCodes(result, 'avoidedGenre')).toContain('avoidedGenre')
    expect(exclusionCodes(result, 'avoidedMood')).toContain('avoidedMood')
  })
})

/* ------------------------------------------------------------------ *
 * Requested tracks
 * ------------------------------------------------------------------ */

describe('requestedTrackId', () => {
  it('selects an eligible requested track over a higher-scoring alternative', () => {
    const ctx = context({
      currentTrack: track({ trackId: 'current', camelot: '8A', energy: 0.5 }),
      candidates: [
        track({ trackId: 'requested', camelot: '2B', energy: 0.5 }),
        track({ trackId: 'betterScore', camelot: '8A', energy: 0.9 }),
      ],
    })
    const result = selectNextTrack(
      ctx,
      intent({ requestedTrackId: 'requested', harmonicPriority: 'strict', energyDirection: 'increase' }),
    )
    // Explicit request overrides both strict harmonic and energy preferences.
    expect(selected(result).nextTrackId).toBe('requested')
    expect(result.ranking[0].trackId).toBe('requested') // ranked first
  })

  it('fails when the requested track is not a candidate', () => {
    const ctx = context({ candidates: [track({ trackId: 'a' })] })
    const result = selectNextTrack(ctx, intent({ requestedTrackId: 'ghost' }))
    expect(result.status).toBe('noCandidate')
    if (result.status === 'noCandidate') {
      expect(result.reasons[0].code).toBe('requestedTrackNotFound')
      expect(result.reasons[0].trackId).toBe('ghost')
    }
  })

  it('fails (never substitutes) when the requested track hits a hard rule', () => {
    const ctx = context({
      candidates: [track({ trackId: 'requested' }), track({ trackId: 'other' })],
      recentlyPlayedTrackIds: ['requested'],
    })
    const result = selectNextTrack(ctx, intent({ requestedTrackId: 'requested' }))
    expect(result.status).toBe('noCandidate')
    if (result.status === 'noCandidate') {
      expect(result.reasons[0].code).toBe('requestedTrackIneligible')
    }
  })
})

/* ------------------------------------------------------------------ *
 * Availability (section / CUE)
 * ------------------------------------------------------------------ */

describe('section / CUE availability', () => {
  it('prefers a candidate with a beat grid and section cues', () => {
    const ctx = context({
      candidates: [
        track({ trackId: 'full', hasBeatGrid: true, hasSectionCues: true }),
        track({ trackId: 'noGrid', hasBeatGrid: false, hasSectionCues: false }),
      ],
    })
    const result = selectNextTrack(ctx, intent())
    expect(selected(result).nextTrackId).toBe('full')
    const noGrid = result.ranking.find((r) => r.trackId === 'noGrid')
    expect(noGrid?.components?.availability).toBe(0)
  })
})

/* ------------------------------------------------------------------ *
 * Urgency -> crossfade bars
 * ------------------------------------------------------------------ */

describe('urgency and crossfade bars', () => {
  it('maps urgency to an allowed crossfade bar value', () => {
    const ctx = context({ candidates: [track({ trackId: 'a' })] })
    expect(selected(selectNextTrack(ctx, intent({ transitionUrgency: 'quick' }))).crossfadeBars).toBe(4)
    expect(selected(selectNextTrack(ctx, intent({ transitionUrgency: 'normal' }))).crossfadeBars).toBe(8)
    expect(selected(selectNextTrack(ctx, intent({ transitionUrgency: 'gradual' }))).crossfadeBars).toBe(16)
  })

  it('picks the nearest allowed value when the target is not offered', () => {
    const ctx = context({
      candidates: [track({ trackId: 'a' })],
      limits: { minPlaybackRate: 0.9, maxPlaybackRate: 1.1, allowedCrossfadeBars: [3, 10] },
    })
    // normal target 8 -> nearest allowed is 10
    expect(selected(selectNextTrack(ctx, intent({ transitionUrgency: 'normal' }))).crossfadeBars).toBe(10)
  })

  it('fails when no crossfade bars are allowed', () => {
    const ctx = context({
      candidates: [track({ trackId: 'a' })],
      limits: { minPlaybackRate: 0.9, maxPlaybackRate: 1.1, allowedCrossfadeBars: [] },
    })
    const result = selectNextTrack(ctx, intent())
    expect(result.status).toBe('noCandidate')
    if (result.status === 'noCandidate') {
      expect(result.reasons[0].code).toBe('noAllowedCrossfadeBars')
    }
  })
})

/* ------------------------------------------------------------------ *
 * Zero candidates
 * ------------------------------------------------------------------ */

describe('zero-candidate handling', () => {
  it('reports emptyCandidateSet for an empty candidate list', () => {
    const result = selectNextTrack(context({ candidates: [] }), intent())
    expect(result.status).toBe('noCandidate')
    if (result.status === 'noCandidate') {
      expect(result.reasons[0].code).toBe('emptyCandidateSet')
    }
  })

  it('reports allCandidatesExcluded when every candidate is excluded', () => {
    const ctx = context({
      candidates: [track({ trackId: 'current' }), track({ trackId: 'recent' })],
      recentlyPlayedTrackIds: ['recent'],
    })
    const result = selectNextTrack(ctx, intent())
    expect(result.status).toBe('noCandidate')
    if (result.status === 'noCandidate') {
      expect(result.reasons[0].code).toBe('allCandidatesExcluded')
    }
    // Diagnostics still expose per-candidate exclusion reasons.
    expect(result.ranking).toHaveLength(2)
    expect(exclusionCodes(result, 'current')).toContain('isCurrentTrack')
    expect(exclusionCodes(result, 'recent')).toContain('recentlyPlayed')
  })
})

/* ------------------------------------------------------------------ *
 * Invalid inputs (throw)
 * ------------------------------------------------------------------ */

describe('invalid inputs', () => {
  it('throws on structurally malformed context/intent/policy', () => {
    const good = context({ candidates: [track({ trackId: 'a' })] })
    expect(() => selectNextTrack({ ...good, activeDeckId: 'A', inactiveDeckId: 'A' }, intent())).toThrow()
    expect(() => selectNextTrack({ ...good, candidates: null as unknown as DjTrackSummary[] }, intent())).toThrow()
    expect(() =>
      selectNextTrack(
        { ...good, limits: { minPlaybackRate: 0, maxPlaybackRate: 1.1, allowedCrossfadeBars: [4] } },
        intent(),
      ),
    ).toThrow()
    expect(() =>
      selectNextTrack(
        { ...good, candidates: [{ trackId: 'x' } as unknown as DjTrackSummary] },
        intent(),
      ),
    ).toThrow()
    const badPolicy: DjScoringPolicy = {
      ...DEFAULT_DJ_POLICY,
      weights: { ...DEFAULT_DJ_POLICY.weights, rateSafety: 0.9 },
    }
    expect(() => selectNextTrack(good, intent(), badPolicy)).toThrow()
  })

  it('rejects unknown intent enum values instead of interpreting them as another mode', () => {
    const good = context({ candidates: [track({ trackId: 'a' })] })
    expect(() =>
      selectNextTrack(good, intent({ tempoDirection: 'sideways' as DjIntent['tempoDirection'] })),
    ).toThrow(/intent\.tempoDirection/)
    expect(() =>
      selectNextTrack(good, intent({ energyDirection: 'automatic' as DjIntent['energyDirection'] })),
    ).toThrow(/intent\.energyDirection/)
    expect(() =>
      selectNextTrack(good, intent({ transitionUrgency: 'whenever' as DjIntent['transitionUrgency'] })),
    ).toThrow(/intent\.transitionUrgency/)
  })

  it('rejects duplicate candidate ids so selection never depends on input order', () => {
    const good = context({
      candidates: [track({ trackId: 'duplicate', bpm: 120 }), track({ trackId: 'duplicate', bpm: 128 })],
    })
    expect(() => selectNextTrack(good, intent())).toThrow(/trackId values must be unique/)
  })

  it('rejects out-of-contract policy values even when weights still sum to one', () => {
    const good = context({ candidates: [track({ trackId: 'a' })] })
    const negativeWeight: DjScoringPolicy = {
      ...DEFAULT_DJ_POLICY,
      weights: { ...DEFAULT_DJ_POLICY.weights, rateSafety: -0.1, tempoDirection: 0.5 },
    }
    expect(() => selectNextTrack(good, intent(), negativeWeight)).toThrow(/policy\.weights\.rateSafety/)
    const invalidShare: DjScoringPolicy = {
      ...DEFAULT_DJ_POLICY,
      availabilityBeatGridShare: 2,
    }
    expect(() => selectNextTrack(good, intent(), invalidShare)).toThrow(/availabilityBeatGridShare/)
    const wrongKeys = {
      ...DEFAULT_DJ_POLICY,
      weights: {
        tempoDirection: 0.1,
        camelot: 0.2,
        energy: 0.2,
        genreMood: 0.1,
        availability: 0.1,
        invented: 0.3,
      },
    } as unknown as DjScoringPolicy
    expect(() => selectNextTrack(good, intent(), wrongKeys)).toThrow(/keys must be exactly/)
  })

  it('freezes the shared default policy including nested objects', () => {
    expect(Object.isFrozen(DEFAULT_DJ_POLICY)).toBe(true)
    expect(Object.isFrozen(DEFAULT_DJ_POLICY.weights)).toBe(true)
    expect(Object.isFrozen(DEFAULT_DJ_POLICY.camelotScores)).toBe(true)
    expect(Object.isFrozen(DEFAULT_DJ_POLICY.crossfadeBarsByUrgency)).toBe(true)
  })
})

/* ------------------------------------------------------------------ *
 * Decision shape / confidence
 * ------------------------------------------------------------------ */

describe('decision shape', () => {
  it('emits a schema-shaped DjDecision with machine-readable ranking', () => {
    const ctx = context({ candidates: [track({ trackId: 'a', camelot: '8A', energy: 0.6 })] })
    const result = selectNextTrack(ctx, intent({ energyDirection: 'increase' }))
    const decision = selected(result)
    expect(decision.targetDeckId).toBe('B')
    expect(decision.tempoSync).toBe('tempo')
    expect(decision.startAt).toBe('nextBar')
    expect(decision.confidence).toBeGreaterThanOrEqual(0)
    expect(decision.confidence).toBeLessThanOrEqual(1)
    expect(decision.reasons.length).toBeGreaterThan(0)
    expect(decision.reasons.length).toBeLessThanOrEqual(8)
    const winner = result.ranking.find((r) => r.trackId === 'a')
    expect(winner?.components).not.toBeNull()
    expect(winner?.totalScore).toBe(decision.confidence)
  })
})
