import { describe, expect, it } from "vitest";

import { assertAgentConfig, DEFAULT_AGENT_CONFIG } from "../src/agent/config.ts";

import { validateContext } from "../src/agent/validation/context.ts";
import {
  validateDecisionSchema,
  validateIntentSchema,
} from "../src/agent/validation/schemas.ts";
import {
  validateDecisionSemantics,
  validateIntentSemantics,
} from "../src/agent/validation/semantic.ts";
import { context, decision, intent } from "./fixtures.ts";

describe("schema validation", () => {
  it("accepts a well-formed intent and decision", () => {
    expect(validateIntentSchema(intent()).ok).toBe(true);
    expect(validateDecisionSchema(decision()).ok).toBe(true);
  });

  it("rejects an intent with an out-of-range confidence, unchanged", () => {
    const bad = { ...intent(), confidence: 1.5 };
    const result = validateIntentSchema(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.length).toBeGreaterThan(0);
    // The invalid value is not mutated by the validator.
    expect(bad.confidence).toBe(1.5);
  });

  it("rejects a decision with an unknown extra field", () => {
    const bad = { ...decision(), somethingElse: true };
    expect(validateDecisionSchema(bad).ok).toBe(false);
  });

  it("rejects a decision with crossfadeBars above the schema maximum", () => {
    expect(validateDecisionSchema({ ...decision(), crossfadeBars: 999 }).ok).toBe(false);
  });
});

describe("agent configuration", () => {
  it("accepts the published default configuration", () => {
    expect(() => assertAgentConfig(DEFAULT_AGENT_CONFIG)).not.toThrow();
  });

  it.each([0, -1, 1.5, Number.NaN])(
    "rejects an invalid Codex shortlist size (%s) instead of changing its meaning",
    (codexCandidateShortlist) => {
      expect(() => assertAgentConfig({ ...DEFAULT_AGENT_CONFIG, codexCandidateShortlist })).toThrow(
        "config.codexCandidateShortlist must be null or a positive integer",
      );
    },
  );

  it("rejects duplicate enabled routes", () => {
    expect(() => assertAgentConfig({
      ...DEFAULT_AGENT_CONFIG,
      routes: ["deterministic", "deterministic"],
    })).toThrow("config.routes must contain unique supported routes");
  });

  it("rejects a model id that would make fixed GPT-5.6 provenance untruthful", () => {
    expect(() => assertAgentConfig({
      ...DEFAULT_AGENT_CONFIG,
      gpt56: { ...DEFAULT_AGENT_CONFIG.gpt56, model: "gpt-5.6-custom" },
    })).toThrow('config.gpt56.model must be exactly "gpt-5.6"');
  });
});

describe("context boundary", () => {
  it("rejects an undisclosed context field instead of ignoring it", () => {
    const result = validateContext({ ...context(), hiddenConstraint: true });
    expect(result).toEqual({ ok: false, detail: "context contains unexpected field: hiddenConstraint" });
  });

  it("rejects an undisclosed candidate field instead of ignoring it", () => {
    const base = context();
    const result = validateContext({
      ...base,
      candidates: [{ ...base.candidates[0], secretScore: 1 }],
    });
    expect(result).toEqual({
      ok: false,
      detail: "context.candidates[0] contains unexpected field: secretScore",
    });
  });

  it("rejects an undisclosed runtime limit instead of ignoring it", () => {
    const base = context();
    const result = validateContext({ ...base, limits: { ...base.limits, autoClamp: true } });
    expect(result).toEqual({
      ok: false,
      detail: "context.limits contains unexpected field: autoClamp",
    });
  });
});

describe("context validation", () => {
  it("accepts a valid context", () => {
    expect(validateContext(context())).toEqual({ ok: true });
  });

  it("rejects identical active/inactive decks", () => {
    const result = validateContext({ ...context(), inactiveDeckId: "A" });
    expect(result.ok).toBe(false);
  });

  it("rejects duplicate candidate ids", () => {
    const c = context();
    const result = validateContext({
      ...c,
      candidates: [c.candidates[0]!, c.candidates[0]!],
    });
    expect(result.ok).toBe(false);
  });
});

describe("intent semantic validation", () => {
  it("accepts a null requestedTrackId", () => {
    expect(validateIntentSemantics(intent(), context()).ok).toBe(true);
  });

  it("accepts a requestedTrackId that is a candidate", () => {
    expect(validateIntentSemantics(intent({ requestedTrackId: "t2" }), context()).ok).toBe(true);
  });

  it("rejects a fabricated requestedTrackId", () => {
    const result = validateIntentSemantics(intent({ requestedTrackId: "ghost" }), context());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0]!.code).toBe("requestedTrackNotCandidate");
  });

  it("rejects fabricated excludedTrackIds", () => {
    const result = validateIntentSemantics(intent({ excludedTrackIds: ["ghost"] }), context());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0]!.code).toBe("excludedTrackNotCandidate");
  });
});

describe("decision semantic validation", () => {
  it("accepts a valid decision", () => {
    expect(validateDecisionSemantics(decision(), context()).ok).toBe(true);
  });

  it("rejects a nextTrackId that is not a candidate", () => {
    const result = validateDecisionSemantics(decision({ nextTrackId: "ghost" }), context());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.some((i) => i.code === "nextTrackNotCandidate")).toBe(true);
  });

  it("rejects the active deck as target", () => {
    const result = validateDecisionSemantics(decision({ targetDeckId: "A" }), context());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.some((i) => i.code === "targetDeckNotInactive")).toBe(true);
  });

  it("rejects a crossfadeBars not in the allow-list (never snaps it)", () => {
    // 6 is a valid schema integer (1..32) but not an allowed bar count.
    const result = validateDecisionSemantics(decision({ crossfadeBars: 6 }), context());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.some((i) => i.code === "crossfadeBarsNotAllowed")).toBe(true);
  });

  it("rejects a tempo-sync decision whose exact rate is out of range", () => {
    // current 128 / candidate 200 = 0.64, below minPlaybackRate 0.9.
    const c = context({
      candidates: [
        { ...context().candidates[0]!, trackId: "slow", bpm: 200 },
      ],
    });
    const result = validateDecisionSemantics(decision({ nextTrackId: "slow" }), c);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.some((i) => i.code === "tempoRateOutOfRange")).toBe(true);
  });

  it("rejects a nextBar/tempo decision when the next track has no beat grid", () => {
    const c = context({
      candidates: [
        { ...context().candidates[0]!, trackId: "nogrid", hasBeatGrid: false },
      ],
    });
    const result = validateDecisionSemantics(decision({ nextTrackId: "nogrid" }), c);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.some((i) => i.code === "beatGridMissing")).toBe(true);
  });
});
