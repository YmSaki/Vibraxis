/**
 * Typed browser adapter for the DJ Agent HTTP boundary (Order 7 §1).
 *
 * - GET  /api/agent/capability -> AgentCapability
 * - POST /api/agent/decide     -> AgentDecideResponse (decided | rejected)
 *
 * The adapter transports the request/response verbatim. It does NOT clamp,
 * repair, or reinterpret anything: a business "rejected" outcome is returned as
 * data (the backend answers 200 with `outcome: "rejected"`), while a genuine
 * transport failure (non-200, network error, malformed body) is surfaced as a
 * typed {@link AgentApiError} so the UI can show exactly what happened.
 */

import type { AgentCapability, AgentDecideRequest, AgentDecideResponse } from './contract'
import { DJ_NO_CANDIDATE_CODES } from '@vibraxis/shared/dj'

export type AgentApiErrorKind = 'network' | 'http' | 'malformed'

export class AgentApiError extends Error {
  constructor(
    message: string,
    readonly kind: AgentApiErrorKind,
    /** Present for `http` failures. */
    readonly status?: number,
  ) {
    super(message)
    this.name = 'AgentApiError'
  }
}

export interface AgentApiClientOptions {
  /** Base path for the agent routes. Defaults to same-origin `/api/agent`. */
  baseUrl?: string
  /** Injectable fetch for tests. Defaults to the global `fetch`. */
  fetch?: typeof fetch
}

const DEFAULT_BASE_URL = '/api/agent'

export class AgentApiClient {
  readonly #baseUrl: string
  readonly #fetch: typeof fetch

  constructor(options: AgentApiClientOptions = {}) {
    this.#baseUrl = options.baseUrl ?? DEFAULT_BASE_URL
    const boundFetch = options.fetch ?? globalThis.fetch
    if (typeof boundFetch !== 'function') {
      throw new TypeError('AgentApiClient requires a fetch implementation.')
    }
    // Bind so a global fetch is not called with the wrong receiver.
    this.#fetch = boundFetch.bind(globalThis)
  }

  async getCapability(signal?: AbortSignal): Promise<AgentCapability> {
    const response = await this.#send(`${this.#baseUrl}/capability`, { method: 'GET', signal })
    if (!response.ok) {
      throw new AgentApiError(await this.#httpFailure('capability', response), 'http', response.status)
    }
    const value = await this.#json(response)
    if (!isCapability(value)) {
      throw new AgentApiError('capability response did not match the published contract', 'malformed', response.status)
    }
    return value
  }

  async decide(request: AgentDecideRequest, signal?: AbortSignal): Promise<AgentDecideResponse> {
    const response = await this.#send(`${this.#baseUrl}/decide`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
      signal,
    })
    if (!response.ok) {
      // A malformed *transport* (bad JSON envelope, 413, 405...) is an HTTP
      // error. Business rejections are 200 with outcome:"rejected".
      throw new AgentApiError(await this.#httpFailure('decide', response), 'http', response.status)
    }
    const value = await this.#json(response)
    if (!isDecideResponse(value)) {
      throw new AgentApiError('decide response did not match the published contract', 'malformed', response.status)
    }
    return value
  }

  async #send(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.#fetch(url, init)
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === 'AbortError') throw cause
      throw new AgentApiError(
        cause instanceof Error ? cause.message : 'network request failed',
        'network',
      )
    }
  }

  async #json(response: Response): Promise<unknown> {
    try {
      return await response.json()
    } catch {
      throw new AgentApiError('response body was not valid JSON', 'malformed', response.status)
    }
  }

  async #httpFailure(operation: string, response: Response): Promise<string> {
    const prefix = `${operation} request failed with HTTP ${response.status}`
    try {
      const value: unknown = await response.json()
      if (!isRecord(value)) return prefix
      const parts = [value.error, value.detail].filter(
        (item): item is string => typeof item === 'string' && item.length > 0,
      )
      return parts.length > 0 ? `${prefix}: ${parts.join(' — ')}` : prefix
    } catch {
      return prefix
    }
  }
}

/*
 * Runtime validators for the DJ Agent HTTP boundary. These enforce the FULL
 * published contract so a malformed body becomes a typed {@link AgentApiError}
 * instead of an object the UI would render as if it were valid (AGENTS.md
 * §0.4/§0.10). The DjIntent/DjDecision constraints mirror the single-source
 * JSON schemas in `@vibraxis/shared/dj/{intent,decision}.schema.json`; the
 * no-candidate reason codes are imported from the shared runtime enum so they
 * cannot drift. The union-typed enums (routes, failure codes, stages, intent
 * sources) mirror `@vibraxis/backend/agent/contract`, whose barrel is
 * deliberately type-only — reproduced here as small inspectable arrays rather
 * than pulling the server runtime into the browser bundle.
 */

const ROUTES = ['deterministic', 'codex-local', 'gpt56-codex'] as const
const DECISION_PROVIDERS = ['deterministic', 'codex-local'] as const
const INTENT_SOURCES = ['caller', 'gpt-5.6', 'caller-fallback'] as const
const STAGE_NAMES = ['gpt56-intent', 'codex-decision', 'deterministic-selection'] as const
const STAGE_PROVIDERS = ['gpt-5.6', 'codex-local', 'deterministic'] as const
const STAGE_STATUSES = ['succeeded', 'failed', 'skipped'] as const
const AGENT_FAILURE_CODES = [
  'invalid_request', 'invalid_context', 'invalid_intent', 'request_timeout',
  'gpt_unavailable', 'gpt_timeout', 'gpt_provider_error', 'gpt_model_mismatch',
  'intent_schema_invalid', 'intent_semantic_invalid',
  'codex_unavailable', 'codex_timeout', 'codex_provider_error', 'decision_not_json',
  'decision_schema_invalid', 'decision_semantic_invalid', 'decision_not_shortlisted',
  'no_candidate', 'fallback_not_permitted', 'fallback_intent_missing',
] as const
const ENERGY_DIRECTIONS = ['decrease', 'maintain', 'increase'] as const
const TEMPO_DIRECTIONS = ['slower', 'similar', 'faster', 'any'] as const
const HARMONIC_PRIORITIES = ['strict', 'compatible', 'ignore'] as const
const TRANSITION_URGENCIES = ['quick', 'normal', 'gradual'] as const
const DECK_IDS = ['A', 'B'] as const
const TEMPO_SYNC_MODES = ['none', 'tempo'] as const
const CODEX_REASONING_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh'] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === keys.length && actual.every((key) => keys.includes(key))
}

function isMember<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
}

/** A number in a closed range (both bounds inclusive), rejecting NaN/±Infinity. */
function isNumberInRange(value: unknown, min: number, max: number): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
}

function isBoundedString(value: unknown, min: number, max: number): boolean {
  return typeof value === 'string' && value.length >= min && value.length <= max
}

/** A bounded array whose every item is a string within [minLen, maxLen]. */
function isBoundedStringArray(value: unknown, maxItems: number, minLen: number, maxLen: number): boolean {
  return Array.isArray(value)
    && value.length <= maxItems
    && value.every((item) => isBoundedString(item, minLen, maxLen))
}

function isRoute(value: unknown): value is typeof ROUTES[number] {
  return isMember(value, ROUTES)
}

/** Full DjIntent per shared/dj/intent.schema.json (required fields, enums, ranges). */
function isDjIntent(value: unknown): boolean {
  if (!isRecord(value)) return false
  if (!hasExactKeys(value, [
    'energyDirection', 'targetEnergy', 'preferredGenres', 'avoidedGenres',
    'preferredMoods', 'avoidedMoods', 'tempoDirection', 'harmonicPriority',
    'transitionUrgency', 'requestedTrackId', 'excludedTrackIds', 'rationale',
    'confidence',
  ])) return false
  if (!isMember(value.energyDirection, ENERGY_DIRECTIONS)) return false
  if (value.targetEnergy !== null && !isNumberInRange(value.targetEnergy, 0, 1)) return false
  if (!isBoundedStringArray(value.preferredGenres, 8, 1, 80)) return false
  if (!isBoundedStringArray(value.avoidedGenres, 8, 1, 80)) return false
  if (!isBoundedStringArray(value.preferredMoods, 8, 1, 80)) return false
  if (!isBoundedStringArray(value.avoidedMoods, 8, 1, 80)) return false
  if (!isMember(value.tempoDirection, TEMPO_DIRECTIONS)) return false
  if (!isMember(value.harmonicPriority, HARMONIC_PRIORITIES)) return false
  if (!isMember(value.transitionUrgency, TRANSITION_URGENCIES)) return false
  if (value.requestedTrackId !== null && !isBoundedString(value.requestedTrackId, 1, 200)) return false
  if (!isBoundedStringArray(value.excludedTrackIds, 50, 1, 200)) return false
  if (!isBoundedString(value.rationale, 1, 500)) return false
  return isNumberInRange(value.confidence, 0, 1)
}

/** Full DjDecision per shared/dj/decision.schema.json. */
function isDjDecision(value: unknown): boolean {
  if (!isRecord(value)) return false
  if (!hasExactKeys(value, [
    'nextTrackId', 'targetDeckId', 'tempoSync', 'startAt',
    'crossfadeBars', 'confidence', 'reasons',
  ])) return false
  if (!isBoundedString(value.nextTrackId, 1, 200)) return false
  if (!isMember(value.targetDeckId, DECK_IDS)) return false
  if (!isMember(value.tempoSync, TEMPO_SYNC_MODES)) return false
  if (value.startAt !== 'nextBar') return false
  if (typeof value.crossfadeBars !== 'number' || !Number.isInteger(value.crossfadeBars)
    || value.crossfadeBars < 1 || value.crossfadeBars > 32) return false
  if (!isNumberInRange(value.confidence, 0, 1)) return false
  return Array.isArray(value.reasons)
    && value.reasons.length >= 1
    && value.reasons.length <= 8
    && value.reasons.every((reason) => isBoundedString(reason, 1, 300))
}

function isCapability(value: unknown): value is AgentCapability {
  if (!isRecord(value) || !Array.isArray(value.routes) || !value.routes.every(isRoute)) return false
  if (new Set(value.routes).size !== value.routes.length) return false
  if (!isRecord(value.availability)) return false
  if (typeof value.availability.gpt56 !== 'boolean' || typeof value.availability.codexLocal !== 'boolean') return false
  if (value.codexCandidateShortlist !== null && (!Number.isInteger(value.codexCandidateShortlist) || (value.codexCandidateShortlist as number) <= 0)) return false
  if (!isRecord(value.fallback) || value.fallback.optInRequired !== true || !Array.isArray(value.fallback.modes)) return false
  if (value.fallback.modes.length !== 2 || value.fallback.modes[0] !== 'reject' || value.fallback.modes[1] !== 'deterministic') return false
  if (!isRecord(value.gpt56) || value.gpt56.model !== 'gpt-5.6' || !isNumberInRange(value.gpt56.deadlineMs, Number.MIN_VALUE, Number.MAX_VALUE)) return false
  if (!isRecord(value.codex) || !isNumberInRange(value.codex.deadlineMs, Number.MIN_VALUE, Number.MAX_VALUE)) return false
  return typeof value.codex.workingDirectory === 'string'
    && value.codex.sandboxMode === 'read-only'
    && value.codex.networkAccessEnabled === false
    && value.codex.webSearchEnabled === false
    && value.codex.webSearchMode === 'disabled'
    && value.codex.approvalPolicy === 'never'
    && value.codex.skipGitRepoCheck === false
    && (value.codex.model === null || typeof value.codex.model === 'string')
    && (value.codex.reasoningEffort === null || isMember(value.codex.reasoningEffort, CODEX_REASONING_EFFORTS))
}

function isStage(value: unknown): boolean {
  if (!isRecord(value)) return false
  if (!isMember(value.stage, STAGE_NAMES)) return false
  if (!isMember(value.provider, STAGE_PROVIDERS)) return false
  const expectedProvider = value.stage === 'gpt56-intent'
    ? 'gpt-5.6'
    : value.stage === 'codex-decision'
      ? 'codex-local'
      : 'deterministic'
  if (value.provider !== expectedProvider) return false
  if (!isMember(value.status, STAGE_STATUSES)) return false
  // durationMs is optional but, when present, must be a non-negative finite ms count.
  if (value.durationMs !== undefined && !isNumberInRange(value.durationMs, 0, Number.MAX_VALUE)) return false
  if (value.status === 'failed') return isFailure(value.failure)
  return value.failure === undefined
}

function isOptionalStringArray(value: unknown): boolean {
  return value === undefined || (Array.isArray(value) && value.every((item) => typeof item === 'string'))
}

function isNoCandidateReason(value: unknown): boolean {
  if (!isRecord(value)) return false
  if (!isMember(value.code, DJ_NO_CANDIDATE_CODES)) return false
  if (typeof value.detail !== 'string') return false
  return value.trackId === undefined || typeof value.trackId === 'string'
}

function isFailure(value: unknown): boolean {
  if (!isRecord(value) || !isMember(value.code, AGENT_FAILURE_CODES) || typeof value.detail !== 'string') return false
  if (!isOptionalStringArray(value.schemaErrors) || !isOptionalStringArray(value.semanticCodes)) return false
  return value.noCandidateReasons === undefined
    || (Array.isArray(value.noCandidateReasons) && value.noCandidateReasons.every(isNoCandidateReason))
}

type StagePattern = readonly [stage: typeof STAGE_NAMES[number], status: typeof STAGE_STATUSES[number]][]

function hasStagePattern(stages: unknown[], pattern: StagePattern): boolean {
  return stages.length === pattern.length && stages.every((stage, index) => {
    if (!isRecord(stage)) return false
    const expected = pattern[index]
    return expected !== undefined && stage.stage === expected[0] && stage.status === expected[1]
  })
}

/** Only histories the current orchestrator can actually emit are accepted. */
function isRejectedStageHistory(route: typeof ROUTES[number], stages: unknown[]): boolean {
  if (stages.length === 0) return true
  if (route === 'deterministic') {
    return hasStagePattern(stages, [['deterministic-selection', 'failed']])
  }
  if (route === 'codex-local') {
    return hasStagePattern(stages, [['deterministic-selection', 'failed']])
      || hasStagePattern(stages, [
        ['deterministic-selection', 'succeeded'],
        ['codex-decision', 'failed'],
      ])
  }
  return hasStagePattern(stages, [['gpt56-intent', 'failed']])
    || hasStagePattern(stages, [
      ['gpt56-intent', 'failed'],
      ['deterministic-selection', 'failed'],
    ])
    || hasStagePattern(stages, [
      ['gpt56-intent', 'succeeded'],
      ['deterministic-selection', 'failed'],
    ])
    || hasStagePattern(stages, [
      ['gpt56-intent', 'succeeded'],
      ['deterministic-selection', 'succeeded'],
      ['codex-decision', 'failed'],
    ])
}

function isDecideResponse(value: unknown): value is AgentDecideResponse {
  if (!isRecord(value)) return false
  const requestedRoute = value.requestedRoute
  if (!isRoute(requestedRoute) || !Array.isArray(value.stages) || !value.stages.every(isStage)) {
    return false
  }
  if (value.outcome === 'rejected') {
    return value.usedDeterministicFallback === false
      && isFailure(value.failure)
      && isRejectedStageHistory(requestedRoute, value.stages)
  }
  if (value.outcome !== 'decided') return false
  if (!isMember(value.decisionProvider, DECISION_PROVIDERS)) return false
  if (typeof value.usedDeterministicFallback !== 'boolean' || !isRecord(value.intent)) return false
  if (!isMember(value.intent.source, INTENT_SOURCES)) return false
  if (!isDjIntent(value.intent.value)) return false
  if (!isDjDecision(value.decision)) return false

  // Provenance combinations are normative, not independent labels.
  if (value.usedDeterministicFallback) {
    if (value.decisionProvider !== 'deterministic' || value.requestedRoute === 'deterministic') return false
  } else if (value.decisionProvider === 'deterministic') {
    if (value.requestedRoute !== 'deterministic') return false
  } else if (value.requestedRoute === 'deterministic') {
    return false
  }
  if (value.requestedRoute === 'deterministic') {
    return value.decisionProvider === 'deterministic'
      && value.usedDeterministicFallback === false
      && value.intent.source === 'caller'
      && hasStagePattern(value.stages, [['deterministic-selection', 'succeeded']])
  }
  if (value.requestedRoute === 'codex-local') {
    return value.intent.source === 'caller'
      && (value.usedDeterministicFallback
        ? hasStagePattern(value.stages, [
          ['deterministic-selection', 'succeeded'],
          ['codex-decision', 'failed'],
        ])
        : hasStagePattern(value.stages, [
          ['deterministic-selection', 'succeeded'],
          ['codex-decision', 'succeeded'],
        ]))
  }
  if (!value.usedDeterministicFallback) {
    return value.decisionProvider === 'codex-local'
      && value.intent.source === 'gpt-5.6'
      && hasStagePattern(value.stages, [
        ['gpt56-intent', 'succeeded'],
        ['deterministic-selection', 'succeeded'],
        ['codex-decision', 'succeeded'],
      ])
  }
  if (value.decisionProvider !== 'deterministic') return false
  return value.intent.source === 'caller-fallback'
    ? hasStagePattern(value.stages, [
      ['gpt56-intent', 'failed'],
      ['deterministic-selection', 'succeeded'],
    ])
    : value.intent.source === 'gpt-5.6'
      && hasStagePattern(value.stages, [
        ['gpt56-intent', 'succeeded'],
        ['deterministic-selection', 'succeeded'],
        ['codex-decision', 'failed'],
      ])
}
