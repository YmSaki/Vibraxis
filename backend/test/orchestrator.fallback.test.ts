import { describe, expect, it } from "vitest";

import {
  buildOrchestrator,
  context,
  decision,
  fakeCodex,
  fakeIntentClient,
  intent,
} from "./fixtures.ts";

const validIntent = intent();

describe("fallback governance — no fallback without opt-in", () => {
  it("codex-local: Codex error rejects (no fallback) by default", async () => {
    const rec = fakeCodex({ respond: () => { throw new Error("codex crashed"); } });
    const orch = buildOrchestrator({ codexClient: rec.client });
    const res = await orch.decide({ route: "codex-local", context: context(), intent: validIntent });
    expect(res.outcome).toBe("rejected");
    if (res.outcome === "rejected") {
      expect(res.failure.code).toBe("codex_provider_error");
      expect(res.usedDeterministicFallback).toBe(false);
    }
  });

  it("rejects an unknown fallback mode instead of interpreting it as reject", async () => {
    const orch = buildOrchestrator();
    const res = await orch.decide({
      route: "deterministic",
      context: context(),
      intent: validIntent,
      fallback: { onProviderFailure: "best-effort" },
    } as never);
    expect(res.outcome).toBe("rejected");
    if (res.outcome === "rejected") expect(res.failure.code).toBe("invalid_request");
  });

  it("rejects undisclosed request fields", async () => {
    const orch = buildOrchestrator();
    const res = await orch.decide({
      route: "deterministic",
      context: context(),
      intent: validIntent,
      silentMagic: true,
    } as never);
    expect(res.outcome).toBe("rejected");
    if (res.outcome === "rejected") expect(res.failure.detail).toContain("unexpected request field");
  });

  it("rejects fallback.intent where that input has no defined meaning", async () => {
    const orch = buildOrchestrator({ codexClient: fakeCodex({ respond: () => JSON.stringify(decision()) }).client });
    const res = await orch.decide({
      route: "codex-local",
      context: context(),
      intent: validIntent,
      fallback: { onProviderFailure: "deterministic", intent: validIntent },
    } as never);
    expect(res.outcome).toBe("rejected");
    if (res.outcome === "rejected") expect(res.failure.code).toBe("invalid_request");
  });
});

describe("fallback governance — codex failure with opt-in", () => {
  it("codex-local: falls back to deterministic using the caller intent, labelled honestly", async () => {
    const rec = fakeCodex({ respond: () => JSON.stringify(decision({ nextTrackId: "ghost" })) }); // semantic-invalid
    const orch = buildOrchestrator({ codexClient: rec.client });
    const res = await orch.decide({
      route: "codex-local",
      context: context(),
      intent: validIntent,
      fallback: { onProviderFailure: "deterministic" },
    });
    expect(res.outcome).toBe("decided");
    if (res.outcome === "decided") {
      // The fallback is NEVER labelled as a Codex result.
      expect(res.decisionProvider).toBe("deterministic");
      expect(res.usedDeterministicFallback).toBe(true);
      expect(res.intent.source).toBe("caller");
      expect(res.decision.nextTrackId).toBe("t2");
      const codexStage = res.stages.find((s) => s.stage === "codex-decision");
      expect(codexStage?.status).toBe("failed");
      expect(res.stages.some((s) => s.stage === "deterministic-selection")).toBe(true);
    }
  });

  it("gpt56-codex: Codex failure falls back to deterministic using the GPT intent (opt-in only)", async () => {
    const intentClient = fakeIntentClient({ respond: () => ({ text: JSON.stringify(validIntent), model: "gpt-5.6" }) });
    const rec = fakeCodex({ respond: () => { throw new Error("codex down"); } });
    const orch = buildOrchestrator({ intentClient, codexClient: rec.client });
    const res = await orch.decide({
      route: "gpt56-codex",
      context: context(),
      text: "energy up",
      fallback: { onProviderFailure: "deterministic" },
    });
    expect(res.outcome).toBe("decided");
    if (res.outcome === "decided") {
      expect(res.decisionProvider).toBe("deterministic");
      expect(res.usedDeterministicFallback).toBe(true);
      expect(res.intent.source).toBe("gpt-5.6"); // intent still came from GPT
    }
  });
});

describe("fallback governance — GPT intent failure never invents an intent", () => {
  it("rejects when GPT is unavailable and opt-in given but no fallback intent supplied", async () => {
    const rec = fakeCodex({ respond: () => JSON.stringify(decision()) });
    const orch = buildOrchestrator({ intentClient: null, codexClient: rec.client });
    const res = await orch.decide({
      route: "gpt56-codex",
      context: context(),
      text: "energy up",
      fallback: { onProviderFailure: "deterministic" },
    });
    expect(res.outcome).toBe("rejected");
    if (res.outcome === "rejected") expect(res.failure.code).toBe("fallback_intent_missing");
  });

  it("uses the caller-supplied fallback intent when GPT fails and opt-in given", async () => {
    const rec = fakeCodex({ respond: () => JSON.stringify(decision()) });
    const orch = buildOrchestrator({ intentClient: null, codexClient: rec.client });
    const res = await orch.decide({
      route: "gpt56-codex",
      context: context(),
      text: "energy up",
      fallback: { onProviderFailure: "deterministic", intent: validIntent },
    });
    expect(res.outcome).toBe("decided");
    if (res.outcome === "decided") {
      expect(res.decisionProvider).toBe("deterministic");
      expect(res.usedDeterministicFallback).toBe(true);
      expect(res.intent.source).toBe("caller-fallback");
      // Codex stage must not have run (the failure was at the intent stage).
      expect(res.stages.some((s) => s.stage === "codex-decision")).toBe(false);
    }
  });

  it("rejects when GPT unavailable and no opt-in at all", async () => {
    const orch = buildOrchestrator({ intentClient: null, codexClient: fakeCodex({ respond: () => "{}" }).client });
    const res = await orch.decide({ route: "gpt56-codex", context: context(), text: "energy up" });
    expect(res.outcome).toBe("rejected");
    if (res.outcome === "rejected") expect(res.failure.code).toBe("gpt_unavailable");
  });
});
