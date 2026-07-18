/**
 * Browser-safe agent contract barrel.
 *
 * This module re-exports ONLY the pure request/response/capability *types* of
 * the DJ Agent HTTP boundary. It deliberately does not touch the orchestrator,
 * the SDK adapters (`openai` / `@openai/codex-sdk`), or any Node built-in, so a
 * browser bundle can `import type` from `@vibraxis/backend/agent/contract`
 * without pulling server runtime into the client (single source of truth, no
 * duplicated shapes — see Order 7 §1).
 *
 * The concrete constructors and SDK adapters remain behind
 * `@vibraxis/backend/agent`; nothing here has a runtime side effect.
 */

export type {
  ProviderRoute,
  DecisionProvider,
  IntentSource,
  StageName,
  StageStatus,
  StageRecord,
  FallbackPolicy,
  DeterministicDecideRequest,
  CodexLocalDecideRequest,
  Gpt56CodexDecideRequest,
  AgentDecideRequest,
  AgentFailureCode,
  AgentFailure,
  DecidedResponse,
  RejectedResponse,
  AgentDecideResponse,
} from "./types.ts";

export type {
  AgentCapability,
  ProviderAvailability,
  CodexReasoningEffort,
} from "./config.ts";
