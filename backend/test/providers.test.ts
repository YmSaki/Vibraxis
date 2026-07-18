import { describe, expect, it } from "vitest";

import { CodexLocalProvider } from "../src/agent/providers/codexLocal.ts";
import { DeterministicProvider } from "../src/agent/providers/deterministic.ts";
import { Gpt56IntentProvider } from "../src/agent/providers/gpt56Intent.ts";
import intentSchema from "@vibraxis/shared/dj/intent.schema.json" with { type: "json" };
import decisionSchema from "@vibraxis/shared/dj/decision.schema.json" with { type: "json" };
import { context, decision, fakeCodex, fakeIntentClient, intent } from "./fixtures.ts";

describe("DeterministicProvider", () => {
  it("is deterministic: same input yields identical output", () => {
    const p = new DeterministicProvider();
    const a = p.decide(context(), intent());
    const b = p.decide(context(), intent());
    expect(a).toEqual(b);
    expect(a.status).toBe("selected");
    if (a.status === "selected") expect(a.decision.nextTrackId).toBe("t2");
  });

  it("returns noCandidate (never a fabricated decision) when nothing is eligible", () => {
    const p = new DeterministicProvider();
    const result = p.decide(context({ candidates: [] }), intent());
    expect(result.status).toBe("noCandidate");
    if (result.status === "noCandidate") {
      expect(result.reasons[0]!.code).toBe("emptyCandidateSet");
    }
  });

  it("shortlists eligible ids up to the configured size", () => {
    const p = new DeterministicProvider();
    const { rankedEligibleIds } = p.shortlist(context(), intent(), 5);
    expect(rankedEligibleIds).toEqual(["t2"]); // t3 excluded (rate out of range)
  });
});

describe("Gpt56IntentProvider", () => {
  it("passes the exact configured model id through and returns raw text", async () => {
    let seenModel = "";
    const client = fakeIntentClient({
      respond: (req) => {
        seenModel = req.model;
        return { text: JSON.stringify(intent()), model: "gpt-5.6" };
      },
    });
    const provider = new Gpt56IntentProvider(client, { model: "gpt-5.6" });
    const result = await provider.interpret(
      { text: "more energy", context: context() },
      intentSchema as Record<string, unknown>,
      new AbortController().signal,
    );
    expect(seenModel).toBe("gpt-5.6");
    expect(result.reportedModel).toBe("gpt-5.6");
    expect(JSON.parse(result.rawText).energyDirection).toBe("increase");
  });
});

describe("CodexLocalProvider", () => {
  it("uses the least-capability read-only thread options and passes the schema", async () => {
    const rec = fakeCodex({ respond: () => JSON.stringify(decision()) });
    const provider = new CodexLocalProvider(rec.client, { workingDirectory: "/repo" });
    const signal = new AbortController().signal;
    const result = await provider.decide(context(), intent(), ["t2"], decisionSchema, signal);

    expect(JSON.parse(result.rawText).nextTrackId).toBe("t2");
    const opts = rec.lastThreadOptions();
    expect(opts).toMatchObject({
      workingDirectory: "/repo",
      sandboxMode: "read-only",
      networkAccessEnabled: false,
      webSearchEnabled: false,
      webSearchMode: "disabled",
      approvalPolicy: "never",
      skipGitRepoCheck: false,
    });
    const run = rec.lastRunOptions();
    expect(run?.outputSchema).toBe(decisionSchema);
    expect(run?.signal).toBe(signal);
  });
});
