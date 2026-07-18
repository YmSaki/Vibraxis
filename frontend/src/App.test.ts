import { describe, expect, it, vi } from 'vitest'
import { applyTempoSync } from './App'

describe('applyTempoSync', () => {
  it('does not mutate follower velocity when exact tempo sync is out of range', async () => {
    const mutateVelocity = vi.fn(async () => undefined)

    await expect(applyTempoSync(180, 1, 80, mutateVelocity)).rejects.toThrow(RangeError)
    expect(mutateVelocity).not.toHaveBeenCalled()
  })

  it('applies the exact calculated rate for a supported tempo sync', async () => {
    const mutateVelocity = vi.fn(async () => undefined)

    const result = await applyTempoSync(120, 1.05, 100, mutateVelocity)

    expect(result.playbackRate).toBeCloseTo(1.26)
    expect(mutateVelocity).toHaveBeenCalledOnce()
    expect(mutateVelocity).toHaveBeenCalledWith(result.playbackRate)
  })
})
