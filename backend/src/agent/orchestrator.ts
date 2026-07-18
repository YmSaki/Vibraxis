/**
 * AgentOrchestrator — routes a decide request to the provider stack the caller
 * explicitly selected and assembles a fully-attributed response.
 *
 * Governing rules (AGENTS.md §0 + the Order 6 contract correction):
 * - The requested route is honoured; it is never silently replaced.
 * - Default failure behaviour is reject. Deterministic fallback runs ONLY when
 *   the request opted in (`fallback.onProviderFailure === "deterministic"`) AND
 *   every input it needs is present. A GPT-5.6 intent failure can never invent a
 *   DjIntent: it may fall back only if the caller supplied `fallback.intent`.
 * - A fallback result is labelled `decisionProvider: "deterministic"` and
 *   `usedDeterministicFallback: true`; it is never presented as a Codex/GPT
 *   result.
 * - Invalid AI output is rejected unchanged (never clamped or repaired).
 * - Late provider results (past the deadline) are invalidated, never applied.
 */

import type {
  DjContext,
  DjDecision,
  DjIntent,
  DjSelectionResult,
  UserDjRequest,
} from "@vibraxis/shared/dj";

import intentSchema from "@vibraxis/shared/dj/intent.schema.json" with { type: "json" };
import decisionSchema from "@vibraxis/shared/dj/decision.schema.json" with { type: "json" };

import { assertAgentConfig, type AgentConfig } from "./config.ts";
import { withDeadline } from "./deadline.ts";
import { CodexLocalProvider } from "./providers/codexLocal.ts";
import { DeterministicProvider } from "./providers/deterministic.ts";
import { Gpt56IntentProvider } from "./providers/gpt56Intent.ts";
import type {
  AgentDecideRequest,
  AgentDecideResponse,
  AgentFailure,
  AgentFailureCode,
  DecidedResponse,
  IntentSource,
  ProviderRoute,
  RejectedResponse,
  StageRecord,
} from "./types.ts";
import { validateContext } from "./validation/context.ts";
import {
  validateDecisionSchema,
  validateIntentSchema,
} from "./validation/schemas.ts";
import {
  validateDecisionSemantics,
  validateIntentSemantics,
} from "./validation/semantic.ts";

const INTENT_SCHEMA = intentSchema as Record<string, unknown>;
const DECISION_SCHEMA = decisionSchema as Record<string, unknown>;

export interface OrchestratorDeps {
  config: AgentConfig;
  deterministic: DeterministicProvider;
  /** Null when no OpenAI client could be constructed (no API key). */
  gpt56: Gpt56IntentProvider | null;
  /** Null when no Codex client is available. */
  codex: CodexLocalProvider | null;
}

function fail(code: AgentFailureCode, detail: string, extra?: Partial<AgentFailure>): AgentFailure {
  return { code, detail, ...extra };
}

function rejected(
  route: ProviderRoute,
  stages: StageRecord[],
  failure: AgentFailure,
): RejectedResponse {
  return { outcome: "rejected", requestedRoute: route, usedDeterministicFallback: false, stages, failure };
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

/** Converts a deterministic selection result into a decision or a typed failure. */
function decisionFromSelection(
  result: DjSelectionResult,
): { ok: true; decision: DjDecision } | { ok: false; failure: AgentFailure } {
  if (result.status === "selected") return { ok: true, decision: result.decision };
  return {
    ok: false,
    failure: fail("no_candidate", "deterministic engine found no eligible candidate", {
      noCandidateReasons: result.reasons,
    }),
  };
}

export class AgentOrchestrator {
  private readonly deps: OrchestratorDeps;

  constructor(deps: OrchestratorDeps) {
    assertAgentConfig(deps.config);
    this.deps = deps;
  }

  async decide(request: AgentDecideRequest): Promise<AgentDecideResponse> {
    const requestStartedAt = Date.now();
    const envelope = this.validateEnvelope(request);
    if (envelope !== null) return envelope;
    const requestDeadlineAt = request.deadlineMs === undefined
      ? null
      : requestStartedAt + request.deadlineMs;

    switch (request.route) {
      case "deterministic":
        return this.runDeterministicRoute(request, requestDeadlineAt);
      case "codex-local":
        return this.runCodexLocalRoute(request, requestDeadlineAt);
      case "gpt56-codex":
        return this.runGpt56CodexRoute(request, requestDeadlineAt);
      default:
        return rejected(
          (request as AgentDecideRequest).route,
          [],
          fail("invalid_request", "unknown route"),
        );
    }
  }

  /* -------------------------------------------------------------- *
   * Envelope validation (shared by every route)
   * -------------------------------------------------------------- */

  private validateEnvelope(request: AgentDecideRequest): RejectedResponse | null {
    const route = request?.route;
    if (route !== "deterministic" && route !== "codex-local" && route !== "gpt56-codex") {
      return rejected(route as ProviderRoute, [], fail("invalid_request", "route is not a supported ProviderRoute"));
    }
    if (!this.deps.config.routes.includes(route)) {
      return rejected(route, [], fail("invalid_request", `route "${route}" is not enabled in config`));
    }
    const allowedKeys = new Set(
      route === "gpt56-codex"
        ? ["route", "context", "text", "deadlineMs", "fallback"]
        : ["route", "context", "intent", "deadlineMs", "fallback"],
    );
    const unexpectedKey = Object.keys(request).find((key) => !allowedKeys.has(key));
    if (unexpectedKey !== undefined) {
      return rejected(route, [], fail("invalid_request", `unexpected request field: ${unexpectedKey}`));
    }
    if (request.fallback !== undefined) {
      if (typeof request.fallback !== "object" || request.fallback === null) {
        return rejected(route, [], fail("invalid_request", "fallback must be an object"));
      }
      const unexpectedFallbackKey = Object.keys(request.fallback).find(
        (key) => key !== "onProviderFailure" && key !== "intent",
      );
      if (unexpectedFallbackKey !== undefined) {
        return rejected(route, [], fail("invalid_request", `unexpected fallback field: ${unexpectedFallbackKey}`));
      }
      const mode = request.fallback.onProviderFailure;
      if (mode !== "reject" && mode !== "deterministic") {
        return rejected(route, [], fail("invalid_request", "fallback.onProviderFailure must be reject or deterministic"));
      }
      if (request.fallback.intent !== undefined && (route !== "gpt56-codex" || mode !== "deterministic")) {
        return rejected(route, [], fail("invalid_request", "fallback.intent is only valid for gpt56-codex deterministic fallback"));
      }
      if (route === "deterministic" && mode === "deterministic") {
        return rejected(route, [], fail("invalid_request", "deterministic route cannot fall back to itself"));
      }
    }
    if (request.deadlineMs !== undefined) {
      if (typeof request.deadlineMs !== "number" || !Number.isFinite(request.deadlineMs) || request.deadlineMs <= 0) {
        return rejected(route, [], fail("invalid_request", "deadlineMs must be a positive finite number"));
      }
    }
    const ctx = validateContext(request.context);
    if (!ctx.ok) return rejected(route, [], fail("invalid_context", ctx.detail));

    if (route === "gpt56-codex") {
      if (typeof request.text !== "string" || request.text.length === 0) {
        return rejected(route, [], fail("invalid_request", "gpt56-codex requires non-empty text"));
      }
    } else {
      const schema = validateIntentSchema<DjIntent>(request.intent);
      if (!schema.ok) {
        return rejected(route, [], fail("invalid_intent", "intent failed schema validation", { schemaErrors: schema.errors }));
      }
    }
    return null;
  }

  private stageDeadline(requestDeadlineAt: number | null, stageMs: number): number {
    return requestDeadlineAt === null ? stageMs : requestDeadlineAt - Date.now();
  }

  private optedIntoFallback(request: AgentDecideRequest): boolean {
    return request.fallback?.onProviderFailure === "deterministic";
  }

  /* -------------------------------------------------------------- *
   * Route: deterministic
   * -------------------------------------------------------------- */

  private runDeterministicRoute(
    request: Extract<AgentDecideRequest, { route: "deterministic" }>,
    requestDeadlineAt: number | null,
  ): AgentDecideResponse {
    const { context, intent } = request;
    // Intent already passed schema validation in the envelope. Run semantic
    // validation too so a fabricated requestedTrackId is rejected, not executed.
    const semantic = validateIntentSemantics(intent, context);
    if (!semantic.ok) {
      return rejected("deterministic", [], fail("invalid_intent", "intent failed semantic validation", {
        semanticCodes: semantic.issues.map((i) => i.code),
      }));
    }
    const stage: StageRecord = { stage: "deterministic-selection", provider: "deterministic", status: "succeeded" };
    const startedAt = Date.now();
    let result: DjSelectionResult;
    try {
      result = this.deps.deterministic.decide(context, intent);
    } catch (error) {
      stage.status = "failed";
      return rejected("deterministic", [stage], fail("invalid_intent", `deterministic engine rejected input: ${String(error)}`));
    }
    stage.durationMs = Date.now() - startedAt;
    if (requestDeadlineAt !== null && Date.now() >= requestDeadlineAt) {
      stage.status = "failed";
      const failure = fail("request_timeout", "deterministic request exceeded its deadline");
      stage.failure = failure;
      return rejected("deterministic", [stage], failure);
    }
    const decision = decisionFromSelection(result);
    if (!decision.ok) {
      stage.status = "failed";
      stage.failure = decision.failure;
      return rejected("deterministic", [stage], decision.failure);
    }
    return {
      outcome: "decided",
      requestedRoute: "deterministic",
      decisionProvider: "deterministic",
      usedDeterministicFallback: false,
      stages: [stage],
      intent: { value: intent, source: "caller" },
      decision: decision.decision,
    };
  }

  /* -------------------------------------------------------------- *
   * Shared deterministic prep for the Codex routes
   * -------------------------------------------------------------- */

  private prepareDeterministic(
    context: DjContext,
    intent: DjIntent,
  ):
    | { ok: true; result: DjSelectionResult; shortlistIds: string[]; winner: DjDecision }
    | { ok: false; failure: AgentFailure } {
    let result: DjSelectionResult;
    try {
      result = this.deps.deterministic.decide(context, intent);
    } catch (error) {
      return { ok: false, failure: fail("invalid_intent", `deterministic engine rejected input: ${String(error)}`) };
    }
    if (result.status !== "selected") {
      // Nothing is eligible: Codex has no valid track to pick, and a
      // deterministic fallback would reach the same dead end. Reject.
      return {
        ok: false,
        failure: fail("no_candidate", "no eligible candidate for Codex to choose from", {
          noCandidateReasons: result.reasons,
        }),
      };
    }
    const eligibleIds = result.ranking
      .filter((r) => r.eligible)
      .map((r) => r.trackId);
    const rankedIds = [
      result.decision.nextTrackId,
      ...eligibleIds.filter((trackId) => trackId !== result.decision.nextTrackId),
    ];
    const shortlistIds = rankedIds.slice(
        0,
        this.deps.config.codexCandidateShortlist ?? Number.MAX_SAFE_INTEGER,
      );
    return { ok: true, result, shortlistIds, winner: result.decision };
  }

  private validateDecision(
    rawText: string,
    context: DjContext,
  ): { ok: true; decision: DjDecision } | { ok: false; failure: AgentFailure } {
    const parsed = parseJson(rawText);
    if (!parsed.ok) return { ok: false, failure: fail("decision_not_json", "Codex output was not valid JSON") };
    const schema = validateDecisionSchema<DjDecision>(parsed.value);
    if (!schema.ok) {
      return { ok: false, failure: fail("decision_schema_invalid", "decision failed schema validation", { schemaErrors: schema.errors }) };
    }
    const semantic = validateDecisionSemantics(schema.value, context);
    if (!semantic.ok) {
      return { ok: false, failure: fail("decision_semantic_invalid", "decision failed semantic validation", { semanticCodes: semantic.issues.map((i) => i.code) }) };
    }
    return { ok: true, decision: schema.value };
  }

  /* -------------------------------------------------------------- *
   * Route: codex-local
   * -------------------------------------------------------------- */

  private async runCodexLocalRoute(
    request: Extract<AgentDecideRequest, { route: "codex-local" }>,
    requestDeadlineAt: number | null,
  ): Promise<AgentDecideResponse> {
    const { context, intent } = request;
    const semantic = validateIntentSemantics(intent, context);
    if (!semantic.ok) {
      return rejected("codex-local", [], fail("invalid_intent", "intent failed semantic validation", { semanticCodes: semantic.issues.map((i) => i.code) }));
    }
    const stages: StageRecord[] = [];
    const prepStage: StageRecord = { stage: "deterministic-selection", provider: "deterministic", status: "succeeded" };
    stages.push(prepStage);
    const prepStartedAt = Date.now();
    const prep = this.prepareDeterministic(context, intent);
    prepStage.durationMs = Date.now() - prepStartedAt;
    if (requestDeadlineAt !== null && Date.now() >= requestDeadlineAt) {
      prepStage.status = "failed";
      const failure = fail("request_timeout", "request deadline expired during deterministic preselection");
      prepStage.failure = failure;
      return rejected("codex-local", stages, failure);
    }
    if (!prep.ok) {
      prepStage.status = "failed";
      prepStage.failure = prep.failure;
      return rejected("codex-local", stages, prep.failure);
    }
    const codexOutcome = await this.runCodexStage(request, requestDeadlineAt, context, intent, prep.shortlistIds, stages);
    if (codexOutcome.ok) {
      return this.decided("codex-local", "codex-local", false, stages, intent, "caller", codexOutcome.decision);
    }
    // Codex failed. Deterministic fallback with the caller's (valid) intent is
    // allowed with opt-in only.
    return this.maybeDeterministicFallback("codex-local", request, requestDeadlineAt, prep.winner, intent, "caller", stages, codexOutcome.failure);
  }

  /* -------------------------------------------------------------- *
   * Route: gpt56-codex
   * -------------------------------------------------------------- */

  private async runGpt56CodexRoute(
    request: Extract<AgentDecideRequest, { route: "gpt56-codex" }>,
    requestDeadlineAt: number | null,
  ): Promise<AgentDecideResponse> {
    const { context } = request;
    const stages: StageRecord[] = [];

    // --- GPT-5.6 intent stage ---
    const intentOutcome = await this.runIntentStage(request, requestDeadlineAt, stages);
    if (!intentOutcome.ok) {
      // A GPT intent failure can never invent a DjIntent. Fall back only if the
      // caller opted in AND supplied a concrete fallback intent.
      return this.gptFailureFallback(request, requestDeadlineAt, stages, intentOutcome.failure);
    }
    const intent = intentOutcome.intent;

    // --- Deterministic prep (narrow candidates) using the GPT intent ---
    const prepStage: StageRecord = { stage: "deterministic-selection", provider: "deterministic", status: "succeeded" };
    stages.push(prepStage);
    const prepStartedAt = Date.now();
    const prep = this.prepareDeterministic(context, intent);
    prepStage.durationMs = Date.now() - prepStartedAt;
    if (requestDeadlineAt !== null && Date.now() >= requestDeadlineAt) {
      prepStage.status = "failed";
      const failure = fail("request_timeout", "request deadline expired during deterministic preselection");
      prepStage.failure = failure;
      return rejected("gpt56-codex", stages, failure);
    }
    if (!prep.ok) {
      prepStage.status = "failed";
      prepStage.failure = prep.failure;
      return rejected("gpt56-codex", stages, prep.failure);
    }

    // --- Codex decision stage ---
    const codexOutcome = await this.runCodexStage(request, requestDeadlineAt, context, intent, prep.shortlistIds, stages);
    if (codexOutcome.ok) {
      return this.decided("gpt56-codex", "codex-local", false, stages, intent, "gpt-5.6", codexOutcome.decision);
    }
    // Codex failed but the GPT intent is valid: deterministic fallback needs
    // only the opt-in (the required input, a valid intent, is already present).
    return this.maybeDeterministicFallback("gpt56-codex", request, requestDeadlineAt, prep.winner, intent, "gpt-5.6", stages, codexOutcome.failure);
  }

  /* -------------------------------------------------------------- *
   * Stage runners
   * -------------------------------------------------------------- */

  private async runIntentStage(
    request: Extract<AgentDecideRequest, { route: "gpt56-codex" }>,
    requestDeadlineAt: number | null,
    stages: StageRecord[],
  ): Promise<{ ok: true; intent: DjIntent } | { ok: false; failure: AgentFailure }> {
    const stage: StageRecord = { stage: "gpt56-intent", provider: "gpt-5.6", status: "failed" };
    stages.push(stage);

    if (this.deps.gpt56 === null) {
      const failure = fail("gpt_unavailable", "no OpenAI client is configured (missing API key)");
      stage.failure = failure;
      return { ok: false, failure };
    }
    const provider = this.deps.gpt56;
    const userRequest: UserDjRequest = { text: request.text, context: request.context };
    const timeoutMs = this.stageDeadline(requestDeadlineAt, this.deps.config.gpt56.deadlineMs);
    if (timeoutMs <= 0) {
      const failure = fail("gpt_timeout", "GPT-5.6 intent stage had no request deadline remaining");
      stage.failure = failure;
      stage.durationMs = 0;
      return { ok: false, failure };
    }
    const outcome = await withDeadline(
      (signal) => provider.interpret(userRequest, INTENT_SCHEMA, signal),
      {
        timeoutMs,
      },
    );
    stage.durationMs = outcome.durationMs;

    if (outcome.status === "timeout") {
      const failure = fail("gpt_timeout", "GPT-5.6 intent stage exceeded its deadline");
      stage.failure = failure;
      return { ok: false, failure };
    }
    if (outcome.status === "error") {
      const failure = fail("gpt_provider_error", `GPT-5.6 intent call failed: ${String((outcome.error as Error)?.message ?? outcome.error)}`);
      stage.failure = failure;
      return { ok: false, failure };
    }
    if (outcome.value.reportedModel !== this.deps.config.gpt56.model) {
      const failure = fail(
        "gpt_model_mismatch",
        `GPT intent model mismatch: requested ${this.deps.config.gpt56.model}, received ${outcome.value.reportedModel}`,
      );
      stage.failure = failure;
      return { ok: false, failure };
    }
    // Validate the raw model output (never trust or repair it).
    const parsed = parseJson(outcome.value.rawText);
    if (!parsed.ok) {
      const failure = fail("intent_schema_invalid", "GPT-5.6 output was not valid JSON");
      stage.failure = failure;
      return { ok: false, failure };
    }
    const schema = validateIntentSchema<DjIntent>(parsed.value);
    if (!schema.ok) {
      const failure = fail("intent_schema_invalid", "GPT-5.6 intent failed schema validation", { schemaErrors: schema.errors });
      stage.failure = failure;
      return { ok: false, failure };
    }
    const semantic = validateIntentSemantics(schema.value, request.context);
    if (!semantic.ok) {
      const failure = fail("intent_semantic_invalid", "GPT-5.6 intent failed semantic validation", { semanticCodes: semantic.issues.map((i) => i.code) });
      stage.failure = failure;
      return { ok: false, failure };
    }
    stage.status = "succeeded";
    return { ok: true, intent: schema.value };
  }

  private async runCodexStage(
    request: AgentDecideRequest,
    requestDeadlineAt: number | null,
    context: DjContext,
    intent: DjIntent,
    shortlistIds: string[],
    stages: StageRecord[],
  ): Promise<{ ok: true; decision: DjDecision } | { ok: false; failure: AgentFailure }> {
    const stage: StageRecord = { stage: "codex-decision", provider: "codex-local", status: "failed" };
    stages.push(stage);

    if (this.deps.codex === null) {
      const failure = fail("codex_unavailable", "no Codex client is available");
      stage.failure = failure;
      return { ok: false, failure };
    }
    const provider = this.deps.codex;
    const timeoutMs = this.stageDeadline(requestDeadlineAt, this.deps.config.codex.deadlineMs);
    if (timeoutMs <= 0) {
      const failure = fail("codex_timeout", "Codex decision stage had no request deadline remaining");
      stage.failure = failure;
      stage.durationMs = 0;
      return { ok: false, failure };
    }
    const outcome = await withDeadline(
      (signal) => provider.decide(context, intent, shortlistIds, DECISION_SCHEMA, signal),
      {
        timeoutMs,
      },
    );
    stage.durationMs = outcome.durationMs;

    if (outcome.status === "timeout") {
      const failure = fail("codex_timeout", "Codex decision stage exceeded its deadline");
      stage.failure = failure;
      return { ok: false, failure };
    }
    if (outcome.status === "error") {
      const failure = fail("codex_provider_error", `Codex call failed: ${String((outcome.error as Error)?.message ?? outcome.error)}`);
      stage.failure = failure;
      return { ok: false, failure };
    }
    const decision = this.validateDecision(outcome.value.rawText, context);
    if (!decision.ok) {
      stage.failure = decision.failure;
      return { ok: false, failure: decision.failure };
    }
    if (intent.requestedTrackId !== null && decision.decision.nextTrackId !== intent.requestedTrackId) {
      const failure = fail(
        "decision_semantic_invalid",
        "Codex decision did not preserve intent.requestedTrackId",
        { semanticCodes: ["requestedTrackNotHonored"] },
      );
      stage.failure = failure;
      return { ok: false, failure };
    }
    if (!shortlistIds.includes(decision.decision.nextTrackId)) {
      const failure = fail(
        "decision_not_shortlisted",
        "Codex selected a track that was not in the disclosed shortlist",
        { semanticCodes: ["nextTrackNotShortlisted"] },
      );
      stage.failure = failure;
      return { ok: false, failure };
    }
    stage.status = "succeeded";
    return { ok: true, decision: decision.decision };
  }

  /* -------------------------------------------------------------- *
   * Fallback governance
   * -------------------------------------------------------------- */

  /** Codex-stage failure fallback: deterministic selection using `intent`. */
  private maybeDeterministicFallback(
    route: ProviderRoute,
    request: AgentDecideRequest,
    requestDeadlineAt: number | null,
    winner: DjDecision,
    intent: DjIntent,
    intentSource: IntentSource,
    stages: StageRecord[],
    priorFailure: AgentFailure,
  ): AgentDecideResponse {
    if (!this.optedIntoFallback(request)) {
      return rejected(route, stages, priorFailure);
    }
    if (requestDeadlineAt !== null && Date.now() >= requestDeadlineAt) {
      return rejected(route, stages, fail("request_timeout", "request deadline expired before deterministic fallback"));
    }
    // `winner` is the deterministic decision already computed from `intent`; it
    // is the exact fallback selection. Record the fallback stage explicitly.
    return this.decided(route, "deterministic", true, stages, intent, intentSource, winner);
  }

  /** GPT-stage failure fallback: allowed only with opt-in AND a caller intent. */
  private gptFailureFallback(
    request: Extract<AgentDecideRequest, { route: "gpt56-codex" }>,
    requestDeadlineAt: number | null,
    stages: StageRecord[],
    priorFailure: AgentFailure,
  ): AgentDecideResponse {
    if (!this.optedIntoFallback(request)) {
      return rejected("gpt56-codex", stages, priorFailure);
    }
    if (requestDeadlineAt !== null && Date.now() >= requestDeadlineAt) {
      return rejected("gpt56-codex", stages, fail("request_timeout", "request deadline expired before deterministic fallback"));
    }
    const fallbackIntent = request.fallback?.intent;
    if (fallbackIntent === undefined) {
      return rejected(
        "gpt56-codex",
        stages,
        fail("fallback_intent_missing", `GPT-5.6 failed (${priorFailure.code}) and no fallback intent was supplied; cannot invent a DjIntent`),
      );
    }
    // Validate the caller-supplied fallback intent exactly like any intent.
    const schema = validateIntentSchema<DjIntent>(fallbackIntent);
    if (!schema.ok) {
      return rejected("gpt56-codex", stages, fail("invalid_intent", "fallback intent failed schema validation", { schemaErrors: schema.errors }));
    }
    const semantic = validateIntentSemantics(schema.value, request.context);
    if (!semantic.ok) {
      return rejected("gpt56-codex", stages, fail("invalid_intent", "fallback intent failed semantic validation", { semanticCodes: semantic.issues.map((i) => i.code) }));
    }
    const stage: StageRecord = { stage: "deterministic-selection", provider: "deterministic", status: "succeeded" };
    stages.push(stage);
    const startedAt = Date.now();
    const prep = this.prepareDeterministic(request.context, schema.value);
    stage.durationMs = Date.now() - startedAt;
    if (requestDeadlineAt !== null && Date.now() >= requestDeadlineAt) {
      stage.status = "failed";
      const failure = fail("request_timeout", "request deadline expired during deterministic fallback");
      stage.failure = failure;
      return rejected("gpt56-codex", stages, failure);
    }
    if (!prep.ok) {
      stage.status = "failed";
      stage.failure = prep.failure;
      return rejected("gpt56-codex", stages, prep.failure);
    }
    return this.decided("gpt56-codex", "deterministic", true, stages, schema.value, "caller-fallback", prep.winner);
  }

  private decided(
    route: ProviderRoute,
    decisionProvider: DecidedResponse["decisionProvider"],
    usedDeterministicFallback: boolean,
    stages: StageRecord[],
    intent: DjIntent,
    intentSource: IntentSource,
    decision: DjDecision,
  ): DecidedResponse {
    return {
      outcome: "decided",
      requestedRoute: route,
      decisionProvider,
      usedDeterministicFallback,
      stages,
      intent: { value: intent, source: intentSource },
      decision,
    };
  }
}
