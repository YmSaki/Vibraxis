/**
 * Adapts the real Codex SDK (@openai/codex-sdk@0.144.6) to `CodexClientPort`.
 *
 * The SDK spawns the locally-installed Codex CLI as a child process and reuses
 * the user's saved `codex login` (Sign in with ChatGPT). We never read, copy,
 * or log `~/.codex/auth.json`; authentication is entirely the CLI's concern.
 * `apiKey` is deliberately NOT passed, so the SDK does not inject a key and the
 * CLI uses its saved ChatGPT credentials. Server-side only — never bundled.
 *
 * The thread options set here are only those the installed TypeScript types
 * expose, at the least capability: read-only sandbox, no network, no web
 * search, non-interactive approval. No `as any` is used.
 */

import { Codex, type ThreadOptions } from "@openai/codex-sdk";

import type {
  CodexClientPort,
  CodexThreadOptions,
  CodexThreadPort,
} from "./ports.ts";

export function createCodexClient(): CodexClientPort {
  // No apiKey: the SDK will not inject CODEX_API_KEY and the spawned CLI uses
  // the saved ChatGPT login.
  const codex = new Codex();
  return {
    startThread(options: CodexThreadOptions): CodexThreadPort {
      // CodexThreadOptions is a strict subset of the SDK's ThreadOptions; this
      // assignment is type-checked, not forced.
      const threadOptions: ThreadOptions = options;
      const thread = codex.startThread(threadOptions);
      return {
        async run(input, runOptions) {
          const turn = await thread.run(input, runOptions);
          return { finalResponse: turn.finalResponse };
        },
      };
    },
  };
}
