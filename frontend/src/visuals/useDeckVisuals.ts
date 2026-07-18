import { useEffect, useMemo, useState } from 'react'
import {
  createTrackTimeline,
  type TimelineSection,
  type TrackTimeline,
} from '@vibraxis/shared/analysis'
import type { DeckGrid, TrackBinding } from '@vibraxis/shared/vdap'
import type { DeckId, DeckEngine } from '../audio/DeckEngine'
import {
  buildWaveform,
  recommendedWaveformBinCount,
  type WaveformBands,
} from '../audio/waveform'
import { VdapClientError, type VdapClient } from '../runtime/VdapClient'

export type DeckVisuals = {
  waveform: WaveformBands | null
  waveformStatus: 'idle' | 'building' | 'ready' | 'failed'
  waveformFailureReason: string | null
  grid: DeckGrid | null
  gridStatus: 'idle' | 'loading' | 'ready' | 'failed'
  gridFailureReason: string | null
  timeline: TrackTimeline | null
}

// Derived visualization data is cached per track so re-loading the same catalog
// track (e.g. onto both decks) reuses one build. Kept module-level and out of the
// VDAP snapshot: this is UI-only derived data, not canonical control state.
const waveformCache = new Map<string, WaveformBands>()
const gridCache = new Map<string, DeckGrid>()

export function validateGridBinding(bindingId: string, grid: DeckGrid): DeckGrid {
  if (grid.bindingId !== bindingId) {
    throw new VdapClientError(
      `deck.getGrid returned binding ${grid.bindingId}; expected ${bindingId}.`,
      'PROTOCOL',
    )
  }
  return grid
}

export async function loadGridForBinding(
  bindingId: string,
  query: () => Promise<DeckGrid>,
  cache: Map<string, DeckGrid> = gridCache,
): Promise<DeckGrid> {
  const cached = cache.get(bindingId)
  if (cached) return validateGridBinding(bindingId, cached)
  const grid = validateGridBinding(bindingId, await query())
  cache.set(bindingId, grid)
  return grid
}

function failureReason(cause: unknown): string {
  if (cause instanceof Error && cause.message.trim()) return cause.message
  return 'Unknown visualization failure.'
}

function buildTimeline(grid: DeckGrid | null): TrackTimeline | null {
  if (!grid) return null
  const sections = (grid.sections as Array<Record<string, unknown>>).map((section) => ({
    startSeconds: Number(section.startSeconds),
    endSeconds: Number(section.endSeconds),
    label: String(section.label ?? 'section'),
  })) satisfies TimelineSection[]
  return createTrackTimeline({
    beatsSeconds: grid.beatsSeconds,
    downbeatsSeconds: grid.downbeatsSeconds,
    barsSeconds: grid.barsSeconds,
    beatsPerBar: grid.beatsPerBar,
    sections,
    chords: grid.chords,
  })
}

/**
 * Resolves the per-deck derived visualization data (3-band waveform + full beat
 * grid + musical timeline) for the currently bound track. A file upload with no
 * analysis still yields a waveform with an idle grid. Build and query failures
 * remain explicit states so the UI never presents an unconfirmed result.
 */
export function useDeckVisuals(
  deckId: DeckId,
  binding: TrackBinding | null,
  client: VdapClient | null,
  engine: DeckEngine,
): DeckVisuals {
  const bindingId = binding?.bindingId ?? null
  const trackId = binding?.trackId ?? null
  const hasAnalysis = binding?.analysis != null

  const [waveform, setWaveform] = useState<WaveformBands | null>(null)
  const [waveformStatus, setWaveformStatus] = useState<DeckVisuals['waveformStatus']>('idle')
  const [waveformFailureReason, setWaveformFailureReason] = useState<string | null>(null)
  const [grid, setGrid] = useState<DeckGrid | null>(null)
  const [gridStatus, setGridStatus] = useState<DeckVisuals['gridStatus']>('idle')
  const [gridFailureReason, setGridFailureReason] = useState<string | null>(null)

  useEffect(() => {
    if (!bindingId || !trackId) {
      setWaveform(null)
      setWaveformStatus('idle')
      setWaveformFailureReason(null)
      setGrid(null)
      setGridStatus('idle')
      setGridFailureReason(null)
      return
    }
    let cancelled = false

    const cachedWaveform = waveformCache.get(trackId) ?? null
    const cachedGrid = gridCache.get(bindingId) ?? null
    setWaveform(cachedWaveform)
    setWaveformStatus(cachedWaveform ? 'ready' : 'building')
    setWaveformFailureReason(null)
    setGrid(cachedGrid)
    setGridStatus(cachedGrid ? 'ready' : hasAnalysis ? 'loading' : 'idle')
    setGridFailureReason(null)

    if (!waveformCache.has(trackId)) {
      const buffer = engine.getTrackBuffer(deckId)
      if (buffer) {
        void buildWaveform(buffer, recommendedWaveformBinCount(buffer.duration))
          .then((bands) => {
            waveformCache.set(trackId, bands)
            if (!cancelled) {
              setWaveform(bands)
              setWaveformStatus('ready')
            }
          })
          .catch((cause: unknown) => {
            if (!cancelled) {
              setWaveform(null)
              setWaveformStatus('failed')
              setWaveformFailureReason(failureReason(cause))
            }
          })
      } else {
        setWaveformStatus('failed')
        setWaveformFailureReason('Decoded audio buffer is unavailable.')
      }
    }

    if (!cachedGrid && hasAnalysis && client) {
      void loadGridForBinding(bindingId, () => client.query('deck.getGrid', { deckId }))
        .then((result) => {
          if (!cancelled) {
            setGrid(result)
            setGridStatus('ready')
          }
        })
        .catch((cause: unknown) => {
          if (cancelled) return
          setGrid(null)
          setGridStatus('failed')
          setGridFailureReason(failureReason(cause))
        })
    } else if (!cachedGrid && hasAnalysis && !client) {
      setGridStatus('failed')
      setGridFailureReason('VDAP client is unavailable.')
    }

    return () => {
      cancelled = true
    }
  }, [bindingId, trackId, hasAnalysis, client, engine, deckId])

  const timeline = useMemo(() => buildTimeline(grid), [grid])

  return {
    waveform,
    waveformStatus,
    waveformFailureReason,
    grid,
    gridStatus,
    gridFailureReason,
    timeline,
  }
}
