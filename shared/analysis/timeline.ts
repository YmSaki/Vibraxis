/**
 * Shared musical timeline model.
 *
 * A single, UI-agnostic projection from a source-time position to the musical
 * coordinates a human or agent cares about: which beat, where in the bar, which
 * bar, which section, and (when harmony is available) the current chord degree.
 *
 * The runtime `deck.getGrid` query, the waveform overlay, and any DJ agent
 * should read musical position through this model instead of re-deriving the
 * same binary searches. Omitted optional tracks produce `null` fields. Supplied
 * data is never sorted, filtered, rounded, or replaced: invalid data is rejected.
 */

export interface TimelineSection {
  startSeconds: number
  endSeconds: number
  label: string
}

export interface TimelineChord {
  startSeconds: number
  endSeconds: number
  degree: string
  symbol?: string
}

export interface TrackTimelineInput {
  beatsSeconds?: readonly number[]
  downbeatsSeconds?: readonly number[]
  barsSeconds?: readonly number[]
  /** Beats per bar; used only when downbeats are unavailable. Defaults to 4. */
  beatsPerBar?: number
  sections?: readonly TimelineSection[]
  chords?: readonly TimelineChord[]
}

export interface TimelinePosition {
  seconds: number
  /** 0-based index of the most recent beat at or before `seconds`. */
  beatIndex: number | null
  /** 1-based position of the current beat within its bar. */
  beatInBar: number | null
  /** 0-based index of the current bar (downbeat), preferring downbeats then bars. */
  barIndex: number | null
  section: TimelineSection | null
  sectionIndex: number | null
  chordDegree: string | null
  chord: TimelineChord | null
}

export interface TrackTimeline {
  readonly hasBeats: boolean
  readonly hasDownbeats: boolean
  readonly hasSections: boolean
  readonly hasChords: boolean
  readonly beatsPerBar: number
  at(seconds: number): TimelinePosition
}

/** Largest index `i` with `values[i] <= target`, or -1 when none. */
function lastIndexAtMost(values: readonly number[], target: number): number {
  let low = 0
  let high = values.length - 1
  let result = -1
  while (low <= high) {
    const mid = (low + high) >> 1
    if (values[mid] <= target) {
      result = mid
      low = mid + 1
    } else {
      high = mid - 1
    }
  }
  return result
}

/** Smallest index `i` with `values[i] >= target`, or `values.length` when none. */
function firstIndexAtLeast(values: readonly number[], target: number): number {
  let low = 0
  let high = values.length - 1
  let result = values.length
  while (low <= high) {
    const mid = (low + high) >> 1
    if (values[mid] >= target) {
      result = mid
      high = mid - 1
    } else {
      low = mid + 1
    }
  }
  return result
}

function copyAscending(name: string, values: readonly number[] | undefined): number[] {
  if (!Array.isArray(values)) return []
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new RangeError(`${name}[${index}] must be a non-negative finite number.`)
    }
    if (index > 0 && value < values[index - 1]) {
      throw new RangeError(`${name} must be in ascending order.`)
    }
  }
  return [...values]
}

function copyIntervals<T extends TimelineSection | TimelineChord>(
  name: string,
  values: readonly T[] | undefined,
  validate: (value: T, index: number) => void,
): T[] {
  if (!Array.isArray(values)) return []
  values.forEach((value, index) => {
    if (
      typeof value !== 'object' || value === null
      || !Number.isFinite(value.startSeconds) || value.startSeconds < 0
      || !Number.isFinite(value.endSeconds) || value.endSeconds < value.startSeconds
    ) {
      throw new RangeError(`${name}[${index}] must have a valid non-negative time range.`)
    }
    validate(value, index)
  })
  return values.map((value) => ({ ...value }))
}

/**
 * Builds a reusable timeline. The validated input arrays are copied unchanged, so
 * the returned object can be cached per track/load and queried cheaply (O(log n))
 * for every animation frame.
 */
export function createTrackTimeline(input: TrackTimelineInput): TrackTimeline {
  const beats = copyAscending('beatsSeconds', input.beatsSeconds)
  const downbeats = copyAscending('downbeatsSeconds', input.downbeatsSeconds)
  const bars = copyAscending('barsSeconds', input.barsSeconds)
  const beatsPerBar = input.beatsPerBar ?? 4
  if (!Number.isInteger(beatsPerBar) || beatsPerBar < 1) {
    throw new RangeError('beatsPerBar must be a positive integer when provided.')
  }
  const sections = copyIntervals('sections', input.sections, (section, index) => {
    if (typeof section.label !== 'string' || section.label.length === 0) {
      throw new TypeError(`sections[${index}].label must be a non-empty string.`)
    }
  })
  const chords = copyIntervals('chords', input.chords, (chord, index) => {
    if (typeof chord.degree !== 'string' || chord.degree.length === 0) {
      throw new TypeError(`chords[${index}].degree must be a non-empty string.`)
    }
    if (chord.symbol !== undefined && typeof chord.symbol !== 'string') {
      throw new TypeError(`chords[${index}].symbol must be a string when provided.`)
    }
  })
  const barMarkers = downbeats.length > 0 ? downbeats : bars

  return {
    hasBeats: beats.length > 0,
    hasDownbeats: downbeats.length > 0,
    hasSections: sections.length > 0,
    hasChords: chords.length > 0,
    beatsPerBar,
    at(seconds: number): TimelinePosition {
      if (!Number.isFinite(seconds)) throw new RangeError('Timeline position must be finite.')
      const time = seconds
      const beatIndex = beats.length > 0 ? lastIndexAtMost(beats, time) : -1

      let barIndex: number | null = null
      let beatInBar: number | null = null
      if (barMarkers.length > 0) {
        const marker = lastIndexAtMost(barMarkers, time)
        barIndex = marker >= 0 ? marker : null
        if (barIndex !== null && beats.length > 0 && beatIndex >= 0) {
          // Count beats from the current bar's downbeat up to the play head.
          const firstBeatOfBar = firstIndexAtLeast(beats, barMarkers[barIndex])
          beatInBar = Math.max(1, beatIndex - firstBeatOfBar + 1)
        }
      } else if (beats.length > 0 && beatIndex >= 0) {
        // No downbeats: fall back to a fixed meter derived from beatsPerBar.
        barIndex = Math.floor(beatIndex / beatsPerBar)
        beatInBar = (beatIndex % beatsPerBar) + 1
      }

      const sectionIndex = sections.findIndex(
        (section) => time >= section.startSeconds && time < section.endSeconds,
      )
      const section = sectionIndex >= 0 ? sections[sectionIndex] : null

      const chord =
        chords.find((item) => time >= item.startSeconds && time < item.endSeconds) ?? null

      return {
        seconds: time,
        beatIndex: beats.length > 0 && beatIndex >= 0 ? beatIndex : null,
        beatInBar,
        barIndex,
        section,
        sectionIndex: sectionIndex >= 0 ? sectionIndex : null,
        chordDegree: chord?.degree ?? null,
        chord,
      }
    },
  }
}
