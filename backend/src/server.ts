/**
 * Composition root: wires the real SDK adapters, resolves provider availability
 * from the environment, and (when run directly) starts the HTTP server.
 *
 * The Codex working directory is fixed to the repository root. GPT-5.6 is only
 * enabled when an API key is present; Codex is enabled whenever a client can be
 * constructed (the CLI must be installed and logged in for calls to succeed —
 * this is reported truthfully at call time, not assumed here).
 */

import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import {
  DEFAULT_AGENT_CONFIG,
  type AgentConfig,
  type ProviderAvailability,
} from "./agent/config.ts";
import { AgentOrchestrator } from "./agent/orchestrator.ts";
import { createAgentRequestListener } from "./agent/http.ts";
import { DeterministicProvider } from "./agent/providers/deterministic.ts";
import { Gpt56IntentProvider } from "./agent/providers/gpt56Intent.ts";
import { CodexLocalProvider } from "./agent/providers/codexLocal.ts";
import { tryCreateOpenAiIntentClient } from "./agent/providers/openaiClientFactory.ts";
import { createCodexClient } from "./agent/providers/codexClientFactory.ts";

/** Repository root = two levels above this file (backend/src/server.ts). */
export function repositoryRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..", "..");
}

export interface BuiltAgent {
  orchestrator: AgentOrchestrator;
  config: AgentConfig;
  availability: ProviderAvailability;
}

/** Assembles the orchestrator from the environment. No network calls happen here. */
export function buildAgent(
  env: Record<string, string | undefined> = process.env,
  enableCodex = true,
): BuiltAgent {
  const workingDirectory = repositoryRoot();
  // The GPT-5.6 model id is caller-selectable via GPT56_MODEL (e.g.
  // "gpt-5.6-luna" for the cheapest variant); unset keeps the default. It is
  // validated as a GPT-5.6 family id by the orchestrator's assertAgentConfig and
  // must match the id the API reports exactly — never silently substituted.
  const modelOverride = env.GPT56_MODEL;
  const gpt56Model =
    modelOverride !== undefined && modelOverride.length > 0
      ? modelOverride
      : DEFAULT_AGENT_CONFIG.gpt56.model;
  const config: AgentConfig = {
    ...DEFAULT_AGENT_CONFIG,
    gpt56: { ...DEFAULT_AGENT_CONFIG.gpt56, model: gpt56Model },
    codex: { ...DEFAULT_AGENT_CONFIG.codex, workingDirectory },
  };

  const intentClient = tryCreateOpenAiIntentClient(env);
  const gpt56 =
    intentClient === null
      ? null
      : new Gpt56IntentProvider(intentClient, { model: config.gpt56.model });

  let codex: CodexLocalProvider | null = null;
  if (enableCodex) {
    try {
      codex = new CodexLocalProvider(createCodexClient(), { workingDirectory });
    } catch {
      // CLI/SDK could not be initialised: report unavailable rather than crash.
      // Actual login is still only verified at call time.
      codex = null;
    }
  }

  const availability: ProviderAvailability = {
    gpt56: gpt56 !== null,
    codexLocal: codex !== null,
  };

  const orchestrator = new AgentOrchestrator({
    config,
    deterministic: new DeterministicProvider(),
    gpt56,
    codex,
  });

  return { orchestrator, config, availability };
}

/** Starts the HTTP server. Returns the server so callers can close it. */
export function startServer(port = Number(process.env.AGENT_PORT ?? 8787)) {
  const { orchestrator, config, availability } = buildAgent();
  const server = createServer(createAgentRequestListener({ orchestrator, config, availability }));
  const host = "127.0.0.1";
  server.listen(port, host, () => {
    // Log the port only — never credentials, prompts, or paths beyond the port.
    console.log(`[vibraxis-agent] listening on http://${host}:${port}`);
  });
  return server;
}

/**
 * Loads a repo-root `.env` into process.env when present, so a local key file is
 * honored without any dependency. Only invoked when this module runs as the
 * entry point — never on import, so tests (which pass env explicitly) are
 * unaffected. Node applies file values without overriding vars already exported
 * in the shell, so an explicit `OPENAI_API_KEY=…` in the environment still wins.
 */
function loadDotEnvIfPresent(): void {
  const envPath = resolve(repositoryRoot(), ".env");
  if (existsSync(envPath)) {
    process.loadEnvFile(envPath);
  }
}

// Start only when executed directly (not when imported by tests).
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  loadDotEnvIfPresent();
  startServer();
}
