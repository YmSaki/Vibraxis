import { describe, expect, it } from "vitest";

import { withDeadline } from "../src/agent/deadline.ts";

describe("withDeadline", () => {
  it("returns the value when the task settles in time", async () => {
    const result = await withDeadline(async () => 42, { timeoutMs: 1000 });
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.value).toBe(42);
  });

  it("returns timeout and aborts the signal when the deadline fires", async () => {
    let sawAbort = false;
    const result = await withDeadline(
      (signal) =>
        new Promise<number>((resolve) => {
          const t = setTimeout(() => resolve(1), 1000);
          signal.addEventListener("abort", () => {
            sawAbort = true;
            clearTimeout(t);
          });
        }),
      { timeoutMs: 20 },
    );
    expect(result.status).toBe("timeout");
    expect(sawAbort).toBe(true);
  });

  it("invalidates a late SUCCESS result: the value is never returned", async () => {
    let late: { status: "ok" | "error" } | null = null;
    const result = await withDeadline(
      // Ignores the abort signal on purpose; resolves well after the deadline.
      () => new Promise<string>((resolve) => setTimeout(() => resolve("late-value"), 60)),
      {
        timeoutMs: 15,
        onLateSettled: (s) => {
          late = s;
        },
      },
    );
    expect(result.status).toBe("timeout");
    // Wait long enough for the late settle to fire.
    await new Promise((r) => setTimeout(r, 80));
    expect(late).toEqual({ status: "ok" });
    // The result object never carried the late value.
    expect(JSON.stringify(result)).not.toContain("late-value");
  });

  it("reports errors thrown before the deadline", async () => {
    const result = await withDeadline(async () => {
      throw new Error("boom");
    }, { timeoutMs: 1000 });
    expect(result.status).toBe("error");
  });

  it("rejects a synchronous result that blocks the event loop past the absolute deadline", async () => {
    const result = await withDeadline(async () => {
      const stopAt = Date.now() + 50;
      while (Date.now() < stopAt) {
        // Deliberately block so the timer callback cannot run first.
      }
      return "too-late";
    }, { timeoutMs: 10 });
    expect(result.status).toBe("timeout");
    expect(JSON.stringify(result)).not.toContain("too-late");
  });
});
