/**
 * HTTP boundary for the DJ Agent. Uses only Node's built-in `node:http` (no web
 * framework) to keep the dependency footprint small.
 *
 * Routes:
 * - POST /api/agent/decide      -> AgentDecideResponse (discriminated union)
 * - GET  /api/agent/capability  -> AgentCapability (read-only, no secrets)
 *
 * The decide handler is exposed separately (`handleDecideBody`) so tests can
 * exercise it without binding a socket.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import { describeCapability, type AgentConfig, type ProviderAvailability } from "./config.ts";
import type { AgentOrchestrator } from "./orchestrator.ts";
import type { AgentDecideRequest } from "./types.ts";

export interface AgentHttpDeps {
  orchestrator: AgentOrchestrator;
  config: AgentConfig;
  availability: ProviderAvailability;
}

/** Max accepted request body. Guards the boundary against oversized payloads. */
const MAX_BODY_BYTES = 1_000_000;

export interface HandlerResult {
  status: number;
  json: unknown;
}

/** Parses a decide body and runs the orchestrator. Never throws for bad input. */
export async function handleDecideBody(
  orchestrator: AgentOrchestrator,
  rawBody: string,
): Promise<HandlerResult> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return { status: 400, json: { error: "invalid_json", detail: "request body is not valid JSON" } };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { status: 400, json: { error: "invalid_request", detail: "request body must be a JSON object" } };
  }
  const route = (parsed as { route?: unknown }).route;
  if (route !== "deterministic" && route !== "codex-local" && route !== "gpt56-codex") {
    return { status: 400, json: { error: "invalid_request", detail: "route is not a supported ProviderRoute" } };
  }
  const response = await orchestrator.decide(parsed as AgentDecideRequest);
  // Business outcomes (decided/rejected) are both HTTP 200; the discriminated
  // `outcome` field carries the result. Only malformed transport is non-200.
  return { status: 200, json: response };
}

async function readBody(req: IncomingMessage): Promise<{ ok: true; body: string } | { ok: false }> {
  return await new Promise((resolve) => {
    let size = 0;
    let finished = false;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      if (finished) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        finished = true;
        chunks.length = 0;
        resolve({ ok: false });
        // Keep the socket alive long enough for the listener to return its
        // documented 413 response; discard any remaining request bytes.
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (finished) return;
      finished = true;
      resolve({ ok: true, body: Buffer.concat(chunks).toString("utf8") });
    });
    req.on("error", () => {
      if (finished) return;
      finished = true;
      resolve({ ok: false });
    });
  });
}

function sendJson(res: ServerResponse, status: number, json: unknown): void {
  const body = JSON.stringify(json);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(body);
}

/** Builds a `node:http` request listener for the agent endpoints. */
export function createAgentRequestListener(deps: AgentHttpDeps) {
  return async function listener(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url ?? "";
    const path = url.split("?", 1)[0];

    if (path === "/api/agent/capability") {
      if (req.method !== "GET") {
        sendJson(res, 405, { error: "method_not_allowed" });
        return;
      }
      sendJson(res, 200, describeCapability(deps.config, deps.availability));
      return;
    }

    if (path === "/api/agent/decide") {
      if (req.method !== "POST") {
        sendJson(res, 405, { error: "method_not_allowed" });
        return;
      }
      const read = await readBody(req);
      if (!read.ok) {
        sendJson(res, 413, { error: "payload_too_large" });
        return;
      }
      const result = await handleDecideBody(deps.orchestrator, read.body);
      sendJson(res, result.status, result.json);
      return;
    }

    sendJson(res, 404, { error: "not_found" });
  };
}
