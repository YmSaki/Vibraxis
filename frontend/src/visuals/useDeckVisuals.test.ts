import { describe, expect, it } from 'vitest'
import type { DeckGrid } from '@vibraxis/shared/vdap'
import { loadGridForBinding } from './useDeckVisuals'

function grid(bindingId: string): DeckGrid {
  return {
    bindingId,
    timeSignature: '4/4',
    bpm: 120,
    confidence: 0.8,
    beatsSeconds: [0, 0.5],
    downbeatsSeconds: [0],
    barsSeconds: [0],
    beatsPerBar: 4,
    sections: [],
    phrases: [],
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('loadGridForBinding', () => {
  it('preserves a generic query failure instead of treating it as unavailable success', async () => {
    const cause = new Error('transport failed')
    await expect(loadGridForBinding('binding-a', () => Promise.reject(cause), new Map()))
      .rejects.toBe(cause)
  })

  it('rejects a response for a different binding and does not cache it', async () => {
    const cache = new Map<string, DeckGrid>()
    await expect(loadGridForBinding('binding-new', async () => grid('binding-old'), cache))
      .rejects.toThrow('expected binding-new')
    expect(cache.size).toBe(0)
  })

  it('keeps a delayed old response from overwriting the new binding grid', async () => {
    const cache = new Map<string, DeckGrid>()
    const oldResponse = deferred<DeckGrid>()
    const newResponse = deferred<DeckGrid>()
    const oldLoad = loadGridForBinding('binding-old', () => oldResponse.promise, cache)
    const newLoad = loadGridForBinding('binding-new', () => newResponse.promise, cache)

    newResponse.resolve(grid('binding-new'))
    await newLoad
    oldResponse.resolve(grid('binding-old'))
    await oldLoad

    expect(cache.get('binding-new')?.bindingId).toBe('binding-new')
    expect(cache.get('binding-old')?.bindingId).toBe('binding-old')
  })

  it('queries again when the same track is loaded under a different binding', async () => {
    const cache = new Map<string, DeckGrid>()
    let queries = 0
    await loadGridForBinding('binding-1', async () => {
      queries += 1
      return grid('binding-1')
    }, cache)
    await loadGridForBinding('binding-2', async () => {
      queries += 1
      return grid('binding-2')
    }, cache)

    expect(queries).toBe(2)
    expect([...cache.keys()]).toEqual(['binding-1', 'binding-2'])
  })
})
