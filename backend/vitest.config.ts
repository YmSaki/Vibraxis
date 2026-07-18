import { defineConfig } from "vitest/config";

/**
 * Default test run: fast, hermetic unit tests only. Smoke tests (which may spawn
 * the Codex CLI or call the live OpenAI API) live under test/smoke and are
 * excluded here; run them explicitly with `npm run test:smoke`.
 */
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["test/smoke/**", "node_modules/**"],
  },
});
