import { describe, expect, it } from "vitest";

import {
  buildOrchestrator,
  context,
  decision,
  fakeCodex,
  fakeIntentClient,
  intent,
} from "./fixtures.ts";
import { DEFAULT_AGENT_CONFIG } from "../src/agent/config.ts";
import { track } from "./fixtures.ts";

describe("deterministic route", () => {
  it("returns a deterministic decision labelled as the deterministic provider", async () => {
    const orch = buildOrchestrator();
    const res = await orch.decide({ route: "deterministic", context: context(), intent: intent() });
    expect(res.outcome).toBe("decided");
    if (res.outcome === "decided") {
      expect(res.requestedRoute).toBe("deterministic");
      expect(res.decisionProvider).toBe("deterministic");
      expect(res.usedDeterministicFallback).toBe(false);
      expect(res.intent.source).toBe("caller");
      expect(res.decision.nextTrackId).toBe("t2");
      expect(res.stages.map((s) => s.stage)).toEqual(["deterministic-selection"]);
    }
  });

  it("is stable across repeated calls", async () => {
    const orch = buildOrchestrator();
    const a = await orch.decide({ route: "deterministic", context: context(), intent: intent() });
    const b = await orch.decide({ route: "deterministic", context: context(), intent: intent() });
    expect(a).toEqual(b);
  });

  it("rejects with no_candidate when nothing is eligible", async () => {
    const orch = buildOrchestrator();
    const res = await orch.decide({ route: "deterministic", context: context({ candidates: [] }), intent: intent() });
    expect(res.outcome).toBe("rejected");
    if (res.outcome === "rejected") expect(res.failure.code).toBe("no_candidate");
  });

  it("rejects a structurally invalid intent", async () => {
    const orch = buildOrchestrator();
    const res = await orch.decide({
      route: "deterministic",
      context: context(),
      // confidence out of [0,1]
      intent: { ...intent(), confidence: 5 },
    });
    expect(res.outcome).toBe("rejected");
    if (res.outcome === "rejected") expect(res.failure.code).toBe("invalid_intent");
  });
});

describe("codex-local route", () => {
  it("returns a Codex decision with both stages recorded", async () => {
    const rec = fakeCodex({ respond: () => JSON.stringify(decision()) });
    const orch = buildOrchestrator({ codexClient: rec.client });
    const res = await orch.decide({ route: "codex-local", context: context(), intent: intent() });
    expect(res.outcome).toBe("decided");
    if (res.outcome === "decided") {
      expect(res.decisionProvider).toBe("codex-local");
      expect(res.usedDeterministicFallback).toBe(false);
      expect(res.intent.source).toBe("caller");
      expect(res.stages.map((s) => s.stage)).toEqual(["deterministic-selection", "codex-decision"]);
    }
  });

  it("rejects an invalid Codex decision unchanged (semantic)", async () => {
    // Codex returns a decision targeting the ACTIVE deck: rejected, not corrected.
    const rec = fakeCodex({ respond: () => JSON.stringify(decision({ targetDeckId: "A" })) });
    const orch = buildOrchestrator({ codexClient: rec.client });
    const res = await orch.decide({ route: "codex-local", context: context(), intent: intent() });
    expect(res.outcome).toBe("rejected");
    if (res.outcome === "rejected") {
      expect(res.failure.code).toBe("decision_semantic_invalid");
      expect(res.failure.semanticCodes).toContain("targetDeckNotInactive");
    }
  });

  it("rejects non-JSON Codex output", async () => {
    const rec = fakeCodex({ respond: () => "I think we should play something upbeat!" });
    const orch = buildOrchestrator({ codexClient: rec.client });
    const res = await orch.decide({ route: "codex-local", context: context(), intent: intent() });
    expect(res.outcome).toBe("rejected");
    if (res.outcome === "rejected") expect(res.failure.code).toBe("decision_not_json");
  });

  it("rejects when Codex is unavailable and no fallback was requested", async () => {
    const orch = buildOrchestrator({ codexClient: null });
    const res = await orch.decide({ route: "codex-local", context: context(), intent: intent() });
    expect(res.outcome).toBe("rejected");
    if (res.outcome === "rejected") expect(res.failure.code).toBe("codex_unavailable");
  });

  it("rejects a valid full-context candidate that was not disclosed in the Codex shortlist", async () => {
    const rec = fakeCodex({ respond: () => JSON.stringify(decision({ nextTrackId: "t4" })) });
    const orch = buildOrchestrator({
      codexClient: rec.client,
      config: { ...DEFAULT_AGENT_CONFIG, codexCandidateShortlist: 1 },
    });
    const res = await orch.decide({
      route: "codex-local",
      context: context({ candidates: [
        track({ trackId: "t2", bpm: 126, camelot: "8A", energy: 0.6 }),
        track({ trackId: "t4", bpm: 125, camelot: "8A", energy: 0.55 }),
      ] }),
      intent: intent(),
    });
    expect(res.outcome).toBe("rejected");
    if (res.outcome === "rejected") {
      expect(res.failure.code).toBe("decision_not_shortlisted");
      expect(res.failure.semanticCodes).toEqual(["nextTrackNotShortlisted"]);
    }
  });

  it("keeps an explicitly requested selected track in a one-track Codex shortlist", async () => {
    const rec = fakeCodex({ respond: () => JSON.stringify(decision({ nextTrackId: "t4" })) });
    const orch = buildOrchestrator({
      codexClient: rec.client,
      config: { ...DEFAULT_AGENT_CONFIG, codexCandidateShortlist: 1 },
    });
    const res = await orch.decide({
      route: "codex-local",
      context: context({ candidates: [
        track({ trackId: "t2", bpm: 126, camelot: "8A", energy: 0.6 }),
        track({ trackId: "t4", bpm: 126, camelot: "3B", energy: 0.6 }),
      ] }),
      intent: intent({ requestedTrackId: "t4", harmonicPriority: "strict" }),
    });
    expect(res.outcome).toBe("decided");
    if (res.outcome === "decided") expect(res.decision.nextTrackId).toBe("t4");
  });

  it("rejects a Codex choice that ignores an explicit requestedTrackId", async () => {
    const rec = fakeCodex({ respond: () => JSON.stringify(decision({ nextTrackId: "t2" })) });
    const orch = buildOrchestrator({ codexClient: rec.client });
    const res = await orch.decide({
      route: "codex-local",
      context: context({ candidates: [
        track({ trackId: "t2", bpm: 126, camelot: "8A", energy: 0.6 }),
        track({ trackId: "t4", bpm: 126, camelot: "8A", energy: 0.6 }),
      ] }),
      intent: intent({ requestedTrackId: "t4" }),
    });
    expect(res.outcome).toBe("rejected");
    if (res.outcome === "rejected") {
      expect(res.failure.code).toBe("decision_semantic_invalid");
      expect(res.failure.semanticCodes).toEqual(["requestedTrackNotHonored"]);
    }
  });
});

describe("gpt56-codex route", () => {
  it("chains GPT-5.6 intent -> Codex decision and attributes both stages", async () => {
    const intentClient = fakeIntentClient({
      respond: () => ({ text: JSON.stringify(intent({ energyDirection: "increase" })), model: "gpt-5.6" }),
    });
    const rec = fakeCodex({ respond: () => JSON.stringify(decision()) });
    const orch = buildOrchestrator({ intentClient, codexClient: rec.client });
    const res = await orch.decide({ route: "gpt56-codex", context: context(), text: "raise the energy" });
    expect(res.outcome).toBe("decided");
    if (res.outcome === "decided") {
      expect(res.decisionProvider).toBe("codex-local");
      expect(res.intent.source).toBe("gpt-5.6");
      expect(res.usedDeterministicFallback).toBe(false);
      expect(res.stages.map((s) => s.stage)).toEqual([
        "gpt56-intent",
        "deterministic-selection",
        "codex-decision",
      ]);
      expect(res.stages.every((s) => s.status === "succeeded")).toBe(true);
    }
  });

  it("rejects a fabricated GPT intent (requestedTrackId not a candidate) unchanged", async () => {
    const intentClient = fakeIntentClient({
      respond: () => ({ text: JSON.stringify(intent({ requestedTrackId: "ghost" })), model: "gpt-5.6" }),
    });
    const rec = fakeCodex({ respond: () => JSON.stringify(decision()) });
    const orch = buildOrchestrator({ intentClient, codexClient: rec.client });
    const res = await orch.decide({ route: "gpt56-codex", context: context(), text: "play ghost" });
    expect(res.outcome).toBe("rejected");
    if (res.outcome === "rejected") expect(res.failure.code).toBe("intent_semantic_invalid");
  });

  it("rejects when text is missing", async () => {
    const orch = buildOrchestrator({ intentClient: fakeIntentClient({ respond: () => ({ text: "{}", model: "gpt-5.6" }) }) });
    const res = await orch.decide({ route: "gpt56-codex", context: context(), text: "" });
    expect(res.outcome).toBe("rejected");
    if (res.outcome === "rejected") expect(res.failure.code).toBe("invalid_request");
  });

  it("rejects a response attributed to a different GPT model", async () => {
    const intentClient = fakeIntentClient({
      respond: () => ({ text: JSON.stringify(intent()), model: "gpt-5.6-alias" }),
    });
    const orch = buildOrchestrator({
      intentClient,
      codexClient: fakeCodex({ respond: () => JSON.stringify(decision()) }).client,
    });
    const res = await orch.decide({ route: "gpt56-codex", context: context(), text: "raise the energy" });
    expect(res.outcome).toBe("rejected");
    if (res.outcome === "rejected") expect(res.failure.code).toBe("gpt_model_mismatch");
  });
});
