/**
 * Test-only fixtures for the agent modules. Not imported by application code, so
 * it never reaches the browser bundle.
 */

import type { DeckId, RuntimeState } from '@vibraxis/shared/vdap'
import type { CatalogTrack } from '../catalog'

export function catalogTrack(overrides: Partial<CatalogTrack> & { trackId: string }): CatalogTrack {
  return {
    title: `Title ${overrides.trackId}`,
    artist: 'Tester',
    file: `${overrides.trackId}.mp3`,
    genre: 'edm',
    mood: ['energetic'],
    bpm: 120,
    key: 'C',
    scale: 'major',
    camelot: '8B',
    energy: 0.6,
    beatCount: 100,
    sectionSummary: [],
    performancePads: [],
    degreeFingerprint: [],
    license: 'test',
    licenseStatus: 'verified',
    capabilities: { features: 'complete', beatGrid: 'partial', harmony: 'partial', structure: 'partial' },
    ...overrides,
  }
}

export interface DeckFixture {
  playing?: boolean
  trackId?: string | null
  bindingId?: string
  gridAvailable?: boolean
  loading?: boolean
  /** Active-deck effective (runtime) tempo. `undefined` keeps the 120 default. */
  effectiveBpm?: number | null
}

function deck(id: DeckId, fixture: DeckFixture) {
  const trackId = fixture.trackId === undefined ? null : fixture.trackId
  const binding =
    trackId === null
      ? null
      : {
          bindingId: fixture.bindingId ?? `bind-${id}`,
          trackId,
          source: { kind: 'catalog' as const, uri: `catalog:${trackId}`, title: trackId },
          sha256: null,
          durationSeconds: 200,
          analysis:
            fixture.gridAvailable === false
              ? {
                  analysisRef: 'a',
                  schemaVersion: 1,
                  bpm: 120,
                  timeSignature: '4/4',
                  beatsPerBar: 4,
                  firstDownbeatSeconds: 0,
                  beatCount: 100,
                  barCount: 25,
                  key: 'C',
                  scale: 'major' as const,
                  camelot: '8B',
                  energy: 0.6,
                  grid: { available: false, confidence: null, status: 'skipped' as const },
                }
              : {
                  analysisRef: 'a',
                  schemaVersion: 1,
                  bpm: 120,
                  timeSignature: '4/4',
                  beatsPerBar: 4,
                  firstDownbeatSeconds: 0,
                  beatCount: 100,
                  barCount: 25,
                  key: 'C',
                  scale: 'major' as const,
                  camelot: '8B',
                  energy: 0.6,
                  grid: { available: true, confidence: 0.9, status: 'complete' as const },
                },
        }
  return {
    deckId: id,
    load: fixture.loading ? { phase: 'loading', intentId: 'i', progress: null } : { phase: 'idle', intentId: null, progress: null },
    binding,
    transport: { phase: fixture.playing ? 'playing' : binding ? 'ready' : 'empty' },
    playback: {
      position: { sourceSeconds: 0, atRuntimeTime: 0 },
      baseVelocity: 1,
      override: null,
      configuredVelocity: 1,
      headVelocity: fixture.playing ? 1 : 0,
      direction: fixture.playing ? 'forward' : 'stopped',
    },
    tempo: {
      interpretation: 'normal',
      baseBpm: 120,
      interpretedBpm: 120,
      effectiveBpm: fixture.effectiveBpm === undefined ? 120 : fixture.effectiveBpm,
    },
    gain: 1,
    eq: { lowDb: 0, midDb: 0, highDb: 0 },
    pads: { selectedSlot: 1, slots: [] },
  }
}

export function runtimeState(a: DeckFixture, b: DeckFixture): RuntimeState {
  return {
    revision: 5,
    runtimeTime: 100,
    audio: { contextState: 'running', sampleRate: 48000, outputLatencySeconds: 0 },
    mixer: {
      crossfader: { base: 0, override: null, effective: 0, curve: 'dj', automation: null },
      masterGain: 1,
    },
    decks: { A: deck('A', a), B: deck('B', b) },
    intents: {},
  } as unknown as RuntimeState
}
