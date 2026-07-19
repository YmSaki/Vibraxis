# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Vibraxis — an AI club-DJ web app (hackathon project, OpenAI Build Week). An agent picks the next track and executes beat-matched transitions between two decks in the browser.

**`AGENTS.md` is the authoritative collaboration policy — read it.** Its top rule (§0): never correct, clamp, round, substitute, or omit user/AI-specified values by internal judgment. If input can't be executed as given, **reject with an explicit machine-readable reason** — never repair it. Never report unexecuted/unverified work as success. This principle is enforced pervasively in the code (orchestrator rejects invalid AI output unchanged; selection engine excludes candidates with reason codes instead of clamping).

## Commands

```bash
npm run dev              # backend (127.0.0.1:8787) + Vite frontend (:5173) together
npm run check            # FULL GATE: protocol-docs + contracts + shared/backend/frontend typecheck+tests+build
npm run demo:smoke       # end-to-end smoke without API keys (deterministic route)

# Targeted tests
npm run test:contracts   # JSON schemas (node --test, Ajv)
npm run test:dj          # deterministic selection engine
npm run test:transition  # beat transition + DeckEngine
npm run test:agent       # backend orchestrator/providers
npm run check:protocol-docs

# Single test file (Vitest)
npm --workspace frontend run test -- src/path/to/file.test.ts
npm --workspace backend run test -- test/file.test.ts

# Backend live-model tests (needs OPENAI_API_KEY / Codex CLI login)
npm --workspace backend run test:smoke
```

Analyze-tool (Python sidecar, run from `analyze-tool/`, uses `uv`): `uv sync`, `uv run task check`, `uv run task analyze-samples`, `uv run task build-catalog`. After regenerating analysis/catalog, run root `npm run test:contracts`.

Notes: backend and `scripts/*.mjs` run `.ts`/`.mjs` directly under Node (native type-stripping) — there is no backend build step. Ignore `node_modules/` and `analyze-tool/.venv/` in searches.

## Architecture

npm-workspaces monorepo: `frontend/` (React + Vite + Vitest), `backend/` (Node `node:http` only — no web framework), `shared/` (pure TS types + JSON schemas). All ESM.

There are **two distinct protocols — do not conflate them:**

**1. VDAP** ("Vibraxis DJ Agent Protocol", `shared/vdap/`) — the in-browser runtime protocol. The audio runtime lives entirely in the browser; UI code and agent code talk to it over **MessagePort** (not network) via `VdapClient`, with two authority roles: `uiPort` (user) and `agentPort` (agent). Commands: `deck.load`, `deck.play/pause/seek`, `mixer.setCrossfader`, `transition.start`, `runtime.panic`, etc. Canonical `RuntimeState` snapshots are pushed per revision.
- `frontend/src/runtime/` — `createRuntime.ts` wires `RuntimeStore` + `CommandDispatcher` + `MessagePortTransport` + `DeckEngineAudioPort`; `runtime/transition/TransitionExecutor.ts` turns a `TransitionPlan` into the VDAP command sequence (load inactive deck → tempo-only sync → one atomic `transition.start` at a bar boundary → pause old deck after ramp), re-checking `expectedBindingId` at each step and yielding to user override.
- `frontend/src/audio/DeckEngine.ts` — Web Audio: decks A/B, 3-band EQ, `dj`/`equalPower` crossfader curves, playback-rate limits (`audioMath.ts`).

**2. DJ Agent HTTP API** — frontend ↔ backend. Backend (`backend/src/agent/http.ts`) serves exactly two routes, loopback-only on `AGENT_PORT` (default 8787), proxied by Vite under `/api/agent`:
- `GET /api/agent/capability` — sanitized config/availability (never secrets).
- `POST /api/agent/decide` — returns `decided | rejected`; business rejections are HTTP 200 with `outcome:"rejected"`.

The backend orchestrator (`backend/src/agent/orchestrator.ts`) routes each decide request to exactly the caller-selected route (`config.ts`):
1. `deterministic` — shared selection engine only.
2. `codex-local` — deterministic preselect → Codex CLI picks from a disclosed shortlist (sandboxed: read-only, no network).
3. `gpt56-codex` — GPT-5.6 converts free text into a `DjIntent` → preselect → Codex decides.

Invariants: the requested route is never silently swapped; AI output is Ajv + semantically validated and rejected unchanged on violation; deterministic fallback runs only on explicit opt-in (`fallback.onProviderFailure:"deterministic"`) and is labeled in provenance (`stages[]`, `usedDeterministicFallback`). The model id `"gpt-5.6"` is pinned exactly — a mismatch is a failure, not a swap.

**Selection engine** — `shared/dj/selection.ts` (`selectNextTrack`): pure/deterministic ranking by BPM proximity, Camelot key compatibility, energy direction. Returns `selected` or `noCandidate` with reason codes (e.g. `playbackRateAboveRange`); excludes rather than clamps. Shapes fixed by `shared/dj/intent.schema.json` / `decision.schema.json`. Docs: `shared/dj/DETERMINISTIC_SELECTION.md`.

**Frontend agent glue** — `frontend/src/agent/`: `AgentApiClient.ts` (re-validates every legal stage/provenance combination by hand — server runtime is not imported into the bundle), `applyDecision.ts` (applies a `DjDecision` via the agent VDAP client).

**Data flow** — `analyze-tool/` (Python, librosa) analyzes audio offline → `data/analysis/*.json` + `data/catalog.json` (merged with hand-authored `data/catalog-source.json`). These are **generated artifacts**. In dev, a custom Vite middleware plugin (`frontend/vite.config.ts`) serves `/api/catalog`, `/api/analysis/:trackId`, and `/tracks/:file` (audio from `data/sample/`); there is no separate static server. Contract: `analyze-tool/analysis.schema.json`.

## Protocol doc sync rule

`Vibraxis DJ Agent Protocol.md` (repo root) is the authoritative prose spec. **Any change to protocol semantics or the VDAP/DJ JSON schemas must update this doc in lockstep.** `npm run check:protocol-docs` enforces it mechanically: valid JSON fences, contiguous conformance-test IDs (T1, T2, …), required contract literals verbatim (`baseVelocity`, `expectedBindingId`, error codes like `E_ROLE_MISMATCH`, …), forbidden legacy terms, and canonical-state JSON shape (top-level `intents` map, no per-deck `pendingIntents`).

## Conventions

- Frontend tooling deps intentionally use `"latest"`; backend SDKs (`openai`, `@openai/codex-sdk`) are pinned exactly. Don't re-pin or bump casually.
- Env vars: `AGENT_PORT` (default 8787); `OPENAI_API_KEY` enables the GPT-5.6 provider (absent → `availability.gpt56:false`); Codex CLI must be installed/logged-in for `codex-local`. The `deterministic` route and `demo:smoke` need no keys. No `.env` is committed.
- Review outputs are written under `.claude/.tmp/` (implement/review split across agents per `AGENTS.md`).
- Scope guard: build only what the demo storyboard needs (`提出計画.md`); architecture decisions in `Codexキックオフ.md` are settled — don't re-litigate.
