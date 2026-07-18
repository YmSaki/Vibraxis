import { describe, expect, it } from 'vitest'
import type { DeckGrid } from '@vibraxis/shared/vdap'
import { gridStatusLabel, waveformPlaceholder, waveformWindowSeconds } from './Waveform'

function grid(overrides: Partial<DeckGrid> = {}): DeckGrid {
  return {
    bindingId: 'binding-test',
    timeSignature: '4/4',
    bpm: 120,
    confidence: 0.8,
    beatsSeconds: [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4],
    downbeatsSeconds: [0, 2, 4],
    barsSeconds: [0, 2, 4],
    beatsPerBar: 4,
    sections: [],
    phrases: [],
    chords: [],
    ...overrides,
  }
}

describe('waveformWindowSeconds', () => {
  it('turns the selected bar count into source seconds from the grid', () => {
    expect(waveformWindowSeconds(grid(), 4)).toBe(8)
    expect(waveformWindowSeconds(grid(), 16)).toBe(32)
  })

  it('uses beat spacing when downbeats are unavailable', () => {
    expect(waveformWindowSeconds(grid({ downbeatsSeconds: [], barsSeconds: [] }), 8)).toBe(16)
  })

  it('uses a stable seconds window when there is no grid', () => {
    expect(waveformWindowSeconds(null, 4)).toBe(8)
    expect(waveformWindowSeconds(null, 32)).toBe(64)
  })
})

describe('waveform resource status', () => {
  it('reports a waveform build failure and its actual reason', () => {
    expect(waveformPlaceholder(true, 'failed', 'decoder buffer read failed')).toBe(
      'WAVEFORM FAILED: decoder buffer read failed',
    )
  })

  it('distinguishes grid loading and generic failure states', () => {
    expect(gridStatusLabel('loading', null)).toBe('グリッド読込中')
    expect(gridStatusLabel('failed', 'network disconnected')).toBe(
      'グリッド失敗: network disconnected',
    )
    expect(gridStatusLabel('idle', null)).toBeNull()
    expect(gridStatusLabel('ready', null)).toBeNull()
  })
})
