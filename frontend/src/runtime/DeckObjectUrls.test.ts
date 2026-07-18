import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DeckObjectUrls } from './DeckObjectUrls'

const file = { name: 'track.wav' } as File

beforeEach(() => {
  let sequence = 0
  vi.stubGlobal('URL', {
    createObjectURL: vi.fn(() => `blob:${++sequence}`),
    revokeObjectURL: vi.fn(),
  })
})

afterEach(() => vi.unstubAllGlobals())

describe('DeckObjectUrls', () => {
  it('revokes the new URL on failure and preserves the previously bound URL', async () => {
    const urls = new DeckObjectUrls()
    await urls.load('A', file, async () => undefined)
    await expect(urls.load('A', file, async () => { throw new Error('load failed') }))
      .rejects.toThrow('load failed')
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:2')

    urls.clear('A')
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:1')
  })

  it('revokes replaced, catalog-cleared, and disposed URLs exactly once', async () => {
    const urls = new DeckObjectUrls()
    await urls.load('A', file, async () => undefined)
    await urls.load('A', file, async () => undefined)
    await urls.load('B', file, async () => undefined)

    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:1')
    urls.clear('A')
    urls.dispose()
    expect(vi.mocked(URL.revokeObjectURL).mock.calls).toEqual([
      ['blob:1'],
      ['blob:2'],
      ['blob:3'],
    ])
  })
})
