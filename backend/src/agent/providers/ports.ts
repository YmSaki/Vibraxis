/**
 * Narrow ports for the external model clients. Providers depend on these
 * interfaces (constructor-injected), never on the concrete SDK classes, so
 * unit tests inject fakes and consume no network or model quota. The real SDKs
 * are adapted to these ports by the `*ClientFactory` modules, which are the
 * only files that import `openai` / `@openai/codex-sdk` at runtime.
 */

/** The exact subset of Codex `ThreadOptions` we set. Mirrors the SDK types. */
export interface CodexThreadOptions {
  workingDirectory: string;
  sandboxMode: "read-only";
  networkAccessEnabled: false;
  webSearchEnabled: false;
  webSearchMode: "disabled";
  approvalPolicy: "never";
  skipGitRepoCheck: false;
  model?: string;
  modelReasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh";
}

export interface CodexTurnResult {
  /** Final agent message. Contains JSON when `outputSchema` is provided. */
  finalResponse: string;
}

export interface CodexThreadPort {
  run(
    input: string,
    options: { outputSchema?: unknown; signal?: AbortSignal },
  ): Promise<CodexTurnResult>;
}

export interface CodexClientPort {
  startThread(options: CodexThreadOptions): CodexThreadPort;
}

/** Parameters for a single structured-output intent request to the LLM. */
export interface IntentModelRequest {
  /** Exact public model id (preserved, never substituted by this layer). */
  model: string;
  systemPrompt: string;
  userText: string;
  schemaName: string;
  schema: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface IntentModelResult {
  /** Raw model text (expected to be JSON). Validated by the caller. */
  text: string;
  /** The model id the API reports having actually used. */
  model: string;
}

export interface IntentModelClientPort {
  createStructuredIntent(request: IntentModelRequest): Promise<IntentModelResult>;
}
