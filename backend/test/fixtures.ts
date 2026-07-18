/**
 * Shared test fixtures and in-memory fakes. The fakes implement the provider
 * ports so tests never touch the network, spawn the Codex CLI, or use quota.
 */

import type { DjContext, DjDecision, DjIntent, DjTrackSummary } from "@vibraxis/shared/dj";

import { DEFAULT_AGENT_CONFIG, type AgentConfig } from "../src/agent/config.ts";
import { AgentOrchestrator } from "../src/agent/orchestrator.ts";
import { CodexLocalProvider } from "../src/agent/providers/codexLocal.ts";
import { DeterministicProvider } from "../src/agent/providers/deterministic.ts";
import { Gpt56IntentProvider } from "../src/agent/providers/gpt56Intent.ts";
import type {
  CodexClientPort,
  CodexThreadOptions,
  CodexThreadPort,
  IntentModelClientPort,
  IntentModelRequest,
  IntentModelResult,
} from "../src/agent/providers/ports.ts";

export function track(overrides: Partial<DjTrackSummary> = {}): DjTrackSummary {
  return {
    trackId: "t0",
    title: "Title",
    artist: "Artist",
    genre: "house",
    mood: ["warm"],
    bpm: 128,
    camelot: "8A",
    energy: 0.5,
    hasBeatGrid: true,
    hasSectionCues: true,
    ...overrides,
  };
}

/**
 * A context where exactly one candidate (`t2`) is eligible: `t2` is an exact
 * harmonic/near-tempo match; `t3` needs an out-of-range playback rate and is
 * excluded. This makes deterministic selection unambiguous.
 */
export function context(overrides: Partial<DjContext> = {}): DjContext {
  return {
    activeDeckId: "A",
    inactiveDeckId: "B",
    currentTrack: track({ trackId: "current", bpm: 128, camelot: "8A", energy: 0.5 }),
    candidates: [
      track({ trackId: "t2", bpm: 126, camelot: "8A", energy: 0.6, genre: "house" }),
      track({ trackId: "t3", bpm: 200, camelot: "3B", energy: 0.9, genre: "techno" }),
    ],
    recentlyPlayedTrackIds: [],
    limits: { minPlaybackRate: 0.9, maxPlaybackRate: 1.1, allowedCrossfadeBars: [4, 8, 16] },
    ...overrides,
  };
}

export function intent(overrides: Partial<DjIntent> = {}): DjIntent {
  return {
    energyDirection: "increase",
    targetEnergy: null,
    preferredGenres: [],
    avoidedGenres: [],
    preferredMoods: [],
    avoidedMoods: [],
    tempoDirection: "any",
    harmonicPriority: "compatible",
    transitionUrgency: "normal",
    requestedTrackId: null,
    excludedTrackIds: [],
    rationale: "increase the energy",
    confidence: 0.8,
    ...overrides,
  };
}

/** A schema- and semantically-valid decision selecting `t2` on the inactive deck. */
export function decision(overrides: Partial<DjDecision> = {}): DjDecision {
  return {
    nextTrackId: "t2",
    targetDeckId: "B",
    tempoSync: "tempo",
    startAt: "nextBar",
    crossfadeBars: 8,
    confidence: 0.7,
    reasons: ["exact key match, close tempo"],
    ...overrides,
  };
}

/* ------------------------------------------------------------------ *
 * Fakes
 * ------------------------------------------------------------------ */

export interface FakeCodexOptions {
  /** Returns the finalResponse text, or throws, per call. */
  respond: (input: string, options: CodexThreadOptions) => Promise<string> | string;
}

export interface FakeCodexRecord {
  client: CodexClientPort;
  lastThreadOptions: () => CodexThreadOptions | null;
  lastRunOptions: () => { outputSchema?: unknown; signal?: AbortSignal } | null;
}

export function fakeCodex(opts: FakeCodexOptions): FakeCodexRecord {
  let lastThreadOptions: CodexThreadOptions | null = null;
  let lastRunOptions: { outputSchema?: unknown; signal?: AbortSignal } | null = null;
  const client: CodexClientPort = {
    startThread(options: CodexThreadOptions): CodexThreadPort {
      lastThreadOptions = options;
      return {
        async run(input, runOptions) {
          lastRunOptions = runOptions;
          const text = await opts.respond(input, options);
          return { finalResponse: text };
        },
      };
    },
  };
  return {
    client,
    lastThreadOptions: () => lastThreadOptions,
    lastRunOptions: () => lastRunOptions,
  };
}

export interface FakeIntentOptions {
  respond: (request: IntentModelRequest) => Promise<IntentModelResult> | IntentModelResult;
}

export function fakeIntentClient(opts: FakeIntentOptions): IntentModelClientPort {
  return {
    async createStructuredIntent(request: IntentModelRequest): Promise<IntentModelResult> {
      return await opts.respond(request);
    },
  };
}

/* ------------------------------------------------------------------ *
 * Orchestrator wiring
 * ------------------------------------------------------------------ */

export interface BuildOrchestratorArgs {
  intentClient?: IntentModelClientPort | null;
  codexClient?: CodexClientPort | null;
  config?: AgentConfig;
  model?: string;
}

/** Wires an orchestrator with the supplied fakes. Missing clients => provider null. */
export function buildOrchestrator(args: BuildOrchestratorArgs = {}): AgentOrchestrator {
  const config = args.config ?? DEFAULT_AGENT_CONFIG;
  const model = args.model ?? config.gpt56.model;
  const gpt56 =
    args.intentClient == null ? null : new Gpt56IntentProvider(args.intentClient, { model });
  const codex =
    args.codexClient == null
      ? null
      : new CodexLocalProvider(args.codexClient, { workingDirectory: config.codex.workingDirectory || "/repo" });
  return new AgentOrchestrator({
    config,
    deterministic: new DeterministicProvider(),
    gpt56,
    codex,
  });
}

/** A short-deadline config so timeout tests stay fast without hanging. */
export function fastConfig(deadlineMs = 30): AgentConfig {
  return {
    ...DEFAULT_AGENT_CONFIG,
    gpt56: { ...DEFAULT_AGENT_CONFIG.gpt56, deadlineMs },
    codex: { ...DEFAULT_AGENT_CONFIG.codex, deadlineMs },
  };
}

/** Resolves a value after `ms`, but rejects early if the abort signal fires. */
export function delayed<T>(value: T, ms: number, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => resolve(value), ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    });
  });
}

/**
 * Resolves a value after `ms`, DELIBERATELY ignoring the abort signal — models a
 * provider whose child process keeps running past the deadline. Used to prove a
 * late (even valid) result is invalidated and never applied.
 */
export function delayedIgnoringSignal<T>(value: T, ms: number): Promise<T> {
  return new Promise<T>((resolve) => {
    setTimeout(() => resolve(value), ms);
  });
}
