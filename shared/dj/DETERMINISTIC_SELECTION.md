# 決定論的DJ選曲ロジック仕様 (順序5 / Order 5)

- 対象実装: `shared/dj/selection.ts`
- 公開API: `selectNextTrack(context, intent, policy?)`
- 参照: `VDAP仕様実装順.md` §5.6、`AGENTS.md` §0（入力意味保存および実挙動一致の原則）

この文書は、決定論的選曲ロジックの**挙動に影響するすべての規則・重み・閾値・除外条件・正規化・タイブレーク・クロスフェード小節選択・confidence算出**を人間可読な形で固定する。実装 (`selection.ts`) とこの仕様が食い違った場合は、両者を一致させるまで完了扱いにしない。

## 0. 契約の解決（DjDecision と 候補0件の緊張）

`DjDecision` は `nextTrackId` を必須とし、全フィールドが非オプションである。したがって「妥当な次曲が存在しない」状態を `DjDecision` では表現できない。候補が無いのに `DjDecision` を捏造することは、AGENTS §0.3（実行していない処理を成功として扱わない）に反する。

**解決**: 決定論的ロジックは `DjSelectionResult` を返す。これは次のいずれかである。

- `{ status: "selected", decision: DjDecision, ranking: DjCandidateScore[] }`
- `{ status: "noCandidate", reasons: DjNoCandidateReason[], ranking: DjCandidateScore[] }`

`DjDecision` 型自体は変更しない。VDAPコマンドへ変換するAdapter（順序6）は、`selected` の `decision` をこれまで通り消費する。`ranking` は選定・除外の両方を機械可読に公開する診断であり、選ばれた候補のスコアも除外された候補の理由も検査できる。

## 1. 純粋性と決定性

- `selectNextTrack` は純関数である。時刻・乱数・I/O・グローバル可変状態・例外的副作用を持たない。
- 入力オブジェクトを一切変更しない（配列・オブジェクトはコピーして扱う）。
- タイブレークは入力配列 `context.candidates` の順序に依存しない。最終タイブレークは `trackId` の辞書順である。
- 同じ `(context, intent, policy)` は常にバイト等価な `DjSelectionResult` を返す。
- 派生値（スコア・confidence・reason文字列）は `policy.roundingDecimals`（既定6桁）へ丸めて出力安定性を確保する。この丸めは**派生出力のみ**に適用し、ユーザー入力値には一切適用しない。

## 2. 入力検証（malformed は throw、unusable は除外）

構造的に不正な入力は例外を投げる（プログラマ／設定エラー）。

- `context` / `intent` が非オブジェクト → `TypeError`
- `activeDeckId === inactiveDeckId` → `RangeError`
- `currentTrack` または各 `candidate` が必須フィールドを満たさない、文字列長・配列長・`energy ∈ [0,1]`に違反する → `TypeError` / `RangeError`
- `candidates` 内の `trackId` が重複する → `RangeError`（同一IDのどちらを選ぶかを入力順で決めない）
- `candidates` / `recentlyPlayedTrackIds` / `limits.allowedCrossfadeBars` が配列でない → `TypeError`
- `limits.minPlaybackRate` / `maxPlaybackRate` が非有限、または `min <= 0` / `max < min` → `RangeError`
- `intent` の列挙値、範囲、配列または文字列制約が型・Schema契約に違反する → `TypeError` / `RangeError`（別の列挙値として解釈しない）
- policyの全数値は有限かつ公開範囲内でなければならない。weights / camelotScores / availability shareは`[0,1]`、weights総和は1（許容誤差1e-9）、toleranceは`>0`、crossfade targetは正整数、roundingDecimalsは`[0,12]`の整数、固定値は`tempoSync="tempo"` / `startAt="nextBar"`。違反は `RangeError`
- `DEFAULT_DJ_POLICY` はネストを含め `Object.freeze` 済みであり、共有デフォルトの実行時変更を許さない。

一方、値としては妥当だが実行不能なデータ（例: `candidate.bpm <= 0`、算出rateが可動域外）は**例外にせず、機械可読な除外理由**として扱う。

## 3. テンポ同期playback rate（クランプ禁止）

- 決定論的ロジックは常に `tempoSync = "tempo"`（beat-match）を用いる。`startAt = "nextBar"` 固定。
- 各候補のplayback rate = `currentTrack.bpm / candidate.bpm`（供給BPMから厳密に算出）。
- `candidate.bpm <= 0` → 除外 `invalidBpm`（rate算出不能）。
- `currentTrack.bpm <= 0` → 全体を `noCandidate`（`invalidReferenceBpm`）。参照BPMが無効ならいかなるrateも算出できないため。
- 算出rateが `[minPlaybackRate, maxPlaybackRate]` を外れる場合、**クランプせず**除外する。
  - `rate < min` → `playbackRateBelowRange`
  - `rate > max` → `playbackRateAboveRange`
- 有限BPM同士の除算がオーバーフローしてrateが非有限になった場合 → `invalidPlaybackRate`。

## 4. 除外規則の二層構造

### 4.1 ハード除外（要求曲でも必ず適用）

- `isCurrentTrack`: 現在再生中の曲は選ばない。
- `recentlyPlayed`: `recentlyPlayedTrackIds` に含まれる曲は選ばない。
- `explicitlyExcluded`: `intent.excludedTrackIds` に含まれる曲は選ばない。
- `invalidBpm` / `playbackRateBelowRange` / `playbackRateAboveRange`: §3のrate規則。

### 4.2 選好除外（明示的な requestedTrackId で上書き可能）

- `harmonicPriority === "strict"` かつ camelot関係が `incompatible` → `harmonicClash`。
- `harmonicPriority === "strict"` かつ camelot関係が `unknown`（解析不能）→ `harmonicUnknown`。
- `candidate.genre ∈ avoidedGenres` → `avoidedGenre`。
- `candidate.mood ∩ avoidedMoods ≠ ∅` → `avoidedMood`。

通常経路（requestedTrackId無し）ではハード・選好の両方を満たす候補のみがランキング対象となる。

## 5. requestedTrackId の扱い（入力の厳密保存）

`intent.requestedTrackId` が非nullのとき:

- 候補に存在しない → `noCandidate`（`requestedTrackNotFound`）。他曲へ**代替しない**。
- 存在するがハード除外に該当 → `noCandidate`（`requestedTrackIneligible`, `detail`にハード理由）。**代替しない**。
- 存在しハード除外に非該当 → その曲を選定する。**選好除外（harmonic/avoided/energy）はrequestedを失格にしない**。より具体的な明示指定 (trackId) が一般的選好より優先する。
- 選定された requested 曲は `ranking` の先頭（group 0）に置く（スコア順に依らず）。

同一trackIdが `requestedTrackId` かつ `excludedTrackIds` にある場合は、ハード除外 `explicitlyExcluded` が適用され `requestedTrackIneligible` となる（矛盾入力をどちらか一方に勝手に解釈しない）。

## 6. スコア成分（各 [0,1]）と重み

`totalScore = Σ weight_i × component_i`。`policy.weights` は総和1。既定重み:

| 成分 | 既定重み | 内容 |
|---|---:|---|
| `rateSafety` | 0.30 | rateが1.0（無変速）に近いほど安全。`1 - |rate-1| / max(max-1, 1-min)`（[0,1]へクランプ）。 |
| `tempoDirection` | 0.10 | §6.1 |
| `camelot` | 0.20 | §6.2 |
| `energy` | 0.20 | §6.3 |
| `genreMood` | 0.10 | §6.4 |
| `availability` | 0.10 | §6.5 |

成分は rate が可動域内（scoreable）な候補についてのみ算出する。ハード除外（current/recent/excluded/avoided等）でも rate が有効なら成分を算出して診断に公開する。rate不能時のみ `components=null` / `totalScore=null`。

### 6.1 tempoDirection（`intent.tempoDirection`）

`ratio = candidate.bpm / current.bpm`、`tol = tempoSimilarTolerance`(既定0.02)。

- `any`: 1（中立、順位に影響しない）。
- `similar`: `1 - |ratio-1| / (tol×4)`（[0,1]クランプ）。
- `faster`: `ratio ≥ 1+tol → 1` / `1 < ratio < 1+tol → 0.5` / `ratio ≤ 1 → 0`。
- `slower`: `ratio ≤ 1-tol → 1` / `1-tol < ratio < 1 → 0.5` / `ratio ≥ 1 → 0`。

### 6.2 camelot（`intent.harmonicPriority`）

camelot関係の分類（`classifyCamelot`）:

- `exact`: 同番号・同レター。
- `relative`: 同番号・異レター（平行調）。
- `adjacent`: 同レター・番号が ±1（mod 12、`12↔1` 折り返し）。
- `incompatible`: 上記以外。
- `unknown`: いずれかのcamelotが `^([1-9]|1[0-2])[AB]$` に一致しない。

成分値:

- `harmonicPriority === "ignore"`: 1（中立、順位に影響しない）。
- それ以外: `policy.camelotScores[relation]`（既定 exact=1, adjacent=0.75, relative=0.75, incompatible=0, unknown=0）。

`strict` の場合、`incompatible`/`unknown` は §4.2 で除外されるため、ランキングに残る候補のcamelot成分は正値となる。

### 6.3 energy（`intent.energyDirection` / `targetEnergy`）

- `targetEnergy !== null`: `1 - |candidate.energy - targetEnergy|`（[0,1]クランプ）。targetがある場合はdirectionより優先。
- `targetEnergy === null` のとき（`delta = candidate.energy - current.energy`）:
  - `increase`: `clamp01(0.5 + delta/2)`
  - `decrease`: `clamp01(0.5 - delta/2)`
  - `maintain`: `clamp01(1 - |delta| / energyMaintainTolerance)`（既定 tolerance=0.5）

### 6.4 genreMood

- genre: `preferredGenres` が空 → 1（中立）。それ以外は `candidate.genre ∈ preferredGenres ? 1 : 0`。
- mood: `preferredMoods` が空 → 1（中立）。それ以外は `overlap / preferredMoods.length`（[0,1]クランプ）。
- 合成: `0.5 × genre + 0.5 × mood`。
- avoided は成分ではなく §4.2 の除外で扱う。

### 6.5 availability（セクション/CUE利用可否）

`beatGridShare`(既定0.7)、`cueShare = 1 - beatGridShare`。
`(hasBeatGrid ? beatGridShare : 0) + (hasSectionCues ? cueShare : 0)`。両方trueで1。

## 7. タイブレーク（入力順非依存の全順序）

通常経路で `totalScore` が同値のとき、次の順で比較する（すべて降順、最後のみ昇順）:

1. `totalScore` 降順
2. `components.camelot` 降順
3. `components.energy` 降順
4. `components.rateSafety` 降順
5. `trackId` 辞書順昇順（最終決定タイブレーク、入力配列順に依存しない）

## 8. ranking（診断）の並び

`ranking` は全候補（除外含む）を次のグループ順に並べる:

- group 0: 選定された曲（1件、`selected` 時のみ）
- group 1: eligible（通常除外なし）を §7 の比較で降順
- group 2: それ以外（除外あり）を `trackId` 昇順

`noCandidate` でも診断のため全候補の `ranking` を公開する（可能な限り選定候補があった場合はそれをgroup 0に置く）。

## 9. クロスフェード小節数（供給値のみ、置換禁止）

- `target = policy.crossfadeBarsByUrgency[transitionUrgency]`（既定 quick=4, normal=8, gradual=16）。
- `selectCrossfadeBars`を直接呼ぶ場合も、`target`と各許可値は正整数でなければならず、不正値は補正せず`RangeError`で拒否する。
- 実際の値は **`limits.allowedCrossfadeBars` の中からのみ**選ぶ。`target` に最も近い許可値を選び、距離同点なら小さい方（より速く安全）を選ぶ。
- `allowedCrossfadeBars` が空なら値を捏造せず `noCandidate`（`noAllowedCrossfadeBars`）で失敗する。
- 選定候補が存在しても許可小節が無ければ全体を `noCandidate` とする。

## 10. confidence

`decision.confidence = 選定候補の totalScore`（`roundingDecimals` 桁に丸め、構成上 [0,1]）。重み総和が1かつ各成分が[0,1]のため、追加のクランプは不要。

## 11. reasons（DjDecision.reasons）

`DjDecision.reasons` は選定候補の診断から決定論的に生成する文字列配列（最大8件、各300字以内、`decision.schema.json` 準拠）:

1. `select:<trackId> score=<total>`
2. `tempo:sync rate=<rate> in [<min>,<max>]`
3. `tempoDir:<direction> <curBpm>-><candBpm>`
4. `camelot:<curCamelot>-><candCamelot> <relation> priority=<priority>`
5. `energy:<direction|target=...> <curEnergy>-><candEnergy>`
6. `grid:beat=<bool> section=<bool>`
7. `crossfade:<bars>bars urgency=<urgency>`

機械可読な詳細は `ranking`（`DjCandidateScore`）側が正本であり、`reasons` は人間可読な要約である。

## 12. no-candidate 理由コード

- `emptyCandidateSet`: 候補配列が空。
- `allCandidatesExcluded`: 全候補が最低1つの除外に該当。
- `noAllowedCrossfadeBars`: `allowedCrossfadeBars` が空。
- `invalidReferenceBpm`: 現在曲BPMが `> 0` でない。
- `requestedTrackNotFound`: `requestedTrackId` が候補に存在しない。
- `requestedTrackIneligible`: `requestedTrackId` がハード除外に該当。

## 13. スコープ外（順序6以降）

- provider実装（`Gpt56IntentProvider` / `CodexLocalProvider` / `DeterministicProvider` ラッパ）、AI呼び出し、Backendエンドポイント、Runtime実行、再生。
- `DjIntent` を生成するNLP。この仕様は `DjIntent` を**入力として消費**するのみ。
