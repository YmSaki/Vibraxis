import { describe, expect, it } from 'vitest'
import { createTrackTimeline } from '@vibraxis/shared/analysis'

describe('createTrackTimeline', () => {
  const grid = {
    beatsSeconds: [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5],
    downbeatsSeconds: [0, 2],
    beatsPerBar: 4,
    sections: [
      { startSeconds: 0, endSeconds: 2, label: 'intro' },
      { startSeconds: 2, endSeconds: 4, label: 'verse' },
    ],
    chords: [
      { startSeconds: 0, endSeconds: 2, degree: 'I', symbol: 'C' },
      { startSeconds: 2, endSeconds: 4, degree: 'V', symbol: 'G' },
    ],
  }

  it('projects beat, beat-in-bar, bar, section, and chord from downbeats', () => {
    const timeline = createTrackTimeline(grid)
    const at = timeline.at(1.2)
    expect(at.beatIndex).toBe(2) // 1.0s beat
    expect(at.beatInBar).toBe(3) // third beat of first bar
    expect(at.barIndex).toBe(0)
    expect(at.section?.label).toBe('intro')
    expect(at.sectionIndex).toBe(0)
    expect(at.chordDegree).toBe('I')
  })

  it('advances to the next bar at its downbeat', () => {
    const timeline = createTrackTimeline(grid)
    const at = timeline.at(2.0)
    expect(at.beatIndex).toBe(4)
    expect(at.barIndex).toBe(1)
    expect(at.beatInBar).toBe(1)
    expect(at.section?.label).toBe('verse')
    expect(at.chordDegree).toBe('V')
  })

  it('returns nulls before the first beat and with no data', () => {
    const timeline = createTrackTimeline(grid)
    const before = timeline.at(-1)
    expect(before.beatIndex).toBeNull()
    expect(before.beatInBar).toBeNull()

    const empty = createTrackTimeline({})
    const at = empty.at(5)
    expect(at.beatIndex).toBeNull()
    expect(at.barIndex).toBeNull()
    expect(at.section).toBeNull()
    expect(at.chordDegree).toBeNull()
    expect(empty.hasBeats).toBe(false)
  })

  it('falls back to a fixed meter when only beats are known', () => {
    const timeline = createTrackTimeline({
      beatsSeconds: [0, 0.5, 1, 1.5, 2, 2.5],
      beatsPerBar: 4,
    })
    expect(timeline.hasDownbeats).toBe(false)
    const at = timeline.at(2.1) // beat index 4
    expect(at.beatIndex).toBe(4)
    expect(at.barIndex).toBe(1)
    expect(at.beatInBar).toBe(1)
  })

  it('rejects invalid input instead of silently changing it', () => {
    expect(() => createTrackTimeline({ beatsSeconds: [1, 0, 0.5] }))
      .toThrow('beatsSeconds must be in ascending order.')
    expect(() => createTrackTimeline({ beatsSeconds: [0, Number.NaN] }))
      .toThrow('beatsSeconds[1] must be a non-negative finite number.')
    expect(() => createTrackTimeline({ beatsPerBar: 0 }))
      .toThrow('beatsPerBar must be a positive integer when provided.')
    expect(() => createTrackTimeline({
      sections: [{ startSeconds: 0, endSeconds: 1, label: '' }],
    })).toThrow('sections[0].label must be a non-empty string.')
  })

  it('rejects a non-finite query position instead of substituting zero', () => {
    const timeline = createTrackTimeline(grid)
    expect(() => timeline.at(Number.NaN)).toThrow('Timeline position must be finite.')
  })
})
