# Vibraxis 次期解析出力契約と解析器置換手順（設計案）

作成日: 2026-07-18
状態: 実装前の契約案。`analysis.schema.json` v2を変更するものではない。

## 1. 結論

次期解析形式は、現在の「必ず値が入るコード中心のschema」から、次の3系統を独立に成否判定できるschema v3へ移す。

1. 拍・ダウンビート・拍子
2. 意味ラベル付きセクション
3. 時間区間ごとのハーモニックルートと、局所キー基準のディグリーネーム

フルコード名は任意とする。ベース最低音、転回形、オンコードは成果物にしない。ベース成分を解析に使う場合も、それは**ハーモニックルート推定の根拠**であって、`bass`という未検証の値を出力する理由にはならない。

解析不能な値は`null`、能力全体を実行できなかった場合は`failed`とする。別の値を発明するfallback、固定confidence、失敗を空配列で偽装する処理は禁止する。

## 2. 現行v2で確認した不一致

以下はコードとschemaから確認できる事実である。

| 現行箇所 | 確認した挙動 | 問題 |
|---|---|---|
| `advanced.py` | `bass=root`を無条件代入 | ベース音を解析していないのに解析結果として公開する |
| `advanced.py` | コード候補差を4倍し、`0.05..0.95`へclip | confidenceの確率的意味がなく、最低0.05が発明される |
| `advanced.py` | 局所キーconfidenceが低いとグローバルキーへ置換 | 低信頼を`unknown`にせず別の値へsilent fallbackする |
| `advanced.py` | 先頭をintro、末尾をoutro、残りをenergyと偶奇で命名 | 意味セクションを認識したかのようなラベルになる |
| `librosa_provider.py` | 能力confidenceに固定値を設定 | 曲ごとの内部結果と一致しない |
| `benchmark_golden.py` | コード配列が空でないこととセクション全区間被覆を合格条件にする | 正解との一致を検査していない |
| `overrides.py` | 手動コードの省略時に`bass=root`、confidence 1.0を既定値にする | 人が入力していない意味と確実性を追加する |

このため、v2の`partial`は「精度未検証」であることを示す一方、配列内の個々の値はUIから通常の解析結果に見える。v3では能力状態だけでなく、値単位の由来と不明を表現する。

## 3. 適用する上位原則

`AGENTS.md` §0を本契約の最上位規則とする。解析固有には次のように適用する。

- providerが返した値、明示的変換後の値、人手修正値を区別する。
- スナップ、平滑化、ラベル統合、キー相対ディグリー変換は、規則と適用履歴を公開する。
- 解析できなかった要素を既定キー、既定拍子、隣接ラベル、`root=bass`等で埋めない。
- providerの処理が例外終了した場合、成功配列を出力しない。
- 一部だけ得られた場合は`partial`とし、得られなかったフィールドを`null`にする。
- UIとRuntimeは、`failed`、`partial`、`null`を事実どおり表示・処理する。非表示の代替値を使わない。

## 4. schema v3の基本形

### 4.1 トップレベル

次のフィールドを必須とする。

```json
{
  "schemaVersion": 3,
  "trackId": "...",
  "source": {
    "file": "...",
    "sha256": "...",
    "durationSeconds": 240.0,
    "sampleRate": 44100,
    "decodePipeline": "ffmpeg-.../pcm-f32le"
  },
  "run": {
    "runId": "...",
    "startedAt": "...",
    "completedAt": "...",
    "configHash": "...",
    "pipeline": []
  },
  "meter": { "status": "...", "value": null, "provenance": {}, "error": null },
  "structure": { "status": "...", "value": null, "provenance": {}, "error": null },
  "harmony": { "status": "...", "value": null, "provenance": {}, "error": null }
}
```

`features`は任意の独立能力とする。DJ接続に使うことが確定した特徴だけを追加し、存在しない場合に既定値を作らない。

### 4.2 能力result共通形

```ts
type Status = "complete" | "partial" | "failed" | "skipped"

type CapabilityResult<T> = {
  status: Status
  value: T | null
  provenance: Provenance
  error: null | {
    code: string
    message: string
    stage: string
  }
}
```

規則:

- `complete`: 当該能力の必須出力がすべて得られ、採用済み品質ゲートを通過したprovider/configである。
- `partial`: 実際に得られた値は`value`へ出すが、不明フィールドを`null`にする。欠落理由を`error`へ示す。
- `failed`: `value`は必ず`null`。途中生成物を完成結果として出さない。
- `skipped`: 利用者が選択したprofileにより未実行。`value=null`、`error=null`。
- 空配列は「実行成功し、イベントが0件だった」というproviderの明示結果だけに使う。失敗を空配列で表さない。
- 能力全体の固定confidenceは廃止する。異なるイベントの確率を根拠なく集約しない。

### 4.3 provenance

次を必須とする。

```ts
type Provenance = {
  origin: "provider" | "human" | "derived"
  provider: { name: string; version: string; model: string | null; modelHash: string | null }
  sourceSha256: string
  configHash: string
  transforms: Array<{
    name: string
    version: string
    parameters: object
  }>
  derivedFrom: string[]
  supersedes: string | null
  humanReview: null | {
    annotationSet: string
    annotatorId: string
    reviewedBy: string | null
    adjudicated: boolean
  }
}
```

- `pipeline`には音声decode、stem分離、provider推論、後処理、時間変換を実行順に記録する。
- モデルを使わない場合は`model/modelHash=null`とする。使ったモデル名や重みhashを省略しない。
- 手動修正は元JSONを上書きせず新しいrun/artifactとして保存し、`supersedes`で元を参照する。
- 人手入力をconfidence 1.0へ変換しない。誰がどの正解集合に基づいて確定したかを記録する。
- Runtime向け配列への投影も`derived`処理であり、変換名とversionを固定する。

## 5. 拍・ダウンビート・拍子契約

### 5.1 必須/nullableフィールド

`meter.value`が非nullの場合、次を必須とする。

```ts
type MeterValue = {
  tempoRegions: Array<{
    startSeconds: number
    endSeconds: number
    bpm: number | null
    confidence: Confidence
  }>
  meterRegions: Array<{
    startSeconds: number
    endSeconds: number
    numerator: number | null
    denominator: number | null
    confidence: Confidence
  }>
  beats: Array<{
    timeSeconds: number
    beatIndex: number
    positionInBar: number | null
    confidence: Confidence
  }>
}
```

- `positionInBar=1`だけをdownbeatと定義する。別の`downbeatsSeconds`正本を併存させない。
- 拍は検出できたが小節位相が不明なら、`positionInBar=null`とする。4拍ごとに勝手に1拍目を作らない。
- 拍子を推定できなければnumerator/denominatorは`null`。4/4を既定値にしない。
- BPMはproviderが明示的に返したtempo regionだけに入れる。half/double補正は自動で行わない。
- 利用者が明示したBPM interpretationを適用する機能は、別runに`transforms: [{name:"tempo-interpretation", parameters:{factor:2}}]`を残す。
- 時刻はdecode後音声の先頭を0秒とする。同一音源を異なるdecoderで処理しない。decode pipelineをsourceへ記録する。

### 5.2 Runtime投影

既存`beatsSeconds`は`beats[].timeSeconds`を順序どおり投影する。`downbeatsSeconds`は`positionInBar===1`だけを投影する。`barsSeconds`はdownbeatと同じ配列にする。この変換は`meter-runtime-projection/v1`として公開する。

投影に必要な情報がない場合、Runtimeへ架空の配列を渡さず、その能力を利用不可として示す。

## 6. 意味セクション契約

### 6.1 ラベル集合

canonical labelは次とする。

`intro | verse | preChorus | chorus | buildup | drop | breakdown | bridge | instrumental | solo | outro | other`

- `other`はproviderが「既知ラベル以外」と実際に判定した場合だけ使う。
- providerが判定できない場合は`label=null`であり、`other`へ置換しない。
- provider固有ラベルは`providerLabel`へそのまま残す。
- providerラベルとcanonical labelの意味同値性を注釈ガイドと正解集合で確認できた場合だけ、公開したラベルmapのversionを`transforms`へ記録して変換する。たとえば`break`を名前の類似だけで`breakdown`へ変換してはならない。同値性が未確認なら`label=null`のままにする。
- `build`と`buildup`は同義として暗黙変換せず、採用providerごとの明示mapで扱う。

### 6.2 必須/nullableフィールド

```ts
type StructureValue = {
  sections: Array<{
    interval: { startSeconds: number; endSeconds: number }
    observedInterval: { startSeconds: number; endSeconds: number }
    label: SectionLabel | null
    providerLabel: string | null
    boundaryConfidence: Confidence
    labelConfidence: Confidence
  }>
}
```

- 区間は半開区間`[startSeconds,endSeconds)`。末尾だけ音源durationと一致する。
- provider出力を小節へsnapする場合、元の時刻を`observedInterval`へ保存し、`interval`へ変換後を置く。snapを有効にするのは利用者がその解析profileを明示した場合だけ。
- 全区間被覆は精度の証明ではない。隙間がある場合、無断で隣接区間を延長しない。
- `phrases`は意味セクションから機械的に8小節分割して作らない。独立したphrase providerまたは人手正解が導入されるまで任意・未出力とする。

## 7. ハーモニックルート/ディグリー契約

### 7.1 求める値

求めるのは、ある時間区間で知覚される和声の**ハーモニックルート（pitch class）**と、局所キーの主音を基準にした**ディグリーネーム**である。

これは以下とは異なる。

- ベースstemの最低音
- 実際に鳴っている最低音
- 転回形のbass note
- slash/on-chord表記
- 必ずmajor/minor等まで決定したフルコード名

ベースstem、chroma、複数楽器の音を根拠に使うことはできる。ただし、どの信号とモデルを使ったかはpipelineへ公開する。`bassPitch`はv3の成果物に含めない。

### 7.2 必須/nullable/任意フィールド

```ts
type PitchClass = "C" | "C#" | "D" | "D#" | "E" | "F" |
  "F#" | "G" | "G#" | "A" | "A#" | "B"

type HarmonyValue = {
  keyRegions: Array<{
    interval: { startSeconds: number; endSeconds: number }
    tonic: PitchClass | null
    mode: "major" | "minor" | null
    confidence: Confidence
  }>
  rootRegions: Array<{
    interval: { startSeconds: number; endSeconds: number }
    observedInterval: { startSeconds: number; endSeconds: number }
    harmonicRoot: PitchClass | null
    localKeyRegionIndex: number | null
    degreeName: string | null
    rootConfidence: Confidence
    chordSymbol?: string | null
    chordSymbolConfidence?: Confidence
  }>
}
```

- `harmonicRoot`が不明なら`null`。「コードなし」を意味する`N`と「不明」は別にする。無音/無和声を表す必要がある場合は将来`harmonicState: noHarmony`を追加する。
- `degreeName`は`harmonicRoot`と有効な局所キーの両方が存在するときだけ、公開された`degree-conversion`で導出する。キー不明なら`null`。
- ディグリーはルート位置を表す。初期表記は`I, bII, II, bIII, III, IV, #IV, V, bVI, VI, bVII, VII`を正本とする。v3では大文字Roman numeralをコードqualityではなく、主音からのpitch-class intervalとして定義する。
- major/minor/diminished等のqualityを大文字/小文字へ暗黙埋込みしない。quality providerを将来採用する場合も別フィールドとして出し、`degreeName`の意味を変更しない。
- `chordSymbol`とそのconfidenceはproviderが実際にフルコードを推定した場合だけ任意で出力する。rootからコード名を合成しない。
- slash bassは出力しない。providerがslash chordを返しても、root抽出に使った事実をtransformへ残したうえで成果物からbass成分を採用しない。

### 7.3 confidenceの意味

全イベント共通で次を使う。

```ts
type Confidence = {
  value: number | null
  meaning: "calibratedCorrectnessProbability" | "providerScore" | "notAvailable"
  method: string | null
  calibrationSet: string | null
}
```

- `calibratedCorrectnessProbability`は、固定された評価集合と校正法を示せる場合だけ使う。
- provider固有scoreは`providerScore`とし、正解確率としてUI表示しない。scoreの名称と範囲を`method`へ記録する。
- providerがscoreを返さない、人手修正、意味が不明な値は`value=null, meaning=notAvailable`とする。
- 便宜的な固定値、clipして作る最低値、手動だから1.0という値は禁止する。
- 異なるproviderの`providerScore`を大小比較しない。

## 8. Ground truth契約

### 8.1 正解ファイル

正解は解析出力と別ディレクトリに、音源hashで固定したJSONとして保存する。最低限次を持つ。

```json
{
  "annotationSchemaVersion": 1,
  "trackId": "126_long_bpm142",
  "sourceSha256": "...",
  "audioTimeline": "decoded-wav-sha256:...",
  "annotators": ["..."],
  "reviewedBy": "...",
  "adjudicated": true,
  "meter": {
    "tempoRegions": [],
    "meterRegions": [],
    "beats": []
  },
  "structure": { "sections": [] },
  "harmony": { "keyRegions": [], "rootRegions": [] }
}
```

正解作成規則:

1. 問題が報告された`126 / 127 / 233`は必ず二者注釈と裁定を行う。
2. 現在の全サンプル曲を最低評価集合とし、ジャンル・BPM・曲長の偏りを記録する。
3. provider出力を見ながら正解を作らない。先に人が拍、区切り、rootを聴取して記録する。
4. セクションラベルの定義例と境界規則をannotation guideに固定する。
5. 不明区間は推測せず`null`または`unannotated` maskとして明示し、評価分母からの除外を記録する。
6. provider開発に使う曲と最終gate曲を分ける。少なくとも3曲は最終gateまでblindに保つ。

現行`annotations.json`の`chords:null / sections:null`は正解未作成であり、精度benchmarkとして使用してはならない。

### 8.2 評価指標と暫定合格閾値

以下はハッカソン採用判断用の**暫定閾値**である。評価集合が増えた後にversion付きで改定する。

| 能力 | 指標 | 暫定gate |
|---|---|---:|
| beat | 70ms tolerance F1 | 0.95以上 |
| beat continuity | CMLt | 0.90以上 |
| downbeat | 70ms tolerance F1 | 0.90以上 |
| meter | meter exact accuracy | 0.95以上 |
| blocker曲 | 126/127/233のdownbeat phase | 1拍以上の全体位相誤り0件 |
| section boundary | F1 @ 3.0s | 0.80以上 |
| section boundary | F1 @ 0.5s | 0.55以上 |
| semantic section | 時間重み付きmacro-F1 | 0.70以上 |
| harmonic root | root pitch-class weighted accuracy | 0.75以上 |
| local key | tonic+mode時間重み付きaccuracy | 0.80以上 |
| degree | local-key-relative degree weighted accuracy | 0.70以上 |
| useful coverage | 非null harmonic rootの評価可能時間比 | 0.80以上（accuracyと同時に満たす） |

追加規則:

- aggregateだけでなく曲別値を出す。1曲の全面的な拍ずれを平均で隠さない。
- octave、half/double tempoを正解扱いにする指標だけではDJ用途を満たさない。downbeat phaseと小節位置を別に評価する。
- sectionの「全曲被覆」とイベント件数は精度指標にしない。
- root/degreeの境界差は10Hz時間サンプリングによる時間重み付き正解率で評価し、正解の`unannotated`区間だけ除外する。
- フルコードsymbolはハッカソンgateに含めない。

## 9. Provider bakeoff

providerは採用前に同じdecode WAV、同じground truth、同じマシンで比較する。現時点ではどれも採用確定ではない。

| 候補 | 対象 | Windows/実行条件 | ライセンス確認 | 計算時間 |
|---|---|---|---|---|
| 現行librosa heuristic | controlのみ | 現在native Windowsで動作 | librosa ISC。自作処理 | 実測をbaselineとして記録 |
| All-In-One | beat/downbeat/meter/section boundary。semantic labelは対応語彙だけの部分候補 | 公式READMEではWindowsはNATTENをsource build。PyTorch、madmom、Demucs等を含むため、まずWSL2または隔離環境で検証 | repoはMIT表記。ただし依存物・同梱/取得modelを個別監査する | 公式例はRTX 4090+i9で33分/10曲を73秒。Vibraxis環境では別途実測必須 |
| madmom DBN/RNN | beat/downbeat比較候補 | 古いCython依存がありnative Windowsは要実証 | sourceはBSD、model/dataはCC BY-NC-SA 4.0。配布/将来の商用利用制約があるため製品採用不可、比較実験も条件確認 | 実測必須 |
| ChordMiniのChord-CNN-LSTM / BTC-SL / BTC-PL | chord候補からharmonic rootを抽出 | 公式READMEはnative Windows依存解決を信頼せずWSL2/UbuntuまたはDockerを推奨 | アプリrepoのMITだけでは外部model/weightsの利用条件を包含しない。各weightまで監査完了するまで同梱禁止 | 各modelを個別実測 |
| Demucs bass stem前処理 + root provider | harmonic rootの根拠強化のA/Bだけ | 公式READMEにWindows/Conda手順あり。GPU/CPU両方を測る | codeはMIT。pretrained weightの再配布条件は未解決の公開issueがあるため、weightを同梱しない段階でも取得条件を確認 | stem分離込みで実測 |

計測項目を固定する。

- wall-clock秒/曲
- real-time factor（処理秒 / 音源秒）
- peak RAM / peak VRAM
- 初回model download容量と2回目以降のcache時間
- CPUのみ、利用可能GPUの両方
- Windows native、WSL2/Dockerのどこで成功したか
- provider/model/config/hash

暫定運用gateは、開発機で4分曲を2分以内（RTF 0.5以下）、peak RAM 16GB以下、利用する場合peak VRAM 8GB以下とする。ただし解析は一度きりのoffline処理なので、精度gateを満たす候補が1つだけなら計算時間超過を理由に値を改変せず、`performance gate failed`として採否をユーザー判断へ戻す。

### 一次資料

- All-In-One: https://github.com/mir-aidj/all-in-one
- All-In-One paper: https://arxiv.org/abs/2307.16425
- madmom: https://github.com/CPJKU/madmom
- madmom downbeat implementation: https://github.com/CPJKU/madmom/blob/master/madmom/features/downbeats.py
- ChordMini: https://github.com/ptnghia-j/ChordMiniApp
- ChordMiniで参照されるlarge-vocabulary chord model: https://github.com/music-x-lab/ISMIR2019-Large-Vocabulary-Chord-Recognition
- Demucs: https://github.com/facebookresearch/demucs
- Demucs pretrained model license確認issue: https://github.com/facebookresearch/demucs/issues/327

## 10. Bakeoff実施順

1. 全候補の依存license、model weight license、取得元、hashを台帳化する。未確認候補は実験用隔離環境から出さない。
2. 全音源を1つの固定decode pipelineでWAV化し、decoded WAV hashを正解と解析runに記録する。
3. `126 / 127 / 233`を含むground truthを作る。
4. All-In-Oneとmadmomをbeat/downbeat/sectionで比較する。
5. ChordMini内3modelを同一音源で走らせ、フルsymbolではなくroot pitch classへ同じ公開変換で射影して比較する。
6. 最良root providerについてだけ、原音入力とDemucs bass-stem併用をA/B比較する。bass-stemが精度を上げない場合はpipelineから外す。
7. 精度、曲別失敗、Windows運用、license、計算資源を1表にし、能力ごとにproviderを選ぶ。
8. gate未達の能力は現行heuristicへsilent fallbackせず、`failed`または`partial/null`のままにする。

All-In-Oneの公開語彙は`start/end/intro/outro/break/bridge/inst/solo/verse/chorus`で、要求される`buildup/drop/breakdown`を直接網羅しない。したがって、境界精度が合格してもsemantic label能力を自動的に`complete`にはしない。不足ラベルを別規則で推測せず、別providerまたは人手修正を比較対象にする。

## 11. 段階的移行

### Phase 0: 表示の正直化（ハッカソンP0）

- v2データで`partial`のbeatGrid/harmony/structureを確定情報として表示しない。
- `bass`をUI/Runtime/Agent判断へ渡さない。
- fixed confidenceと未検証semantic labelを採用判断へ使わない。
- 現行解析JSONは比較baselineとして凍結し、再生成で上書きしない。

### Phase 1: Ground truthとbakeoff runner（P0）

- `126 / 127 / 233`の拍・downbeat・section・root/degree正解を先に作る。
- 空でないことではなく、本書のaccuracy指標を計算するrunnerを作る。
- provider出力は本番catalogと別のcandidate artifactへ保存する。

### Phase 2: beat/downbeat/meter provider置換（P0）

- downbeat phaseのgateを通ったproviderだけを採用する。
- schema v3 canonical beat eventsからRuntime配列を投影する。
- 人が修正したgridは新artifactとしてprovenanceを保持する。

### Phase 3: semantic section provider置換（P1）

- 境界とラベルを別々に評価する。
- label mapと任意snap transformをversion固定する。
- gate未達区間は既定のverse/chorusを作らず`null`にする。

### Phase 4: harmonic root/degree provider置換（P1）

- chord provider出力からrootだけを採用するadapterを作り、key regionと公開変換からdegreeを得る。
- bass-stem併用はA/Bでroot精度が改善した場合だけ採用する。
- フルchord symbol、quality、slash bassは接続判断に不要なので後回しにする。

### Phase 5: schema/runtime/UI切替（P1）

- `analysis.schema.json` v3、Python model、TypeScript型、VDAP投影を同一差分で変更する。
- v2からv3へ値を推測する自動移行はしない。音源から再解析する。
- UIはunknown/failed/partialを表示し、hidden fallbackを持たない。
- Runtime binding後の値と画面表示が同じartifact/runIdを参照することを統合テストする。

### ハッカソン後（P2）

- full chord quality/symbolの独立gate
- phrase model
- 調性変化の高度化
- provider scoreの確率校正
- 大規模・ジャンル別評価集合

## 12. 受け入れテスト

実装時には最低限、次を自動化する。

1. `failed`能力の`value`が非nullならschema error。
2. meter不明時に4/4やdownbeatが生成されていないこと。
3. key不明時にdegreeが生成されていないこと。
4. harmonic root不明時にroot/chordが生成されていないこと。
5. `bass`フィールドがv3 schemaに存在しないこと。
6. provider scoreをcalibrated probabilityとして出していないこと。
7. 人手修正がconfidence 1.0を自動生成しないこと。
8. snap前後の時刻とtransformが記録されること。
9. provider例外時に別provider/heuristicへ自動切替しないこと。
10. partial結果の欠落理由が出力されること。
11. catalog、VDAP、UIが同じsource hash/runIdの値を参照すること。
12. 126/127/233について曲別downbeat phase gateが通ること。

## 13. 今すぐ行わないこと

- 現行heuristicの閾値調整でsemantic section/chordを延命する。
- `bass=root`を別名へ変更して残す。
- フルコード解析を先に完成させる。
- providerが出さないconfidenceを独自式で作る。
- 解析失敗時に旧librosa結果を自動採用する。
- model licenseとWindows実行を未確認のまま依存へ追加する。

まず正解データと同一条件bakeoffを作り、能力ごとに勝ったproviderだけを、由来を保ったv3契約へ接続する。
