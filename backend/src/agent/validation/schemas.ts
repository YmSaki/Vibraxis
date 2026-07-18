/**
 * JSON Schema validation for the two payloads that cross the boundary as raw
 * JSON from an AI: the GPT-5.6 intent and the Codex decision. We validate the
 * *actual* schemas shipped in @vibraxis/shared, so the contract is
 * machine-verifiable and shared with the frontend/contract tests.
 *
 * These validators reject non-conforming output unchanged. They never coerce,
 * clamp, or drop fields to make an invalid payload pass (AGENTS.md §0.3).
 */

import Ajv2020 from "ajv/dist/2020.js";

import intentSchema from "@vibraxis/shared/dj/intent.schema.json" with { type: "json" };
import decisionSchema from "@vibraxis/shared/dj/decision.schema.json" with { type: "json" };

export type SchemaValidation<T> =
  | { ok: true; value: T }
  | { ok: false; errors: string[] };

// `strict: true` mirrors shared/contracts/schemas.test.mjs so the compiled
// schema is identical to what the contract suite exercises.
const ajv = new Ajv2020({ allErrors: true, strict: true });
const validateIntent = ajv.compile(intentSchema as Record<string, unknown>);
const validateDecision = ajv.compile(decisionSchema as Record<string, unknown>);

function formatErrors(errors: typeof validateIntent.errors): string[] {
  if (!errors) return ["unknown schema error"];
  return errors.map((e) => `${e.instancePath || "/"} ${e.message ?? "invalid"}`.trim());
}

/** Validates arbitrary parsed JSON against the DjIntent schema. */
export function validateIntentSchema<T>(value: unknown): SchemaValidation<T> {
  if (validateIntent(value)) return { ok: true, value: value as T };
  return { ok: false, errors: formatErrors(validateIntent.errors) };
}

/** Validates arbitrary parsed JSON against the DjDecision schema. */
export function validateDecisionSchema<T>(value: unknown): SchemaValidation<T> {
  if (validateDecision(value)) return { ok: true, value: value as T };
  return { ok: false, errors: formatErrors(validateDecision.errors) };
}
