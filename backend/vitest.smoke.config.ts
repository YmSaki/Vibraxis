import { defineConfig } from "vitest/config";

/**
 * Live smoke tests. These may spawn the local Codex CLI (using the user's saved
 * `codex login`) or call the live OpenAI API, and can consume model quota. They
 * are opt-in and skip themselves when the relevant provider is unavailable.
 */
export default defineConfig({
  test: {
    include: ["test/smoke/**/*.test.ts"],
    // Live calls can be slow; give them room without hanging unit runs.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
