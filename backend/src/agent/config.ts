/**
 * All behaviour-affecting agent settings, in one public place (AGENTS.md §0.9:
 * every input/condition/constraint that affects real behaviour must be
 * inspectable). The capability endpoint returns a sanitized view of this — it
 * never exposes secrets, tokens, prompts, or absolute audio paths.
 */

import type { ProviderRoute } from "./types.ts";

/** Reasoning effort forwarded to the Codex CLI. Matches the SDK's union. */
export type CodexReasoningEffort =
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh";

export interface Gpt56Config {
  /**
   * The exact public model id. Preserved verbatim; never silently substituted.
   * If a deployment's SDK/API rejects it, that surfaces as a provider error
   * rather than a swapped model.
   */
  readonly model: string;
  /** Deadline for the GPT-5.6 intent call, in ms. */
  readonly deadlineMs: number;
}

export interface CodexConfig {
  /** Fixed working directory for the Codex CLI (the repository root). */
  readonly workingDirectory: string;
  /** Least-capability sandbox actually supported by the installed SDK types. */
  readonly sandboxMode: "read-only";
  readonly networkAccessEnabled: false;
  readonly webSearchEnabled: false;
  readonly webSearchMode: "disabled";
  readonly approvalPolicy: "never";
  /** Repository root is a git repo, so the SDK's git check stays enabled. */
  readonly skipGitRepoCheck: false;
  /** Optional explicit model id; undefined uses the CLI's configured default. */
  readonly model?: string;
  readonly reasoningEffort?: CodexReasoningEffort;
  /** Deadline for the Codex decision call, in ms. */
  readonly deadlineMs: number;
}

export interface AgentConfig {
  /** Routes this backend will serve. */
  readonly routes: readonly ProviderRoute[];
  /**
   * Hard candidate boundary for Codex: only these top deterministic-ranked ids
   * are disclosed and a decision outside this set is rejected. `null` exposes
   * every eligible candidate. An explicit requestedTrackId is always first.
   */
  readonly codexCandidateShortlist: number | null;
  readonly gpt56: Gpt56Config;
  readonly codex: CodexConfig;
}

export const DEFAULT_AGENT_CONFIG: AgentConfig = Object.freeze({
  routes: Object.freeze([
    "deterministic",
    "codex-local",
    "gpt56-codex",
  ] as const),
  codexCandidateShortlist: 5,
  gpt56: Object.freeze({
    model: "gpt-5.6",
    deadlineMs: 15_000,
  }),
  codex: Object.freeze({
    workingDirectory: "",
    sandboxMode: "read-only",
    networkAccessEnabled: false,
    webSearchEnabled: false,
    webSearchMode: "disabled",
    approvalPolicy: "never",
    skipGitRepoCheck: false,
    deadlineMs: 20_000,
  }),
});

/** Rejects invalid behaviour-affecting configuration instead of reinterpreting it. */
export function assertAgentConfig(config: AgentConfig): void {
  if (!Array.isArray(config.routes) || new Set(config.routes).size !== config.routes.length) {
    throw new TypeError("config.routes must contain unique supported routes");
  }
  for (const route of config.routes) {
    if (route !== "deterministic" && route !== "codex-local" && route !== "gpt56-codex") {
      throw new TypeError(`config.routes contains unsupported route: ${String(route)}`);
    }
  }
  const shortlist = config.codexCandidateShortlist;
  if (shortlist !== null && (!Number.isInteger(shortlist) || shortlist <= 0)) {
    throw new TypeError("config.codexCandidateShortlist must be null or a positive integer");
  }
  if (config.gpt56.model !== "gpt-5.6") {
    throw new TypeError('config.gpt56.model must be exactly "gpt-5.6"');
  }
  for (const [name, value] of [
    ["config.gpt56.deadlineMs", config.gpt56.deadlineMs],
    ["config.codex.deadlineMs", config.codex.deadlineMs],
  ] as const) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new TypeError(`${name} must be a positive finite number`);
    }
  }
}

/** Availability of live providers, resolved at composition time (no secrets). */
export interface ProviderAvailability {
  /** True when an OpenAI client could be constructed (an API key was present). */
  readonly gpt56: boolean;
  /** True when a Codex client was constructed (CLI present; login unverified). */
  readonly codexLocal: boolean;
}

/**
 * Read-only capability descriptor returned by the capability endpoint. It
 * mirrors the public, behaviour-affecting settings and never leaks credentials.
 */
export interface AgentCapability {
  routes: readonly ProviderRoute[];
  codexCandidateShortlist: number | null;
  fallback: {
    /** Fallback never happens without explicit opt-in in the request. */
    optInRequired: true;
    /** The only deterministic-fallback mode supported. */
    modes: readonly ["reject", "deterministic"];
  };
  gpt56: { model: string; deadlineMs: number };
  codex: {
    workingDirectory: string;
    sandboxMode: "read-only";
    networkAccessEnabled: false;
    webSearchEnabled: false;
    webSearchMode: "disabled";
    approvalPolicy: "never";
    skipGitRepoCheck: false;
    model: string | null;
    reasoningEffort: CodexReasoningEffort | null;
    deadlineMs: number;
  };
  availability: ProviderAvailability;
}

export function describeCapability(
  config: AgentConfig,
  availability: ProviderAvailability,
): AgentCapability {
  return {
    routes: config.routes,
    codexCandidateShortlist: config.codexCandidateShortlist,
    fallback: {
      optInRequired: true,
      modes: ["reject", "deterministic"],
    },
    gpt56: { model: config.gpt56.model, deadlineMs: config.gpt56.deadlineMs },
    codex: {
      workingDirectory: config.codex.workingDirectory,
      sandboxMode: config.codex.sandboxMode,
      networkAccessEnabled: config.codex.networkAccessEnabled,
      webSearchEnabled: config.codex.webSearchEnabled,
      webSearchMode: config.codex.webSearchMode,
      approvalPolicy: config.codex.approvalPolicy,
      skipGitRepoCheck: config.codex.skipGitRepoCheck,
      model: config.codex.model ?? null,
      reasoningEffort: config.codex.reasoningEffort ?? null,
      deadlineMs: config.codex.deadlineMs,
    },
    availability,
  };
}
