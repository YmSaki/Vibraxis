/**
 * Public surface of the DJ Agent backend package. Consumers import types and
 * constructors from here; the concrete SDK adapters are exposed too but are the
 * only pieces that pull in `openai` / `@openai/codex-sdk` at runtime.
 */

export * from "./types.ts";
export * from "./config.ts";
export { AgentOrchestrator, type OrchestratorDeps } from "./orchestrator.ts";
export { DeterministicProvider } from "./providers/deterministic.ts";
export { Gpt56IntentProvider, buildIntentSystemPrompt } from "./providers/gpt56Intent.ts";
export { CodexLocalProvider, buildCodexPrompt } from "./providers/codexLocal.ts";
export type {
  CodexClientPort,
  CodexThreadOptions,
  CodexThreadPort,
  CodexTurnResult,
  IntentModelClientPort,
  IntentModelRequest,
  IntentModelResult,
} from "./providers/ports.ts";
export { validateContext } from "./validation/context.ts";
export {
  validateIntentSchema,
  validateDecisionSchema,
} from "./validation/schemas.ts";
export {
  validateIntentSemantics,
  validateDecisionSemantics,
} from "./validation/semantic.ts";
export { withDeadline, type DeadlineResult } from "./deadline.ts";
export {
  createAgentRequestListener,
  handleDecideBody,
  type AgentHttpDeps,
} from "./http.ts";
