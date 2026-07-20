import { describe, expect, it } from "vitest";

import {
  buildOrchestrator,
  context,
  decision,
  delayed,
  delayedIgnoringSignal,
  fakeCodex,
  fakeIntentClient,
  fastConfig,
  intent,
} from "./fixtures.ts";

describe("timeouts and late results", () => {
  it("codex-local: a slow Codex call times out and rejects promptly", async () => {
    const rec = fakeCodex({
      respond: (_input, _opts) => delayed(JSON.stringify(decision()), 500),
    });
    const orch = buildOrchestrator({ codexClient: rec.client, config: fastConfig(30) });
    const res = await orch.decide({ route: "codex-local", context: context(), intent: intent() });
    expect(res.outcome).toBe("rejected");
    if (res.outcome === "rejected") expect(res.failure.code).toBe("codex_timeout");
  });

  it("codex-local: a LATE valid decision (signal ignored) is never applied", async () => {
    // Fake ignores the abort and would return a perfectly valid decision late.
    const rec = fakeCodex({
      respond: () => delayedIgnoringSignal(JSON.stringify(decision()), 120),
    });
    const orch = buildOrchestrator({ codexClient: rec.client, config: fastConfig(20) });
    const res = await orch.decide({ route: "codex-local", context: context(), intent: intent() });
    expect(res.outcome).toBe("rejected");
    if (res.outcome === "rejected") expect(res.failure.code).toBe("codex_timeout");
    // Give the late resolution time to fire; it must not affect anything.
    await new Promise((r) => setTimeout(r, 150));
    expect(res.outcome).toBe("rejected");
  });

  it("codex-local: timeout with opt-in falls back to deterministic", async () => {
    const rec = fakeCodex({ respond: () => delayed(JSON.stringify(decision()), 500) });
    const orch = buildOrchestrator({ codexClient: rec.client, config: fastConfig(30) });
    const res = await orch.decide({
      route: "codex-local",
      context: context(),
      intent: intent(),
      fallback: { onProviderFailure: "deterministic" },
    });
    expect(res.outcome).toBe("decided");
    if (res.outcome === "decided") {
      expect(res.decisionProvider).toBe("deterministic");
      expect(res.usedDeterministicFallback).toBe(true);
    }
  });

  it("gpt56-codex: GPT timeout rejects (cannot invent an intent) without a fallback intent", async () => {
    const intentClient = fakeIntentClient({
      respond: () => delayed({ text: "{}", model: "gpt-5.6-sol" }, 500),
    });
    const rec = fakeCodex({ respond: () => JSON.stringify(decision()) });
    const orch = buildOrchestrator({ intentClient, codexClient: rec.client, config: fastConfig(30) });
    const res = await orch.decide({ route: "gpt56-codex", context: context(), text: "energy up" });
    expect(res.outcome).toBe("rejected");
    if (res.outcome === "rejected") expect(res.failure.code).toBe("gpt_timeout");
  });
});

describe("total request deadline", () => {
  it("shares one deadline across GPT and Codex instead of granting it twice", async () => {
    const intentClient = fakeIntentClient({
      respond: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { text: JSON.stringify(intent()), model: "gpt-5.6-sol" };
      },
    });
    const rec = fakeCodex({
      respond: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return JSON.stringify(decision());
      },
    });
    const orch = buildOrchestrator({ intentClient, codexClient: rec.client });
    const startedAt = Date.now();
    const res = await orch.decide({
      route: "gpt56-codex",
      context: context(),
      text: "increase",
      deadlineMs: 30,
    });
    expect(Date.now() - startedAt).toBeLessThan(50);
    expect(res.outcome).toBe("rejected");
    if (res.outcome === "rejected") expect(res.failure.code).toBe("codex_timeout");
  });
});
