import { readFile } from "node:fs/promises";
import process from "node:process";

const protocolPath = new URL("../Vibraxis DJ Agent Protocol.md", import.meta.url);
const protocol = await readFile(protocolPath, "utf8");
const lines = protocol.split(/\r?\n/);
const errors = [];
const parsedJsonBlocks = [];

function fail(message) {
  errors.push(message);
}

function lineNumberAt(index) {
  return protocol.slice(0, index).split("\n").length;
}

function checkFencesAndJson() {
  let openFence = null;
  let fencedBody = [];

  lines.forEach((line, index) => {
    const match = line.match(/^\s*(`{3,}|~{3,})([^`]*)$/);
    if (!match) {
      if (openFence) fencedBody.push(line);
      return;
    }

    const marker = match[1];
    const markerCharacter = marker[0];
    if (!openFence) {
      openFence = {
        markerCharacter,
        markerLength: marker.length,
        language: match[2].trim().toLowerCase(),
        line: index + 1,
      };
      fencedBody = [];
      return;
    }

    const isClosingFence =
      markerCharacter === openFence.markerCharacter &&
      marker.length >= openFence.markerLength &&
      match[2].trim() === "";
    if (!isClosingFence) {
      fencedBody.push(line);
      return;
    }

    if (openFence.language === "json") {
      const raw = fencedBody.join("\n");
      try {
        const obj = JSON.parse(raw);
        parsedJsonBlocks.push({ line: openFence.line, obj });
      } catch (error) {
        fail(
          `JSON fenced block at line ${openFence.line} is invalid: ${error.message}`,
        );
      }
    }

    openFence = null;
    fencedBody = [];
  });

  if (openFence) {
    fail(
      `Unclosed ${openFence.markerCharacter.repeat(openFence.markerLength)} fence opened at line ${openFence.line}.`,
    );
  }
}

function checkConformanceTestIds() {
  const occurrences = [];
  lines.forEach((line, index) => {
    const match = line.match(/^\|\s*T(\d+)\s*\|/);
    if (match) occurrences.push({ id: Number(match[1]), line: index + 1 });
  });

  if (occurrences.length === 0) {
    fail("No conformance test IDs (T1, T2, ...) were found in a Markdown table.");
    return;
  }

  const seen = new Map();
  for (const occurrence of occurrences) {
    if (seen.has(occurrence.id)) {
      fail(
        `Duplicate conformance test ID T${occurrence.id} at lines ${seen.get(occurrence.id)} and ${occurrence.line}.`,
      );
    } else {
      seen.set(occurrence.id, occurrence.line);
    }
  }

  occurrences.forEach((occurrence, index) => {
    const expected = index + 1;
    if (occurrence.id !== expected) {
      fail(
        `Conformance test IDs must be contiguous and ordered: expected T${expected} at line ${occurrence.line}, found T${occurrence.id}.`,
      );
    }
  });
}

function checkForbiddenLegacyTerms() {
  const forbidden = [
    { pattern: /RFC\s*7386/gi, label: "legacy RFC 7386 reference" },
    { pattern: /Merge\s+Patch/gi, label: "legacy Merge Patch reference" },
    {
      pattern: /transport\.phase[^\n]{0,160}\bloading\b/gi,
      label: "transport.phase loading residue",
    },
    {
      pattern:
        /["']transport["']\s*:\s*\{[\s\S]{0,160}?["']phase["']\s*:\s*["']loading["']/gi,
      label: "transport object with phase loading",
    },
  ];

  for (const { pattern, label } of forbidden) {
    for (const match of protocol.matchAll(pattern)) {
      fail(`${label} at line ${lineNumberAt(match.index)}.`);
    }
  }
}

function paragraphs() {
  return protocol
    .split(/\r?\n\s*\r?\n/)
    .map((paragraph) => paragraph.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function requireLiteral(literal, label = literal) {
  if (!protocol.includes(literal)) {
    fail(`Missing required order-0 contract marker: ${label} (${literal}).`);
  }
}

function requireParagraph(label, patterns) {
  const found = paragraphs().some((paragraph) =>
    patterns.every((pattern) => pattern.test(paragraph)),
  );
  if (!found) {
    fail(
      `Missing required order-0 contract: ${label}. Keep its key terms together in one paragraph/table block.`,
    );
  }
}

function checkCanonicalStateStructure() {
  const candidates = parsedJsonBlocks.filter(
    (b) =>
      b.obj &&
      typeof b.obj === "object" &&
      !Array.isArray(b.obj) &&
      "revision" in b.obj &&
      "decks" in b.obj,
  );

  if (candidates.length === 0) {
    fail(
      "No canonical state JSON example found (expected object with 'revision' and 'decks').",
    );
    return;
  }

  for (const { line, obj: state } of candidates) {
    if (
      !state.intents ||
      typeof state.intents !== "object" ||
      Array.isArray(state.intents)
    ) {
      fail(
        `State JSON at line ${line}: missing or invalid top-level 'intents' map.`,
      );
    }

    if (state.decks && typeof state.decks === "object") {
      for (const [deckId, deck] of Object.entries(state.decks)) {
        if ("pendingIntents" in deck) {
          fail(
            `State JSON at line ${line}: deck ${deckId} has forbidden 'pendingIntents'.`,
          );
        }

        const pb = deck.playback;
        if (pb && typeof pb === "object") {
          for (const field of [
            "baseVelocity",
            "configuredVelocity",
            "headVelocity",
            "direction",
            "override",
          ]) {
            if (!(field in pb)) {
              fail(
                `State JSON at line ${line}: deck ${deckId}.playback missing '${field}'.`,
              );
            }
          }
        }
      }
    }

    const cf = state.mixer?.crossfader;
    if (cf && typeof cf === "object") {
      for (const field of ["base", "override", "effective", "automation"]) {
        if (!(field in cf)) {
          fail(
            `State JSON at line ${line}: mixer.crossfader missing '${field}'.`,
          );
        }
      }
    }
  }
}

function checkOrderZeroContracts() {
  requireParagraph("expectedRevision is checked only at acceptance", [
    /expectedRevision/i,
    /受理時/,
    /(?:のみ|だけ)/,
  ]);

  requireLiteral("baseVelocity");
  requireLiteral("configuredVelocity");
  requireLiteral("headVelocity");
  requireLiteral("effectiveBpm");
  requireLiteral("replacePlaying");
  requireLiteral("E_ROLE_MISMATCH");
  requireLiteral("E_DECK_PLAYING");
  requireLiteral("E_SCHEDULE_NOT_ALLOWED");

  requireParagraph("intents live in a top-level map", [
    /(?:intent|インテント)/i,
    /(?:トップレベル|ランタイム全体)/,
    /(?:map|マップ)/i,
  ]);

  requireParagraph("when is governed by an allowlist", [
    /when/i,
    /(?:allowlist|許可リスト|許可表)/i,
  ]);

  requireParagraph("uiPort has user authority", [/uiPort/, /user/i]);
  requireParagraph("agentPort has agent authority", [/agentPort/, /agent/i]);

  requireLiteral("mixer.rampCrossfader");
  for (const field of [
    '"to"',
    '"duration"',
    '"curve"',
    '"referenceDeckId"',
    "startedAtRuntimeTime",
    "endedAtRuntimeTime",
    "durationSeconds",
  ]) {
    requireLiteral(field, `rampCrossfader contract field ${field}`);
  }

  requireLiteral("RFC 6902");
  requireLiteral("staged load");
  requireLiteral('"sourcePosition"');
  requireLiteral("expectedBindingId");
  requireLiteral("E_BINDING_MISMATCH");

  requireParagraph("MessagePort does not redeliver terminal events", [
    /MessagePort/,
    /(?:再送を行わない|再送しては)/,
    /終端/,
  ]);

  requireParagraph("each intent has one logical terminal", [
    /(?:Intent|インテント)/i,
    /論理終端/,
    /1回/,
  ]);

  requireParagraph("Agent load into a playing deck is rejected by default", [
    /(?:agent|エージェント)/i,
    /(?:load|ロード)/i,
    /再生中/,
    /(?:既定|デフォルト)/,
    /拒否/,
  ]);
}

checkFencesAndJson();
checkConformanceTestIds();
checkForbiddenLegacyTerms();
checkOrderZeroContracts();
checkCanonicalStateStructure();

if (errors.length > 0) {
  console.error(`Protocol document check failed with ${errors.length} error(s):`);
  for (const [index, error] of errors.entries()) {
    console.error(`  ${index + 1}. ${error}`);
  }
  process.exitCode = 1;
} else {
  console.log(
    `Protocol document check passed: JSON fences, Markdown fences, T1-T${
      lines.filter((line) => /^\|\s*T\d+\s*\|/.test(line)).length
    }, legacy terms, order-0 contracts, and canonical state structure.`,
  );
}
