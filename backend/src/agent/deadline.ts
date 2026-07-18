/**
 * Deadline enforcement with explicit late-result invalidation.
 *
 * The installed @openai/codex-sdk exposes `TurnOptions.signal` and the OpenAI
 * SDK accepts an AbortSignal, so we pass a real abort signal (best-effort
 * cancellation). We do NOT assume the abort actually terminates the underlying
 * CLI child process or HTTP request. Therefore, independently of the signal,
 * once the deadline fires the result is invalidated by generation: any value
 * that resolves afterwards is dropped and never applied. This is why we never
 * claim a child process was "cancelled" — only that its late result was
 * invalidated.
 */

export type DeadlineResult<T> =
  | { status: "ok"; value: T; durationMs: number }
  | { status: "timeout"; durationMs: number }
  | { status: "error"; error: unknown; durationMs: number };

export interface WithDeadlineOptions {
  timeoutMs: number;
  /**
   * Invoked exactly once if the underlying promise settles AFTER the deadline
   * already fired — i.e. a late result that was invalidated. Lets callers/tests
   * observe invalidation without the late value ever being used.
   */
  onLateSettled?: (settled: { status: "ok" | "error" }) => void;
}

/**
 * Runs `task(signal)` under a deadline. On timeout the signal is aborted and a
 * `"timeout"` result is returned immediately; the task's eventual settlement is
 * swallowed (never returned) so a late provider response cannot leak out.
 */
export async function withDeadline<T>(
  task: (signal: AbortSignal) => Promise<T>,
  options: WithDeadlineOptions,
): Promise<DeadlineResult<T>> {
  const controller = new AbortController();
  const startedAt = Date.now();
  let settledInTime = false;

  return await new Promise<DeadlineResult<T>>((resolve) => {
    const timer = setTimeout(() => {
      if (settledInTime) return;
      controller.abort();
      resolve({ status: "timeout", durationMs: Date.now() - startedAt });
    }, options.timeoutMs);

    // Ensure a rejected late task never becomes an unhandledRejection.
    void Promise.resolve()
      .then(() => task(controller.signal))
      .then(
        (value) => {
          if (settledInTime === false && controller.signal.aborted) {
            // Deadline already fired: invalidate the late (successful) result.
            options.onLateSettled?.({ status: "ok" });
            return;
          }
          const durationMs = Date.now() - startedAt;
          if (durationMs >= options.timeoutMs) {
            controller.abort();
            clearTimeout(timer);
            options.onLateSettled?.({ status: "ok" });
            resolve({ status: "timeout", durationMs });
            return;
          }
          settledInTime = true;
          clearTimeout(timer);
          resolve({ status: "ok", value, durationMs });
        },
        (error) => {
          if (settledInTime === false && controller.signal.aborted) {
            options.onLateSettled?.({ status: "error" });
            return;
          }
          const durationMs = Date.now() - startedAt;
          if (durationMs >= options.timeoutMs) {
            controller.abort();
            clearTimeout(timer);
            options.onLateSettled?.({ status: "error" });
            resolve({ status: "timeout", durationMs });
            return;
          }
          settledInTime = true;
          clearTimeout(timer);
          resolve({ status: "error", error, durationMs });
        },
      );
  });
}
