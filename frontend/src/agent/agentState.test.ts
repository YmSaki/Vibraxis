import { describe, expect, it } from 'vitest'
import {
  deriveFlowState,
  decisionProviderLabel,
  intentSourceLabel,
  fallbackNotice,
} from './agentState'
import type { DecidedResponse, RejectedResponse } from './contract'

const decided = (overrides: Partial<DecidedResponse> = {}): DecidedResponse => ({
  outcome: 'decided',
  requestedRoute: 'codex-local',
  decisionProvider: 'codex-local',
  usedDeterministicFallback: false,
  stages: [],
  intent: { value: { rationale: 'r', confidence: 0.5 } as never, source: 'caller' },
  decision: { nextTrackId: 't', targetDeckId: 'B', tempoSync: 'tempo', startAt: 'nextBar', crossfadeBars: 8, confidence: 0.9, reasons: [] },
  ...overrides,
})

const rejected: RejectedResponse = {
  outcome: 'rejected',
  requestedRoute: 'gpt56-codex',
  usedDeterministicFallback: false,
  stages: [],
  failure: { code: 'gpt_unavailable', detail: 'no key' },
}

type FlowArgs = Parameters<typeof deriveFlowState>[0]
const flow = (over: Partial<FlowArgs>): FlowArgs => ({
  phase: 'settled',
  response: decided(),
  apply: 'none',
  applyRunning: false,
  readiness: 'ready',
  hasError: false,
  ...over,
})

describe('deriveFlowState', () => {
  it('is IDLE with no request and PREPARING while deciding', () => {
    expect(deriveFlowState(flow({ phase: 'idle', response: null }))).toBe('IDLE')
    expect(deriveFlowState(flow({ phase: 'deciding', response: null }))).toBe('PREPARING')
  })

  it('is REJECTED for a rejected response', () => {
    expect(deriveFlowState(flow({ response: rejected }))).toBe('REJECTED')
  })

  it('is ERROR after a transport/API failure rather than IDLE', () => {
    expect(deriveFlowState(flow({ response: null, hasError: true }))).toBe('ERROR')
  })

  it('is READY after a decision that is applyable but not yet applied', () => {
    expect(deriveFlowState(flow({ apply: 'none', readiness: 'ready' }))).toBe('READY')
  })

  it('is BLOCKED (never READY) when the decision cannot be applied', () => {
    expect(deriveFlowState(flow({ apply: 'none', readiness: 'blocked' }))).toBe('BLOCKED')
    expect(deriveFlowState(flow({ apply: 'none', readiness: 'unknown' }))).toBe('BLOCKED')
  })

  it('is APPLYING once an apply has started but before a milestone is confirmed', () => {
    expect(deriveFlowState(flow({ apply: 'none', applyRunning: true }))).toBe('APPLYING')
  })

  it('advances to SYNCED, MIXING, then COMPLETE as runtime milestones are confirmed', () => {
    expect(deriveFlowState(flow({ apply: 'synced' }))).toBe('SYNCED')
    expect(deriveFlowState(flow({ apply: 'mixing' }))).toBe('MIXING')
    expect(deriveFlowState(flow({ apply: 'completed' }))).toBe('COMPLETE')
  })

  it('shows FAILED / CANCELLED explicitly — a failed or cancelled apply is never re-shown as READY', () => {
    expect(deriveFlowState(flow({ apply: 'failed' }))).toBe('FAILED')
    expect(deriveFlowState(flow({ apply: 'cancelled' }))).toBe('CANCELLED')
  })
})

describe('provenance labels never mislabel a fallback', () => {
  it('labels a deterministic fallback as the deterministic engine, never Codex/GPT', () => {
    const label = decisionProviderLabel('deterministic', true)
    expect(label).toContain('Deterministic')
    expect(label.toLowerCase()).not.toContain('codex')
    expect(label.toLowerCase()).not.toContain('gpt')
  })

  it('labels a genuine Codex decision as Codex', () => {
    expect(decisionProviderLabel('codex-local', false)).toContain('Codex')
  })

  it('distinguishes the deterministic engine with and without fallback', () => {
    expect(decisionProviderLabel('deterministic', false)).toBe('Deterministic engine')
    expect(decisionProviderLabel('deterministic', true)).toBe('Deterministic engine (fallback)')
  })

  it('attributes the intent source truthfully', () => {
    expect(intentSourceLabel('caller')).toContain('Caller')
    expect(intentSourceLabel('gpt-5.6')).toContain('GPT-5.6')
    expect(intentSourceLabel('caller-fallback')).toContain('fallback')
  })

  it('shows a fallback warning only when a deterministic fallback was used', () => {
    expect(fallbackNotice(decided({ usedDeterministicFallback: false }))).toBeNull()
    const notice = fallbackNotice(
      decided({ usedDeterministicFallback: true, decisionProvider: 'deterministic', intent: { value: {} as never, source: 'gpt-5.6' } }),
    )
    expect(notice).not.toBeNull()
    expect(notice!.toLowerCase()).toContain('not a codex/gpt')
  })
})
