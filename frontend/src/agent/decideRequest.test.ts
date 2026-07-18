import { describe, expect, it } from 'vitest'
import { buildDecideRequest, type DecideFormState } from './decideRequest'
import type { DjContext, DjIntent } from './contract'

const context = { activeDeckId: 'A', inactiveDeckId: 'B', candidates: [] } as unknown as DjContext

const intent: DjIntent = {
  energyDirection: 'maintain',
  targetEnergy: null,
  preferredGenres: [],
  avoidedGenres: [],
  preferredMoods: [],
  avoidedMoods: [],
  tempoDirection: 'similar',
  harmonicPriority: 'compatible',
  transitionUrgency: 'normal',
  requestedTrackId: null,
  excludedTrackIds: [],
  rationale: 'test',
  confidence: 0.7,
}

function form(overrides: Partial<DecideFormState>): DecideFormState {
  return { route: 'deterministic', text: '', fallbackMode: 'reject', intent: null, ...overrides }
}

describe('buildDecideRequest', () => {
  it('builds a deterministic request with the caller intent', () => {
    const result = buildDecideRequest(form({ route: 'deterministic', intent }), context)
    expect(result).toEqual({ ok: true, request: { route: 'deterministic', context, intent } })
  })

  it('rejects a deterministic route that asks to fall back to itself', () => {
    const result = buildDecideRequest(form({ route: 'deterministic', intent, fallbackMode: 'deterministic' }), context)
    expect(result).toMatchObject({ ok: false, reason: { code: 'fallbackNotAllowedForRoute' } })
  })

  it('rejects a deterministic/codex route with no intent', () => {
    expect(buildDecideRequest(form({ route: 'deterministic', intent: null }), context)).toMatchObject({
      ok: false,
      reason: { code: 'intentRequired' },
    })
    expect(buildDecideRequest(form({ route: 'codex-local', intent: null }), context)).toMatchObject({
      ok: false,
      reason: { code: 'intentRequired' },
    })
  })

  it('adds an opt-in deterministic fallback (no fallback intent) for codex-local', () => {
    const result = buildDecideRequest(form({ route: 'codex-local', intent, fallbackMode: 'deterministic' }), context)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.request).toEqual({
      route: 'codex-local',
      context,
      intent,
      fallback: { onProviderFailure: 'deterministic' },
    })
  })

  it('omits the fallback field for codex-local reject mode', () => {
    const result = buildDecideRequest(form({ route: 'codex-local', intent, fallbackMode: 'reject' }), context)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect('fallback' in result.request).toBe(false)
  })

  it('rejects the GPT route with empty text', () => {
    const result = buildDecideRequest(form({ route: 'gpt56-codex', text: '' }), context)
    expect(result).toMatchObject({ ok: false, reason: { code: 'textRequired' } })
  })

  it('carries text only (never a top-level intent) for the GPT primary path', () => {
    const result = buildDecideRequest(form({ route: 'gpt56-codex', text: 'more energy', intent }), context)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.request).toEqual({ route: 'gpt56-codex', context, text: 'more energy' })
    expect('intent' in result.request).toBe(false)
  })

  it('requires an explicit fallback intent for a GPT deterministic fallback', () => {
    const missing = buildDecideRequest(form({ route: 'gpt56-codex', text: 'x', fallbackMode: 'deterministic', intent: null }), context)
    expect(missing).toMatchObject({ ok: false, reason: { code: 'fallbackIntentRequired' } })

    const supplied = buildDecideRequest(form({ route: 'gpt56-codex', text: 'x', fallbackMode: 'deterministic', intent }), context)
    expect(supplied.ok).toBe(true)
    if (!supplied.ok) return
    expect(supplied.request).toEqual({
      route: 'gpt56-codex',
      context,
      text: 'x',
      fallback: { onProviderFailure: 'deterministic', intent },
    })
  })

  it('passes an explicit deadline through unchanged', () => {
    const result = buildDecideRequest(form({ route: 'deterministic', intent, deadlineMs: 2500 }), context)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.request).toMatchObject({ deadlineMs: 2500 })
  })
})
