import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

import Ajv2020 from "ajv/dist/2020.js";

const root = new URL("../../", import.meta.url);

async function readJson(relativePath) {
  return JSON.parse(await readFile(new URL(relativePath, root), "utf8"));
}

const [
  analysisSchema,
  intentSchema,
  decisionSchema,
  deckLoadSchema,
  rampSchema,
] =
  await Promise.all([
    readJson("analyze-tool/analysis.schema.json"),
    readJson("shared/dj/intent.schema.json"),
    readJson("shared/dj/decision.schema.json"),
    readJson("shared/vdap/deck-load.schema.json"),
    readJson("shared/vdap/ramp-crossfader.schema.json"),
  ]);

const analysisFileNames = (await readdir(new URL("data/analysis/", root)))
  .filter((name) => name.endsWith(".json"))
  .sort();
const analysisFixtures = await Promise.all(
  analysisFileNames.map((name) => readJson(`data/analysis/${name}`)),
);

const ajv = new Ajv2020({ allErrors: true, strict: true });
const validateAnalysis = ajv.compile(analysisSchema);
const validateIntent = ajv.compile(intentSchema);
const validateDecision = ajv.compile(decisionSchema);
const validateDeckLoad = ajv.compile(deckLoadSchema);
const validateRamp = ajv.compile(rampSchema);

const validIntent = {
  energyDirection: "increase",
  targetEnergy: 0.8,
  preferredGenres: ["house"],
  avoidedGenres: [],
  preferredMoods: ["uplifting"],
  avoidedMoods: [],
  tempoDirection: "similar",
  harmonicPriority: "compatible",
  transitionUrgency: "gradual",
  requestedTrackId: null,
  excludedTrackIds: [],
  rationale: "Raise the room energy without a tempo jump.",
  confidence: 0.86,
};

const validDecision = {
  nextTrackId: "127_long_bpm155",
  targetDeckId: "B",
  tempoSync: "tempo",
  startAt: "nextBar",
  crossfadeBars: 8,
  confidence: 0.82,
  reasons: ["Compatible energy and a usable beat grid."],
};

test("the analyzer-owned Analysis v2 schema accepts every catalog fixture", () => {
  assert.ok(analysisFixtures.length > 0);
  for (const fixture of analysisFixtures) {
    assert.equal(validateAnalysis(fixture), true, ajv.errorsText(validateAnalysis.errors));
  }
});

test("Analysis v2 rejects incompatible versions and tempo adjustments", () => {
  const wrongVersion = structuredClone(analysisFixtures[0]);
  wrongVersion.schemaVersion = 1;
  assert.equal(validateAnalysis(wrongVersion), false);

  const wrongAdjustment = structuredClone(analysisFixtures[0]);
  wrongAdjustment.tempo.adjustment = "quarter";
  assert.equal(validateAnalysis(wrongAdjustment), false);
});

test("DjIntent schema accepts bounded high-level intent", () => {
  assert.equal(validateIntent(validIntent), true, ajv.errorsText(validateIntent.errors));
});

test("DjIntent schema rejects unsafe or malformed output", () => {
  for (const invalid of [
    { ...validIntent, confidence: 1.1 },
    { ...validIntent, url: "https://example.invalid/audio.wav" },
    { ...validIntent, rationale: "" },
    (({ confidence: _missing, ...rest }) => rest)(validIntent),
  ]) {
    assert.equal(validateIntent(invalid), false);
  }
});

test("DjDecision schema accepts a golden-path decision", () => {
  assert.equal(
    validateDecision(validDecision),
    true,
    ajv.errorsText(validateDecision.errors),
  );
});

test("DjDecision rejects low-level commands and unsupported transitions", () => {
  for (const invalid of [
    { ...validDecision, commands: [{ command: "deck.play" }] },
    { ...validDecision, tempoSync: "tempoPhase" },
    { ...validDecision, startAt: "immediate" },
    { ...validDecision, crossfadeBars: 0 },
    (({ reasons: _missing, ...rest }) => rest)(validDecision),
  ]) {
    assert.equal(validateDecision(invalid), false);
  }
});

test("deck.load schema accepts catalog staging and rejects unsafe sources", () => {
  const valid = {
    vdap: "1.0",
    kind: "request",
    requestId: "load-1",
    command: "deck.load",
    params: {
      deckId: "B",
      source: { kind: "catalog", trackId: "127_long_bpm155" },
      requireAnalysis: true,
    },
  };
  assert.equal(validateDeckLoad(valid), true, ajv.errorsText(validateDeckLoad.errors));
  assert.equal(
    validateDeckLoad({
      ...valid,
      params: {
        ...valid.params,
        source: { kind: "url", url: "https://example.invalid/audio.wav" },
      },
    }),
    false,
  );
  assert.equal(validateDeckLoad({ ...valid, when: { at: "nextBar" } }), false);
  assert.equal(
    validateDeckLoad({
      ...valid,
      params: { ...valid.params, replacePlaying: true },
    }),
    false,
  );
});

test("rampCrossfader schema enforces duration shape and beat reference", () => {
  const valid = {
    vdap: "1.0",
    kind: "request",
    requestId: "ramp-1",
    command: "mixer.rampCrossfader",
    params: {
      to: 1,
      duration: { bars: 2 },
      curve: "equalPower",
      referenceDeckId: "A",
    },
    when: { at: "nextBar", deckId: "A" },
  };
  assert.equal(validateRamp(valid), true, ajv.errorsText(validateRamp.errors));
  assert.equal(
    validateRamp({
      ...valid,
      params: { ...valid.params, duration: { bars: 2, seconds: 4 } },
    }),
    false,
  );
  const { referenceDeckId: _omitted, ...withoutReference } = valid.params;
  assert.equal(validateRamp({ ...valid, params: withoutReference }), false);
  assert.equal(validateRamp({ ...valid, when: { at: "nextBar" } }), false);
});
