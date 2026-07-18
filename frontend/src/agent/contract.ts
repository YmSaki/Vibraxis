/**
 * Single import surface for the DJ Agent HTTP contract inside the browser app.
 *
 * The shapes are sourced type-only from the backend's browser-safe barrel
 * (`@vibraxis/backend/agent/contract`) so the frontend never redefines the
 * contract and never bundles the server SDK runtime. DjIntent/DjDecision/etc.
 * continue to come from the shared workspace.
 */

export type {
  ProviderRoute,
  DecisionProvider,
  IntentSource,
  StageName,
  StageStatus,
  StageRecord,
  FallbackPolicy,
  AgentDecideRequest,
  DeterministicDecideRequest,
  CodexLocalDecideRequest,
  Gpt56CodexDecideRequest,
  AgentFailureCode,
  AgentFailure,
  DecidedResponse,
  RejectedResponse,
  AgentDecideResponse,
  AgentCapability,
  ProviderAvailability,
} from '@vibraxis/backend/agent/contract'

export type {
  DjContext,
  DjDecision,
  DjIntent,
  DjTrackSummary,
  DjRuntimeLimits,
  TransitionPlan,
} from '@vibraxis/shared/dj'
