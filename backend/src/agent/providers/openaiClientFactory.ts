/**
 * Adapts the real OpenAI JS SDK (openai@6.48.0) to `IntentModelClientPort`.
 *
 * This is one of the only two modules that import an external model SDK at
 * runtime; unit tests never import it, so they consume no network or quota. The
 * SDK must stay server-side (never bundled into the browser).
 *
 * We request Structured Output via `response_format: { type: "json_schema" }`
 * as steering, but we DO NOT rely on it: the orchestrator re-validates the raw
 * output against the shared schema and rejects anything non-conforming.
 */

import OpenAI from "openai";

import type {
  IntentModelClientPort,
  IntentModelRequest,
  IntentModelResult,
} from "./ports.ts";

/** Builds a live intent client. Caller passes the API key explicitly. */
export function createOpenAiIntentClient(apiKey: string): IntentModelClientPort {
  const client = new OpenAI({ apiKey });
  return {
    async createStructuredIntent(request: IntentModelRequest): Promise<IntentModelResult> {
      const completion = await client.chat.completions.create(
        {
          model: request.model,
          messages: [
            { role: "system", content: request.systemPrompt },
            { role: "user", content: request.userText },
          ],
          response_format: {
            type: "json_schema",
            json_schema: {
              name: request.schemaName,
              // `strict: false` because the shared schema uses keywords (minItems,
              // maxLength, ...) outside strict Structured Outputs' subset. Authority
              // is the orchestrator's own validation, not the API's strict mode.
              strict: false,
              schema: request.schema,
            },
          },
        },
        request.signal ? { signal: request.signal } : undefined,
      );
      const text = completion.choices[0]?.message?.content ?? "";
      // `completion.model` is the exact model id the API reports having used.
      return { text, model: completion.model };
    },
  };
}

/**
 * Returns a live client when `OPENAI_API_KEY` is present, else null (so the
 * capability endpoint can report GPT-5.6 as unavailable without throwing).
 */
export function tryCreateOpenAiIntentClient(
  env: Record<string, string | undefined>,
): IntentModelClientPort | null {
  const apiKey = env.OPENAI_API_KEY;
  if (apiKey === undefined || apiKey.length === 0) return null;
  return createOpenAiIntentClient(apiKey);
}
