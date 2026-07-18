/**
 * Presentation vocabulary + provenance labels for the Agent panel (Order 7 §2).
 *
 * These pure helpers are the guardrail against mislabeling: a deterministic
 * fallback is NEVER described as a Codex or GPT result, and the intent source is
 * always attributed to who actually produced it. The flow-state vocabulary
 * (PREPARING/READY/SYNCED/MIXING) reflects the real position in the pipeline,
 * never an optimistic guess.
 */

import type {
  AgentDecideResponse,
  DecidedResponse,
  DecisionProvider,
  IntentSource,
} from './contract'

export type FlowState =
  | 'IDLE'
  | 'PREPARING'
  | 'READY'
  | 'BLOCKED'
  | 'APPLYING'
  | 'SYNCED'
  | 'MIXING'
  | 'COMPLETE'
  | 'FAILED'
  | 'CANCELLED'
  | 'REJECTED'
  | 'ERROR'

export type DecidePhase = 'idle' | 'deciding' | 'settled'

/**
 * The furthest apply (transition) milestone the runtime has actually confirmed.
 * Each value is set only after the corresponding step reports `intent.completed`
 * — never optimistically (AGENTS.md §0.5/§0.10).
 */
export type ApplyPhase = 'none' | 'synced' | 'mixing' | 'completed' | 'failed' | 'cancelled'

/** Whether the current decision can be applied against the live runtime. */
export type ApplyReadiness = 'ready' | 'blocked' | 'unknown'

export interface FlowStateInput {
  phase: DecidePhase
  response: AgentDecideResponse | null
  apply: ApplyPhase
  /** True while a transition is executing but before any milestone is confirmed. */
  applyRunning: boolean
  /** Precondition status of applying the decision (from evaluateApply). */
  readiness: ApplyReadiness
  /** True after a decision request failed at the network/HTTP/contract boundary. */
  hasError: boolean
}

/**
 * Derives the single flow-state label shown to the audience/judges. Every label
 * matches the real position in the pipeline: a decision that cannot be applied
 * is BLOCKED (never READY), a failed/cancelled apply keeps its own terminal
 * label (never collapses back to READY), and an apply that has started but not
 * confirmed a milestone is APPLYING (AGENTS.md §0.3/§0.5).
 */
export function deriveFlowState(input: FlowStateInput): FlowState {
  if (input.phase === 'deciding') return 'PREPARING'
  const response = input.response
  if (response === null) return input.hasError ? 'ERROR' : 'IDLE'
  if (response.outcome === 'rejected') return 'REJECTED'
  switch (input.apply) {
    case 'synced':
      return 'SYNCED'
    case 'mixing':
      return 'MIXING'
    case 'completed':
      return 'COMPLETE'
    case 'failed':
      return 'FAILED'
    case 'cancelled':
      return 'CANCELLED'
    case 'none':
    default:
      if (input.applyRunning) return 'APPLYING'
      if (input.readiness === 'ready') return 'READY'
      return 'BLOCKED'
  }
}

/**
 * Human label for the component that actually produced the decision. A
 * deterministic fallback is labelled as the deterministic engine — never Codex.
 */
export function decisionProviderLabel(provider: DecisionProvider, usedDeterministicFallback: boolean): string {
  if (provider === 'deterministic') {
    return usedDeterministicFallback ? 'Deterministic engine (fallback)' : 'Deterministic engine'
  }
  return 'Codex (local CLI)'
}

/** Human label for where the intent came from. */
export function intentSourceLabel(source: IntentSource): string {
  switch (source) {
    case 'caller':
      return 'Caller-supplied intent'
    case 'gpt-5.6':
      return 'GPT-5.6 interpreted intent'
    case 'caller-fallback':
      return 'Caller fallback intent'
    default:
      return String(source)
  }
}

/**
 * Warning banner text when a deterministic fallback produced the result, so the
 * UI can never present it as a Codex/GPT decision. Returns null otherwise.
 */
export function fallbackNotice(response: DecidedResponse): string | null {
  if (!response.usedDeterministicFallback) return null
  return 'Deterministic fallback was used — this is NOT a Codex/GPT result.'
}
