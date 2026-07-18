import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_AGENT_CONFIG } from "../src/agent/config.ts";
import { createAgentRequestListener, handleDecideBody } from "../src/agent/http.ts";
import { buildOrchestrator, context, intent } from "./fixtures.ts";

describe("handleDecideBody", () => {
  it("returns 200 + decided for a valid deterministic request", async () => {
    const orch = buildOrchestrator();
    const body = JSON.stringify({ route: "deterministic", context: context(), intent: intent() });
    const result = await handleDecideBody(orch, body);
    expect(result.status).toBe(200);
    expect((result.json as { outcome: string }).outcome).toBe("decided");
  });

  it("returns 400 for non-JSON", async () => {
    const orch = buildOrchestrator();
    const result = await handleDecideBody(orch, "not json");
    expect(result.status).toBe(400);
  });

  it("returns 400 for a non-object body", async () => {
    const orch = buildOrchestrator();
    const result = await handleDecideBody(orch, "42");
    expect(result.status).toBe(400);
  });

  it("returns 400 for an unknown route", async () => {
    const orch = buildOrchestrator();
    const result = await handleDecideBody(orch, JSON.stringify({ route: "mystery", context: context() }));
    expect(result.status).toBe(400);
    expect(result.json).toEqual({
      error: "invalid_request",
      detail: "route is not a supported ProviderRoute",
    });
  });
});

describe("http server", () => {
  let server: Server | null = null;

  afterEach(async () => {
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    server = null;
  });

  function listen(): Promise<string> {
    const orch = buildOrchestrator();
    server = createServer(
      createAgentRequestListener({
        orchestrator: orch,
        config: DEFAULT_AGENT_CONFIG,
        availability: { gpt56: false, codexLocal: true },
      }),
    );
    return new Promise((resolve) => {
      server!.listen(0, "127.0.0.1", () => {
        const addr = server!.address();
        const port = typeof addr === "object" && addr ? addr.port : 0;
        resolve(`http://127.0.0.1:${port}`);
      });
    });
  }

  it("GET /api/agent/capability returns the sanitized capability", async () => {
    const base = await listen();
    const res = await fetch(`${base}/api/agent/capability`);
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.routes).toContain("gpt56-codex");
    expect(body.fallback.optInRequired).toBe(true);
    expect(body.gpt56.model).toBe("gpt-5.6");
    expect(body.codex.sandboxMode).toBe("read-only");
    expect(body.availability).toEqual({ gpt56: false, codexLocal: true });
    // No secrets leak.
    expect(JSON.stringify(body)).not.toMatch(/apiKey|auth\.json|OPENAI_API_KEY/i);
  });

  it("POST /api/agent/decide returns a decision", async () => {
    const base = await listen();
    const res = await fetch(`${base}/api/agent/decide`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ route: "deterministic", context: context(), intent: intent() }),
    });
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.outcome).toBe("decided");
    expect(body.decision.nextTrackId).toBe("t2");
  });

  it("returns an observable 413 JSON response for an oversized body", async () => {
    const base = await listen();
    const res = await fetch(`${base}/api/agent/decide`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: `{"padding":"${"x".repeat(1_000_001)}"}`,
    });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "payload_too_large" });
  });

  it("GET on the decide endpoint is 405", async () => {
    const base = await listen();
    const res = await fetch(`${base}/api/agent/decide`);
    expect(res.status).toBe(405);
  });

  it("unknown path is 404", async () => {
    const base = await listen();
    const res = await fetch(`${base}/nope`);
    expect(res.status).toBe(404);
  });
});
