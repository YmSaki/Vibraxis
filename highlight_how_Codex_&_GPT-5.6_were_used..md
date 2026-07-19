# How Codex & GPT-5.6 Were Used in Vibraxis

Vibraxis uses Codex and GPT-5.6 in **two distinct ways**: they are components *inside the product*, and they were the *builders of the product*.

## 1. Inside the product — a bounded decision pipeline

Vibraxis deliberately does not let an LLM drive the audio engine. Both models operate inside a validated pipeline where every output is checked and anything non-conforming is rejected unchanged (never repaired or silently substituted):

```text
natural language ─▶ GPT-5.6 ─▶ DjIntent (bounded JSON)
DjIntent ─▶ deterministic engine ─▶ scored ranking + disclosed shortlist
shortlist ─▶ Codex ─▶ DjDecision (track, deck, crossfade bars)
DjDecision ─▶ schema + semantic + binding validation ─▶ beat-matched transition
```

### GPT-5.6 — the interpreter

- Called server-side via the OpenAI **Structured Outputs** API with the `DjIntent` JSON Schema (`shared/dj/intent.schema.json`).
- The model id is pinned **exactly** to `gpt-5.6`; if the API reports any other model, the response is rejected (`gpt_model_mismatch`) rather than silently accepted.
- Its only job: turn "keep the energy high but mix into something a little faster" into a bounded intent (energy/tempo direction, harmonic priority, urgency, optional requested track). It cannot invent track ids — an intent referencing a track that was not offered is rejected by semantic validation.

### Codex — the selector

- Called via `@openai/codex-sdk` against the **locally logged-in Codex CLI**, with a hard-minimized capability surface: `sandboxMode: "read-only"`, network disabled, web search disabled, `approvalPolicy: "never"`, working directory fixed to the repo root.
- Codex receives only trusted context (current track, live tempo, runtime limits, the deterministic shortlist) and must return a `DjDecision` matching `shared/dj/decision.schema.json` via `outputSchema`.
- Hard rules enforced *after* Codex answers: the chosen track must be in the disclosed shortlist, must target the inactive deck, must honor a user-requested track, and its exact tempo-sync rate must be within runtime limits. Violations are typed rejections (`decision_not_shortlisted`, `decision_semantic_invalid`, …).
- If Codex fails (timeout, quota, invalid output), the request is **rejected by default**. Deterministic fallback runs only when the caller explicitly opted in — and the response is then honestly labeled `decisionProvider: "deterministic"`, `usedDeterministicFallback: true`, with per-stage timings shown in the UI's provenance panel.

## 2. Building the product — Codex as the primary implementation agent

This is an OpenAI Build Week entry, and **Codex wrote the core of this codebase**, working through a staged roadmap (`VDAP仕様実装順.md`) with per-stage reviews:

- The Python/librosa **analyze-tool** (BPM, beat/downbeat grids, key/Camelot, sections, energy) and its schema-v2 contract.
- The **two-deck Web Audio engine** (3-band EQ, DJ/equal-power crossfader curves, velocity limits).
- The **VDAP protocol**: a 1,100+ line prose specification plus a machine checker (`npm run check:protocol-docs`) that enforces conformance-test numbering, required contract literals, and canonical-state shape on every run.
- The **VDAP runtime**: revisioned canonical state store, intent lifecycle manager, MessagePort transport, command dispatcher with atomic beat-transition reservations.
- The **agent backend**: orchestrator, three provider routes, Ajv + semantic validation, deadline enforcement with late-result invalidation.

Development followed a strict collaboration policy (`AGENTS.md`): inputs are never corrected or clamped silently, unverified work is never reported as success, and implementation and review were split between agents — Codex implemented and independently reviewed, with review artifacts kept in `.claude/.tmp/`. After Codex usage limits were temporarily exhausted mid-week, integration work continued with Claude and returned to Codex when limits reset.

The result is measurable: at submission HEAD, `npm run check` passes end-to-end — protocol document checks, 9 contract-schema tests, full type-checking, **388 unit tests across 34 files (0 failures, 0 skips)**, and a production build — and the complete golden path (agent decision → atomic beat-matched transition → next decision) runs live in the browser.

<!-- TODO before submission (owner): add the Codex /feedback session ID and link the demo video. -->
