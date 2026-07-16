# Codexキックオフプロンプト

使い方: Codexで**メインスレッドを1本立てて**、以下の英語プロンプトを最初に貼る。以降の開発は原則このスレッドで続ける（提出に必要な `/feedback` セッションIDは「コア機能の大半を作ったスレッド」のものだから）。

マイルストーンは1つずつ進めて、**各マイルストーンが動いたらスクリーン録画を撮る**（デモ動画の素材＋Codex使用の証拠になる）。

---

```
# Vibraxis — AI Club DJ (hackathon project)

You are helping me build Vibraxis for the OpenAI Build Week hackathon
(deadline: July 21). Vibraxis is an AI club DJ: the user types
natural-language intent ("keep it mellow while we eat, then slowly pick
it up"), and the agent selects key/tempo-compatible tracks from a local
royalty-free catalog, crossfades between them live, and explains every
transition.

## Architecture (already decided — do not re-litigate)

Monorepo with npm workspaces, all TypeScript, Node 20+:

- `frontend/` — React + Vite + TS. Chat panel, Now Playing deck,
  upcoming set plan. Audio playback via Web Audio API.
- `server/`   — Node + TS + Hono. Serves the built frontend, the audio
  files and catalog, and proxies GPT-5.6 (API key stays server-side,
  read from env var OPENAI_API_KEY).
- `shared/`   — types and pure logic shared by both: catalog schema,
  DJ-intent schema, track-scoring functions.

Key design constraints:
- Track access goes through a `MusicSource` interface
  (`LocalFolderSource` now; a streaming-service source is future work —
  design the interface so that swap is plausible).
- Track selection is a two-step pipeline: (1) deterministic scoring in
  `shared/` ranks candidates by BPM proximity, Camelot-wheel key
  compatibility, and energy direction; (2) GPT-5.6 receives only the
  top-K candidates plus the structured user intent and picks one, with
  a short explanation. The LLM never free-picks from the whole catalog.
- GPT-5.6 calls use structured outputs (JSON schema), model "gpt-5.6".

## Data model (shared/)

Track: { id, title, artist, file, bpm, key, camelot, energy (0-1),
genre, mood: string[], license, sourceUrl }
DJIntent: { energyTarget (0-1), energyDirection ("up"|"down"|"hold"),
moods: string[], genres: string[], explicitTrackRequest?: string,
comment: string }
SetPlanItem: { trackId, reason, transition: { atSeconds, crossfadeSeconds } }

## Milestones — build strictly in this order, one at a time.
After each milestone, tell me how to run it and wait for my confirmation.

M1. Sound + crossfade (the riskiest part, so it goes first):
    server serves `tracks/` + `catalog.json` (`GET /api/catalog`,
    `GET /tracks/:file`); frontend loads the catalog, plays a track,
    and a "Next" button crossfades to another track with an
    equal-power curve (default 8s). Use 2-3 placeholder mp3 files I
    will drop into `tracks/` myself, with a hand-written catalog.json.

M2. Scoring: implement BPM/Camelot/energy scoring in `shared/` with
    unit tests (vitest). Show top-5 next-track candidates in the UI
    with their score breakdown.

M3. The agent: chat input → POST /api/intent → GPT-5.6 structured
    output (DJIntent) → score candidates → GPT-5.6 picks from top-K
    and writes the transition explanation → frontend auto-crossfades
    at the right moment and displays the explanation.

M4. Set plan: maintain a 3-5 track plan ahead, visualized as a
    timeline; re-plan when a new intent arrives or a track is
    explicitly requested ("play X by Y").

Out of scope (do not build): streaming-service integration, turntablism
effects, user accounts, hosting.

Start with M1: scaffold the monorepo and implement it.
```

---

## 補足メモ（自分用）

- M1の前に `tracks/` に手持ちのフリー音源を2〜3曲置く（この時点では仮でOK、本選定は並行作業）
- 各マイルストーン完了時にgitコミット（タイムスタンプ付き履歴が「Submission Period内の作業」の証拠になる）
- Codexが効いた場面（設計判断・デバッグ・生成の加速）を`docs/codex-notes.md`にでも一行ずつメモ → READMEと動画ナレーションの素材
- 前処理は `analyze-tool/`（Python 3.11 + librosa の独立CLI、npm scriptsから起動）として確定済み → 詳細は提出計画.mdのセクション4。タイムボックス半日、ChordMiniはスコープ外、`overrides.json` による手動上書き機構を入れる。M1は手書きcatalog.jsonで進められるので解析の完成を待たない
