/**
 * Live smoke tests. These are OPT-IN and skip themselves unless explicitly
 * enabled, because they spend real model quota / spawn the Codex CLI:
 *   - Codex: set RUN_LIVE_CODEX=1 (needs a working `codex login`).
 *   - GPT-5.6: set RUN_LIVE_GPT=1 and OPENAI_API_KEY.
 * Run with: `npm --workspace backend run test:smoke`.
 *
 * They assert the contract holds against reality: either a schema+semantically
 * valid decision, or a truthful typed failure — never a fabricated success.
 */

import { describe, expect, it } from "vitest";

import { DEFAULT_AGENT_CONFIG } from "../../src/agent/config.ts";
import { AgentOrchestrator } from "../../src/agent/orchestrator.ts";
import { DeterministicProvider } from "../../src/agent/providers/deterministic.ts";
import { CodexLocalProvider } from "../../src/agent/providers/codexLocal.ts";
import { Gpt56IntentProvider } from "../../src/agent/providers/gpt56Intent.ts";
import { createCodexClient } from "../../src/agent/providers/codexClientFactory.ts";
import { tryCreateOpenAiIntentClient } from "../../src/agent/providers/openaiClientFactory.ts";
import { context, intent } from "../fixtures.ts";
import { repositoryRoot } from "../../src/server.ts";

const RUN_CODEX = process.env.RUN_LIVE_CODEX === "1";
const RUN_GPT = process.env.RUN_LIVE_GPT === "1" && Boolean(process.env.OPENAI_API_KEY);

describe("live smoke", () => {
  it.skipIf(!RUN_CODEX)("codex-local produces a valid decision or a typed failure", async () => {
    const workingDirectory = repositoryRoot();
    const orch = new AgentOrchestrator({
      config: { ...DEFAULT_AGENT_CONFIG, codex: { ...DEFAULT_AGENT_CONFIG.codex, workingDirectory } },
      deterministic: new DeterministicProvider(),
      gpt56: null,
      codex: new CodexLocalProvider(createCodexClient(), { workingDirectory }),
    });
    const res = await orch.decide({ route: "codex-local", context: context(), intent: intent() });
    // Whatever happens, the response is a well-formed union member.
    expect(["decided", "rejected"]).toContain(res.outcome);
    if (res.outcome === "decided") {
      expect(res.decisionProvider).toBe("codex-local");
      expect(res.decision.targetDeckId).toBe("B");
    }
  });

  it.skipIf(!RUN_GPT)("gpt56-codex produces a valid intent+decision or a typed failure", async () => {
    const workingDirectory = repositoryRoot();
    const intentClient = tryCreateOpenAiIntentClient(process.env);
    expect(intentClient).not.toBeNull();
    const orch = new AgentOrchestrator({
      config: { ...DEFAULT_AGENT_CONFIG, codex: { ...DEFAULT_AGENT_CONFIG.codex, workingDirectory } },
      deterministic: new DeterministicProvider(),
      gpt56: new Gpt56IntentProvider(intentClient!, { model: DEFAULT_AGENT_CONFIG.gpt56.model }),
      codex: new CodexLocalProvider(createCodexClient(), { workingDirectory }),
    });
    const res = await orch.decide({ route: "gpt56-codex", context: context(), text: "bring the energy up but keep it smooth" });
    expect(["decided", "rejected"]).toContain(res.outcome);
    if (res.outcome === "decided") {
      expect(res.intent.source).toBe("gpt-5.6");
    }
  });
});
