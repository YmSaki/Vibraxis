/**
 * Public request/response contract for the DJ Agent decision boundary.
 *
 * Every behaviour-affecting choice a caller can make is expressed here as an
 * explicit, discriminated field — there are no hidden defaults that change which
 * provider runs or whether a fallback is allowed. See AGENTS.md §0: an input's
 * provider/route choice is preserved end-to-end and never silently replaced.
 */

import type {
  DjContext,
  DjDecision,
  DjIntent,
  DjNoCandidateReason,
} from "@vibraxis/shared/dj";

/** The provider route the caller explicitly requests. Never substituted. */
export type ProviderRoute = "deterministic" | "codex-local" | "gpt56-codex";

/** Identity of the component that actually produced the returned decision. */
export type DecisionProvider = "deterministic" | "codex-local";

/** Where an intent value came from. Distinguishes trusted input from AI output. */
export type IntentSource = "caller" | "gpt-5.6" | "caller-fallback";

/** Observable pipeline stages. Kept distinct so provenance is inspectable. */
export type StageName =
  | "gpt56-intent"
  | "codex-decision"
  | "deterministic-selection";

/**
 * Explicit, opt-in fallback policy. Absent or `"reject"` means a provider
 * failure is surfaced as a rejection — never silently replaced. Deterministic
 * fallback runs only when `onProviderFailure === "deterministic"` AND every
 * input it needs is present (see orchestrator).
 */
export interface FallbackPolicy {
  onProviderFailure: "reject" | "deterministic";
  /**
   * Fallback DjIntent the caller supplies up-front. Required only to recover
   * from a GPT-5.6 intent-stage failure on the `gpt56-codex` route: the system
   * may never invent a DjIntent, so without this the failure stays a rejection.
   */
  intent?: DjIntent;
}

interface BaseRequest {
  context: DjContext;
  /** Per-request deadline override in ms. Otherwise each provider uses its published stage deadline. */
  deadlineMs?: number;
  /** Opt-in deterministic fallback. Omitted => reject on provider failure. */
  fallback?: FallbackPolicy;
}

/** Deterministic route: caller supplies a fully-formed DjIntent. */
export interface DeterministicDecideRequest extends BaseRequest {
  route: "deterministic";
  intent: DjIntent;
}

/** Codex-local route: caller supplies a fully-formed DjIntent; Codex selects. */
export interface CodexLocalDecideRequest extends BaseRequest {
  route: "codex-local";
  intent: DjIntent;
}

/** GPT-5.6 -> Codex route: GPT interprets user text into an intent, Codex selects. */
export interface Gpt56CodexDecideRequest extends BaseRequest {
  route: "gpt56-codex";
  /** Natural-language request. Input-only: never executed, never a command. */
  text: string;
}

export type AgentDecideRequest =
  | DeterministicDecideRequest
  | CodexLocalDecideRequest
  | Gpt56CodexDecideRequest;

/* ------------------------------------------------------------------ *
 * Typed failures
 * ------------------------------------------------------------------ */

export type AgentFailureCode =
  // request envelope / boundary
  | "invalid_request"
  | "invalid_context"
  | "invalid_intent"
  | "request_timeout"
  // GPT-5.6 intent stage
  | "gpt_unavailable"
  | "gpt_timeout"
  | "gpt_provider_error"
  | "gpt_model_mismatch"
  | "intent_schema_invalid"
  | "intent_semantic_invalid"
  // Codex decision stage
  | "codex_unavailable"
  | "codex_timeout"
  | "codex_provider_error"
  | "decision_not_json"
  | "decision_schema_invalid"
  | "decision_semantic_invalid"
  | "decision_not_shortlisted"
  // deterministic stage
  | "no_candidate"
  // fallback governance
  | "fallback_not_permitted"
  | "fallback_intent_missing";

/**
 * Machine-readable failure. `detail` is human context only and never affects
 * behaviour. `schemaErrors` / `noCandidateReasons` carry structured specifics.
 */
export interface AgentFailure {
  code: AgentFailureCode;
  detail: string;
  /** JSON-schema validation messages, when the failure is a schema violation. */
  schemaErrors?: string[];
  /** Semantic validation codes, when the failure is a semantic violation. */
  semanticCodes?: string[];
  /** Deterministic engine reasons, when the failure is `no_candidate`. */
  noCandidateReasons?: DjNoCandidateReason[];
}

/* ------------------------------------------------------------------ *
 * Provenance
 * ------------------------------------------------------------------ */

export type StageStatus = "succeeded" | "failed" | "skipped";

export interface StageRecord {
  stage: StageName;
  /** The concrete component this stage ran. */
  provider: "gpt-5.6" | "codex-local" | "deterministic";
  status: StageStatus;
  /** Wall-clock duration in ms. Present for stages that actually ran. */
  durationMs?: number;
  /** Present when `status === "failed"`. */
  failure?: AgentFailure;
}

/* ------------------------------------------------------------------ *
 * Response
 * ------------------------------------------------------------------ */

export interface DecidedResponse {
  outcome: "decided";
  requestedRoute: ProviderRoute;
  /** Actual producer of `decision`. Never labels a fallback as Codex/GPT. */
  decisionProvider: DecisionProvider;
  /** True iff the deterministic engine produced the returned decision. */
  usedDeterministicFallback: boolean;
  stages: StageRecord[];
  intent: { value: DjIntent; source: IntentSource };
  decision: DjDecision;
}

export interface RejectedResponse {
  outcome: "rejected";
  requestedRoute: ProviderRoute;
  usedDeterministicFallback: false;
  stages: StageRecord[];
  /** The terminal, machine-readable reason the request was not fulfilled. */
  failure: AgentFailure;
}

export type AgentDecideResponse = DecidedResponse | RejectedResponse;
