# Vibraxis — AI Club DJ

Vibraxis is an AI club DJ. You tell it what the room needs in plain language —
"keep it mellow while we eat, then slowly pick it up" — and it selects key- and
tempo-compatible tracks from a bundled, fully licensed music library, beat-matches
the transition, crossfades live, and explains every decision it makes.

Built for **OpenAI Build Week** with Codex and GPT-5.6.

> **Status (work in progress):** the VDAP runtime, two-deck audio engine, and the
> full manual golden path (load → play → crossfade → panic, all through the
> protocol) are working. The autonomous beat-matched transition and the GPT-5.6
> DJ brain are being built next — see the roadmap below.

## Quick start

Requires Node.js 20+.

```powershell
npm install
npm start
```

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

### The two-step brain (planned — order 5-6 of the roadmap)

Track selection is a pipeline, not a free-form LLM call:

1. **Deterministic scoring** (pure functions, unit-tested) ranks candidates by
   BPM proximity, Camelot-wheel key compatibility, energy direction, and play
   history.
2. **GPT-5.6** (Structured Outputs, `DjIntent` / `DjDecision` schemas in
   `shared/dj/`) interprets the user's natural-language intent, picks from the
   top-ranked candidates, and writes the reason you see on screen.

If the model is unreachable, the deterministic layer keeps the music going.

### An analyzed, rights-cleared crate

The bundled library (9 tracks by [BGMer](https://bgmer.net), see
`ATTRIBUTIONS.md`) ships pre-analyzed by `analyze-tool/` (Python + librosa):
BPM, beat and downbeat grids, key/Camelot, energy, and section structure
(intro / build / drop / breakdown / outro). The DJ doesn't guess where the drop
is — it knows.

## Repository layout

```text
frontend/   React + Vite UI, Web Audio deck engine, VDAP runtime (browser)
shared/     Protocol + DJ + analysis types and JSON Schemas (single source of truth)
analyze-tool/  Offline Python/librosa analyzer -> data/analysis + data/catalog.json
data/       Analyzed catalog, per-track analysis JSON, sample tracks
scripts/    Protocol document static checker (npm run check:protocol-docs)
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

*This section will be expanded with concrete session highlights before
submission.*

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

Node.js 20以降が必要です。

```powershell
npm install
npm start
```

ブラウザで `http://localhost:5173` を開き、**ENABLE AUDIO** をクリックしてから、
解析済みライブラリの曲をデッキA/Bにロードしてください。ロード・再生・クロス
フェーダー・PANICを含む全操作がVDAP Runtime経由で動作します。検証は
`npm run check`（プロトコル検査・スキーマ契約・型・テスト・ビルド）。
