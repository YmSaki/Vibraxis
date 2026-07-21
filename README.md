# Vibraxis — AI Club DJ

[![check](https://github.com/YmSaki/Vibraxis/actions/workflows/ci.yml/badge.svg)](https://github.com/YmSaki/Vibraxis/actions/workflows/ci.yml)

Vibraxis is an AI club DJ. You tell it what the room needs in plain language —
"keep it mellow while we eat, then slowly pick it up" — and it selects key- and
tempo-compatible tracks from a bundled, fully licensed music library, beat-matches
the transition, crossfades live, and explains every decision it makes.

Built for **OpenAI Build Week** with Codex and GPT-5.6.

> **Status:** the full golden path works end-to-end in the browser — load → play →
> **agent decision → atomic beat-matched transition** (exact tempo sync, next-bar
> start, equal-power crossfade, outgoing deck stop) → next decision, plus PANIC.
> The DJ Agent panel exposes three provider routes (deterministic / Codex local /
> GPT-5.6 → Codex) with full per-stage provenance and opt-in fallback.

## Quick start

Requires Node.js 22.6+ (tested on 24.x — the agent backend runs TypeScript
natively, no build step).

```powershell
npm install
npm run dev
```

This starts the Vite UI (`http://localhost:5173`) **and** the DJ Agent backend
(loopback-only, `127.0.0.1:8787`). No API keys are needed for the full demo on
the **Deterministic** route. Optional live providers:

- `OPENAI_API_KEY` (env var) enables the **GPT-5.6 → Codex** route. Copy
  `.env.example` to `.env` and set it there — the backend loads `.env` on start.
- `GPT56_MODEL` (optional) selects the GPT-5.6 variant, e.g. `gpt-5.6-luna`
  (cheapest) or `gpt-5.6-sol` (default). Must be a `gpt-5.6*` id.
- A logged-in Codex CLI enables the **Codex (local)** route (read-only sandbox,
  network disabled).

Open `http://localhost:5173`, click **ENABLE AUDIO**, and load any track from the
analyzed library onto Deck A or B. Every control on the golden path — loading,
transport, gain, tempo, crossfader, master, **PANIC** — runs through the VDAP
runtime, not directly against the audio engine.

Each deck shows a full-song **three-band overview waveform** (LOW = red/orange,
MID = green, HI = blue/cyan) with a playhead, beat/downbeat/section/pad overlays,
and click-or-drag scrubbing that seeks through the VDAP `deck.seek` path. Beats,
bars, sections, and chord degree are read through one shared `TrackTimeline`
model, and the full beat grid is fetched on demand with the `deck.getGrid` query
so the large arrays never ride along in every runtime snapshot. Estimated grids
are badged as such, and tracks without analysis (e.g. local file uploads) still
render a waveform and degrade gracefully to no overlay.

Verify everything (protocol docs, contract schemas, TypeScript, unit and
integration tests, production build):

```powershell
npm run check
```

## What makes it tick

### VDAP — the agent is a port, not a place

Vibraxis is built around **VDAP** (Vibraxis DJ Agent Protocol, see
`Vibraxis DJ Agent Protocol.md`): a revisioned, intent-based contract between
anything that wants to DJ and the runtime that owns the decks.

- Two MessagePorts with **fixed roles**: `uiPort` (origin `user`) and `agentPort`
  (origin `agent`). A port's role is assigned at creation and cannot be claimed
  via handshake.
- **User always wins**: a user action cancels agent automation in the same
  conflict domain. `runtime.panic` stops everything, instantly.
- **Declarative timing**: an agent says `when: nextBar` — the runtime does the
  millisecond-accurate scheduling. The agent never sits inside the realtime loop,
  so agent latency can never corrupt the mix.
- Commands are schema-validated (`shared/`), mutations follow a strict
  request → ack → state update → terminal event lifecycle, and every state change
  carries a revision.

Because of this, "where does the agent live?" has one answer: **behind the
agentPort**. The built-in GPT-5.6 provider, a backend process, or an MCP server
bridging to another assistant all mount on the same contract with the same
safety rules.

### The bounded brain — LLMs decide, they never drive

Track selection is a pipeline, not a free-form LLM call:

```text
natural language ─▶ GPT-5.6 ─▶ DjIntent (bounded JSON, schema-validated)
DjIntent ─▶ deterministic engine ─▶ scored ranking + safe shortlist
shortlist ─▶ Codex ─▶ DjDecision (which track, which deck, how many bars)
DjDecision ─▶ schema + semantic + binding validation ─▶ TransitionPlan ─▶ VDAP
```

1. **GPT-5.6** (Structured Outputs; the configured `gpt-5.6*` model — e.g.
   `gpt-5.6-luna` — and the id the API reports must match exactly, else the
   response is rejected as `gpt_model_mismatch`, never silently swapped)
   translates the DJ's words into a bounded `DjIntent`. It cannot name tracks
   that don't exist — intents referencing unknown ids are rejected, never
   repaired.
2. **The deterministic engine** (`shared/dj/selection.ts`, a pure function)
   inspects every candidate against the *actual live tempo* of the playing deck:
   exact tempo-sync rate within runtime limits, Camelot compatibility, energy
   direction, recency. It excludes with machine-readable reasons instead of
   clamping, and produces a disclosed shortlist.
3. **Codex** (local CLI via `@openai/codex-sdk`, read-only sandbox, network
   disabled) makes the final musical call from that shortlist. A decision
   outside the shortlist, targeting the wrong deck, or breaking tempo limits is
   rejected unchanged.

Three routes are exposed in the UI: `deterministic` (no keys needed),
`codex-local`, and `gpt56-codex`. **Fallback is opt-in and honest**: a provider
failure rejects the request unless the caller explicitly opted into
deterministic fallback — and then the response is labeled
`decisionProvider: "deterministic"`, `usedDeterministicFallback: true`, with
per-stage timings shown in the panel's provenance view.

### An analyzed, rights-cleared crate

The bundled library (19 tracks — 16 by [BGMer](https://bgmer.net) plus 3 original
works by the author, see `ATTRIBUTIONS.md`) ships pre-analyzed by `analyze-tool/`
(Python + librosa):
BPM, beat and downbeat grids, key/Camelot, energy, and section structure
(intro / build / drop / breakdown / outro). The DJ doesn't guess where the drop
is — it knows.

## Repository layout

```text
frontend/   React + Vite UI, Web Audio deck engine, VDAP runtime (browser)
backend/    DJ Agent server (node:http, stateless): orchestrator + GPT-5.6/Codex providers
shared/     Protocol + DJ + analysis types and JSON Schemas (single source of truth)
analyze-tool/  Offline Python/librosa analyzer -> data/analysis + data/catalog.json
data/       Analyzed catalog, per-track analysis JSON, sample tracks
scripts/    Dev launcher (npm run dev), demo smoke (npm run demo:smoke), protocol doc checker
```

Roadmap and design records: `VDAP仕様実装順.md` (implementation order),
`Vibraxis DJ Agent Protocol.md` (protocol), `.claude/.tmp/` (review logs).

## How this was built (Codex & GPT-5.6)

This project is an OpenAI Build Week entry. **OpenAI Codex** built the core of
the codebase: the analyzer CLI, the two-deck Web Audio engine, the VDAP protocol
documents and their machine checker, the shared schema/type layer, and the
runtime foundations (store, intent manager, transport, dispatcher) — each stage
reviewed and committed separately. After Codex usage limits were exhausted
mid-week, remaining integration work continued with another AI assistant
(Claude), with per-stage review notes kept in `.claude/.tmp/`.

**GPT-5.6** is the product's brain (roadmap order 6): it turns natural language
into a structured `DjIntent` and picks the next track from deterministically
scored candidates, via Structured Outputs against the schemas in `shared/dj/`.

Concrete session highlights:

- **Spec and checker before features.** The first substantive commits locked the
  VDAP step-0 contracts (`docs: lock VDAP step 0 contracts`) and added a machine
  checker (`npm run check:protocol-docs`) — enforcing conformance-test numbering,
  required contract literals, and canonical-state shape — *before* a single audio
  feature existed. Every later stage was built against that fixed contract.
- **A staged roadmap, reviewed per stage.** Runtime foundations → dispatcher/client
  → safe audio foundation (staged load, limiter) → crossfader/EQ → atomic beat
  transitions → deterministic selection engine → provider routes → agent panel →
  autonomous conductor, each designed, tested, and committed separately, with review
  notes in `.claude/.tmp/`.
- **Honest handling of a live surprise.** We discovered mid-build that `gpt-5.6` is a
  *family alias* the API resolves to a concrete variant (e.g. `gpt-5.6-luna`). Rather
  than silently accept whatever came back, we made the model caller-selectable via
  `GPT56_MODEL` while keeping an exact-match guard (`gpt_model_mismatch`) — in keeping
  with the §0 "never repair, always reject with a reason" rule.
- **A human gate on the data.** librosa's dynamic beat tracking wandered on
  constant-tempo material, so Codex built a rigid beat-grid solver; every grid was
  then auditioned **by ear**, and four tracks that could not be made musically correct
  were excluded from the catalog rather than shipped wrong.

Full detail — including the bounded in-product decision pipeline — is in
[`highlight_how_Codex_&_GPT-5.6_were_used..md`](highlight_how_Codex_&_GPT-5.6_were_used..md).

## Music licensing

All bundled tracks are by **BGMer** (https://bgmer.net) and are used and
redistributed under BGMer's terms (free personal/commercial use, modification
allowed, redistribution permitted with attribution etiquette). Full track list
and terms summary: [`ATTRIBUTIONS.md`](ATTRIBUTIONS.md). The MIT `LICENSE`
covers the code only — the audio remains under BGMer's terms.

## Future work

- **MCP instrument**: mount an MCP server on the agentPort so any assistant —
  including GPT-5.6 through ChatGPT's MCP connectors — can play the deck, with
  the same user-priority and schema-validation rules.
- Streaming-service catalog source behind the existing `MusicSource` seam.
- Phase-locked sync, harmonic (chord-aware) mix points, and the rest of the
  protocol's P2/P3 surface.

---

## 日本語クイックスタート

Node.js 22.6以降（24.x で動作確認）が必要です。

```powershell
npm install
npm run dev
```

Vite UI（`http://localhost:5173`）と DJ Agent バックエンド（127.0.0.1:8787、
ループバック限定）が同時に起動します。ブラウザで開き **ENABLE AUDIO** を
クリック後、曲をデッキAにロードして再生 → DJ AGENT パネルで **REQUEST
DECISION** → **APPLY DECISION** で、拍同期の自動ミックスが実行されます。
Deterministic ルートは API キー不要。検証は `npm run check`（プロトコル検査・
スキーマ契約・型・テスト・ビルド）と `npm run demo:smoke`。
