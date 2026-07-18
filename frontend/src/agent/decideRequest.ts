/**
 * Constructs an {@link AgentDecideRequest} from the explicit UI selections plus
 * a truthfully-assembled {@link DjContext} (Order 7 §3).
 *
 * Every route/fallback/intent combination the caller can express is honoured or
 * visibly rejected — never silently transformed. In particular:
 * - `deterministic` and `codex-local` require a caller-supplied DjIntent.
 * - `gpt56-codex` carries natural-language `text` only (never a manual intent),
 *   and its deterministic fallback requires an explicit fallback DjIntent
 *   because the system may never invent one.
 * - `deterministic` cannot fall back to itself.
 * The returned request mirrors exactly what will be sent; nothing is defaulted
 * behind the user's back.
 */

import type {
  AgentDecideRequest,
  DjContext,
  DjIntent,
  FallbackPolicy,
  ProviderRoute,
} from './contract'

export type FallbackMode = 'reject' | 'deterministic'

export interface DecideFormState {
  route: ProviderRoute
  /** Natural-language request. Used only by the `gpt56-codex` route. */
  text: string
  fallbackMode: FallbackMode
  /**
   * Caller-supplied intent. Required for `deterministic`/`codex-local`, and for
   * a `gpt56-codex` deterministic fallback. Ignored (must be absent from the
   * wire request) for the `gpt56-codex` primary path.
   */
  intent: DjIntent | null
  /** Optional per-request deadline override in ms. */
  deadlineMs?: number
}

export type DecideRequestRejectionCode =
  | 'intentRequired'
  | 'textRequired'
  | 'fallbackNotAllowedForRoute'
  | 'fallbackIntentRequired'

export interface DecideRequestRejection {
  code: DecideRequestRejectionCode
  detail: string
}

export type BuildDecideRequestResult =
  | { ok: true; request: AgentDecideRequest }
  | { ok: false; reason: DecideRequestRejection }

function withDeadline<T extends AgentDecideRequest>(base: T, deadlineMs: number | undefined): T {
  return deadlineMs === undefined ? base : { ...base, deadlineMs }
}

export function buildDecideRequest(form: DecideFormState, context: DjContext): BuildDecideRequestResult {
  const { route, fallbackMode, intent, text, deadlineMs } = form

  if (route === 'deterministic') {
    if (fallbackMode === 'deterministic') {
      return {
        ok: false,
        reason: {
          code: 'fallbackNotAllowedForRoute',
          detail: 'The deterministic route cannot fall back to itself; choose "reject".',
        },
      }
    }
    if (intent === null) {
      return { ok: false, reason: { code: 'intentRequired', detail: 'The deterministic route requires a DjIntent.' } }
    }
    return { ok: true, request: withDeadline({ route, context, intent }, deadlineMs) }
  }

  if (route === 'codex-local') {
    if (intent === null) {
      return { ok: false, reason: { code: 'intentRequired', detail: 'The codex-local route requires a DjIntent.' } }
    }
    const fallback: FallbackPolicy | undefined =
      fallbackMode === 'deterministic' ? { onProviderFailure: 'deterministic' } : undefined
    const base = fallback === undefined ? { route, context, intent } : { route, context, intent, fallback }
    return { ok: true, request: withDeadline(base, deadlineMs) }
  }

  // route === 'gpt56-codex'
  if (text.length === 0) {
    return {
      ok: false,
      reason: { code: 'textRequired', detail: 'The GPT-5.6 route requires non-empty natural-language text.' },
    }
  }
  if (fallbackMode === 'deterministic') {
    if (intent === null) {
      return {
        ok: false,
        reason: {
          code: 'fallbackIntentRequired',
          detail: 'A deterministic fallback for the GPT-5.6 route needs an explicit fallback DjIntent (the system never invents one).',
        },
      }
    }
    const fallback: FallbackPolicy = { onProviderFailure: 'deterministic', intent }
    return { ok: true, request: withDeadline({ route, context, text, fallback }, deadlineMs) }
  }
  return { ok: true, request: withDeadline({ route, context, text }, deadlineMs) }
}
