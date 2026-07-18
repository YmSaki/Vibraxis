# Vibraxis DJ Agent Protocol (VDAP) 仕様 バージョン 1.0

- 文書ステータス: Draft(初版・規範仕様)
- 対象読者: ランタイム(再生エンジン)実装者、クライアント(DJ Agent / UI / ツール)実装者
- 作成日: 2026-07-17
- プロトコル識別子: `vdap`
- プロトコルバージョン: `"1.0"`

---

## 1. はじめに

本仕様は、Vibraxis の 2 デッキ DJ ランタイムを、自律 DJ Agent・UI・外部ツールなどのクライアントがプログラムから制御するためのメッセージプロトコル **Vibraxis DJ Agent Protocol (VDAP)** を定義する。

VDAP は次の設計原則に従う。

1. **単一の権威 (single authority)**: 状態と時刻の正はランタイムただ一つが持つ。クライアントは自前の位置計算・状態複製を「推定」としてのみ扱う。
2. **直交する小さなコマンド集合**: UI のボタンを写像するのではなく、合成可能なプリミティブを定義する。UI の「CUE ボタン」等は本仕様のプリミティブの合成として実現する。
3. **原子性と明示的な失敗**: 音声とその解析メタデータは常に一体で結合(バインド)される。追い越されたロードは決して成功として報告されない。
4. **規範と現状の分離**: 本文は目標挙動を規範として定め、現行エンジンで実現可能な範囲は「実装プロファイル」(§16) として分離する。現行実装が規範に反する箇所は §17 でギャップとして明示する。

本仕様の読者が、リポジトリの現行コードを読まずに相互運用可能なランタイム/クライアントを独立に実装できることを完了条件とする。

## 2. 適用範囲と非目標

### 2.1 適用範囲

- 2 デッキ + ミキサー構成の DJ ランタイムに対する制御・観測プロトコル
- トラックの原子的ロード/アンロード、トランスポート、シーク、パッド/CUE、ゲイン、再生ベロシティ、テンポ解釈、テンポ/位相/小節同期、クロスフェーダー、マスター、スケジュール取消、緊急停止
- 即時/次ビート/次小節/N ビート/N 小節/絶対ランタイム時刻/ソース位置でのスケジューリング
- リビジョン付き状態モデル(スナップショット/デルタ)と時間モデル
- 将来のスクラッチ/ジェスチャーのための一時オーバーライド機構の枠組み

### 2.2 非目標

以下は VDAP 1.0 の範囲外である。

- **選曲知能そのもの**: どの曲をいつ流すかの意思決定(DJIntent、スコアリング、LLM 呼び出し)はクライアント側の責務であり、本仕様は実行面だけを定める。
- **音声データの転送**: PCM やファイル本体をプロトコル上で運ばない。音源とカタログの配信は帯域外(既存の `/api/catalog`, `/tracks/<file>`)とする。
- **カタログ・解析データの管理**: 解析スキーマ(analysis.schema.json v2)の生成・更新は analyze-tool の責務。VDAP はその参照と結合のみ規定する。
- **エフェクト、EQ、キーロック、録音、ループ**: 将来バージョンで能力(capability)として追加する。
- **リモート/マルチユーザー運用と本格的な認証**: 初期トランスポートはローカル限定(§5.3)。
- **外部ネットワーク・外部専有プロトコルへの依存**: 一切要求しない。

## 3. 表記法

本文書のキーワード **MUST**(しなければならない)、**MUST NOT**(してはならない)、**SHOULD**(すべきである)、**SHOULD NOT**(すべきでない)、**MAY**(してもよい) は RFC 2119 / RFC 8174 の意味で解釈する。

JSON の例は説明のためのものであり、コメント(`//`)は実際のメッセージには含めない。フィールド名は camelCase、コマンド名は `名詞.動詞` の小文字ドット区切りで統一する。

## 4. 用語

| 用語 | 定義 |
|---|---|
| **ランタイム (Runtime)** | 音声グラフ・デッキ・ミキサーを保有し、状態と時刻の唯一の権威であるプロセス。現行実装では `DeckEngine` を包むホスト。 |
| **クライアント (Client)** | ランタイムに接続してコマンドを送り状態を購読する主体。DJ Agent、UI、テストハーネス等。 |
| **オリジン (origin)** | コマンドの発生源区分。`"user"`(人間の直接操作)、`"agent"`(自律エージェント)、`"system"`(ランタイム内部)。 |
| **インテント (intent)** | ランタイムに受理された 1 つの変更要求。受理から終端(完了/失敗/取消/追い越し)までのライフサイクルを持つ。 |
| **リビジョン (revision)** | ランタイム状態の単調増加する世代番号。観測可能な状態変化ごとに 1 以上増える。 |
| **バインディング (binding)** | デッキに対する「音声バッファ + 解析メタデータ + トラック識別」の原子的な結合。`bindingId` で識別する。 |
| **ベースベロシティ (baseVelocity)** | PLAY SPEED・テンポ同期が設定する安定再生速度。自然速度に対する比(1.0 = 等速)。 |
| **設定ベロシティ (configuredVelocity)** | baseVelocity に一時オーバーライドを適用した、再生エンジンへ要求する速度。停止中も設定値を保持する。 |
| **ヘッドベロシティ (headVelocity)** | 再生ヘッドの実速度。`playing` かつ前進中は configuredVelocity、pause/ready/ended/empty では 0。位置外挿に用いる。 |
| **再生方向 (direction)** | ヘッドの進行区分。ハッカソン対象の core/beat は `"forward" | "stopped"` のみ。逆再生は §15 の将来拡張であり、本契約には混ぜない。 |
| **テンポ解釈 (tempoInterpretation)** | 解析 BPM を半分/等倍/2 倍として解釈するメタデータ上の設定。音声速度は変えない。 |
| **ビートグリッド (beat grid)** | 解析由来のビート時刻列・ダウンビート時刻列・拍子。クオンタイズの基盤。 |
| **ダウンビート (downbeat)** | 小節の 1 拍目。`beatInBar == 1` と同義。 |
| **ピックアップ (pickup)** | 最初のダウンビートより前のビート領域(弱起)。 |
| **クオンタイズ (quantize)** | コマンド実行時刻をビート/小節境界に整列させること。 |
| **オーバーライド (override)** | ベース値を破壊せずに一時的に実効値を差し替える機構(スクラッチ等)。解除でベース値へ復帰する。 |
| **パニック (panic)** | 全音声を即時停止し予定を全取消する緊急停止。 |

## 5. アーキテクチャとトランスポート

### 5.1 ロール

- ランタイムは正確に 1 つ存在し、複数のクライアント接続を受け付けて **MUST** 同一の状態を見せる。
- ハッカソンの MessagePort 経路では、ランタイムがポート生成時に `uiPort` / `agentPort` を区別し、`uiPort` を role `"ui"`・origin `"user"`、`agentPort` を role `"agent"`・origin `"agent"` に固定する。**MUST**。ポート受信後にクライアントが送る `session.hello.params.role` は認証情報ではなく整合性確認用の申告にすぎない。
- hello の申告 role がポートへ割り当てた role と異なる場合、ランタイムは `E_ROLE_MISMATCH` で接続を拒否 **MUST** する。申告を採用して権限を昇格・降格しては **MUST NOT** ならない。observer を実装する場合も専用 `observerPort` を生成し、受信コマンドをクエリに限定する。
- origin `"system"` はランタイム内部起因(曲終端等)にのみ用い、接続由来のコマンドに割り当てては **MUST NOT** ならない。外部 WebSocket の role 付き認証はハッカソン P0 の範囲外であり、§20 の未解決事項とする。

### 5.2 トランスポート中立性

VDAP はメッセージ指向であり、順序保証のある全二重チャネルであれば任意のトランスポートで動作する(**トランスポート中立**)。要件は次の 3 つのみ。

1. メッセージ境界が保存されること(1 メッセージ = 1 JSON テキスト)。
2. 同一接続内で送信順序が保存されること。
3. 切断がランタイム・クライアント双方で検出可能であること。

### 5.3 推奨初期トランスポート

初期実装は次を **SHOULD** 採用する。

- **同一ブラウザ内クライアント**(UI、ブラウザ内エージェント): `MessagePort`(または同等の in-process チャネル)で JSON 直列化可能なオブジェクトを交換する。ランタイムが `uiPort` / `agentPort` を生成して権限を割り当てる(§5.1)。UI 自身も VDAP クライアントとして実装することを **SHOULD** とする(§17 ギャップ G2 の解消手段)。ハッカソンの正準デモ経路はこの MessagePort 経路である。
- **外部プロセスのクライアント**(Node 上の DJ Agent アダプター等): `ws://127.0.0.1:<port>` の WebSocket(テキストフレーム、UTF-8 JSON)。ランタイムはループバック以外からの接続を **MUST** 拒否し、起動時に生成したランダムトークンをハンドシェイクで検証することを **SHOULD** とする(§20 OD-1)。

## 6. バージョニングと能力交渉

### 6.1 バージョン

- プロトコルバージョンは `"MAJOR.MINOR"` 形式の文字列。本仕様は `"1.0"`。
- MAJOR が異なる実装間に互換性はない。MINOR の増加は後方互換な追加(新コマンド・新フィールド・新能力)のみを含む。
- 受信者は未知のフィールドを **MUST** 無視する(前方互換)。未知のコマンド・イベント種別は §14 のエラーで拒否する。

### 6.2 ハンドシェイク

接続後、クライアントは最初のメッセージとして `session.hello` を **MUST** 送る。ランタイムは hello 以前の他コマンドを `E_PROTOCOL` で **MUST** 拒否する。

`session.hello` パラメータ:

| フィールド | 型 | 必須 | 意味 |
|---|---|---|---|
| `protocolVersions` | string[] | MUST | クライアントが対応するバージョン列 |
| `client` | `{name, version}` | MUST | 実装識別 |
| `role` | `"agent"` \| `"ui"` \| `"observer"` | MUST | 接続へランタイムが割り当てた role の確認値。自己申告で権限を取得できない(§5.1) |
| `token` | string | MAY | ローカルトークン(§5.3) |
| `cancelOnDisconnect` | boolean | MAY | 既定 `true`。切断時にこの接続由来の scheduled Intent と実行中 automation を取り消すか |

ランタイムの応答(クエリ結果、§7.4)には少なくとも次を含める。

| フィールド | 意味 |
|---|---|
| `protocolVersion` | 双方が対応する最大バージョン。共通バージョンがなければ `E_UNSUPPORTED_VERSION` で拒否 |
| `runtime` | `{name, version}` |
| `role` | ランタイムが接続経路から確定した role。hello 申告を反映した値ではない |
| `profile` | `"core"` \| `"beat"` \| `"scratch"`(§16) |
| `deckIds` | 例 `["A","B"]` |
| `capabilities` | §6.3 |
| `limits` | §6.4 |
| `revision` | 現在のリビジョン |

### 6.3 能力 (capabilities)

能力は「名前 → パラメータオブジェクト」のマップで宣言する。クライアントは宣言されていない能力に依存するコマンド/パラメータを **MUST NOT** 送る(送られた場合ランタイムは `E_CAPABILITY_REQUIRED` で拒否する)。

| 能力名 | パラメータ | 意味 |
|---|---|---|
| `velocity` | `{min, max, reverse}` | baseVelocity/configuredVelocity の可動域。ハッカソン core/beat は `reverse:false` |
| `quantize` | `{units:["beat","bar"], toleranceSeconds}` | 音楽的スケジューリング対応。`toleranceSeconds` は実行時刻保証(§10.5) |
| `crossfaderRamp` | `{curves:["equalPower"], durationUnits:["seconds","beats","bars"]}` | `mixer.rampCrossfader` 対応。beat プロファイルでは MUST |
| `phaseSync` | `{}` | `deck.sync` の `tempoPhase` / `tempoBar` モード対応 |
| `grid` | `{source:"analysis"}` | `deck.getGrid` によるビートグリッド全量取得対応 |
| `override` | `{targets:["velocity","gate","crossfader"]}` | 一時オーバーライド(§15)対応 |
| `gesture` | `{formats:["scratchGesture/1"]}` | スクラッチジェスチャー実行対応 |
| `padEdit` | `{}` | `deck.setPad` / `deck.clearPad` 対応 |

### 6.4 制限 (limits)

| フィールド | 既定推奨 | 意味 |
|---|---|---|
| `maxScheduleHorizonSeconds` | 60 | いま以降どこまで先を予約できるか |
| `maxPendingIntents` | 16 | 接続あたりのトップレベル `intents` map 登録数上限 |
| `idempotencyWindowSeconds` | 60 | requestId の結果保持期間(§12.4) |
| `gainRange` | `{min:0, max:1.5}` | デッキゲイン範囲 |
| `masterRange` | `{min:0, max:1}` | マスターゲイン範囲 |

## 7. メッセージエンベロープ

すべてのメッセージはトップレベルに `vdap`(バージョン文字列)と `kind` を持つ JSON オブジェクトである。`kind` は `"request"` / `"ack"` / `"event"` / `"snapshot"` / `"delta"` のいずれか。

### 7.1 リクエスト

```json
{
  "vdap": "1.0",
  "kind": "request",
  "requestId": "c7c2e1c0-4c1a-4c8e-9f6d-0a1b2c3d4e5f",
  "command": "deck.play",
  "params": { "deckId": "A" },
  "expectedRevision": 41,
  "expectedBindingId": "bind-000012",
  "when": { "at": "nextBar" }
}
```

- `requestId`: クライアント生成の一意 ID(UUID を **SHOULD**)。**冪等性キーを兼ねる**(§12.4)。
- `expectedRevision`(MAY): **受理時だけ**検査する前提条件。現在リビジョンと不一致なら `E_STALE_REVISION` で拒否(§12.2)。受理に伴う Intent map 追加や位置更新で revision が進んでも、予約実行時に再検査しては **MUST NOT** ならない。
- `expectedBindingId`(MAY、デッキ対象コマンドのみ): 前提条件。対象デッキの現在の bindingId と不一致なら `E_BINDING_MISMATCH` で拒否。エージェントは位置・パッド系コマンドで **SHOULD** 指定する。
- `when`(MAY): スケジューリング句(§10)。省略時は `{"at":"immediate"}`。

### 7.2 コマンドの分類

- **クエリ** (`session.hello`, `state.get`, `deck.getGrid`): 状態を変更しない。単一の `ack` (`state:"completed"`, `result` 同梱) で **MUST** 応答し、イベントを発しない。
- **ミューテーション**(それ以外すべて): 受理時に `ack` (`state:"accepted"`) を返し、終端は必ずイベント(§13)で報告する。**ack を完了と解釈しては MUST NOT ならない**。

### 7.3 受理応答 (ack)

```json
{
  "vdap": "1.0",
  "kind": "ack",
  "requestId": "c7c2e1c0-...",
  "state": "accepted",
  "intentId": "it-000481",
  "revision": 41,
  "scheduledFor": { "runtimeTime": 128.512, "estimate": true }
}
```

- `intentId`: ランタイム生成。以後の全イベントの相関キー。
- `scheduledFor`(MAY): クオンタイズ時の予測実行時刻。`estimate:true` は再計算されうることを示す。
- 拒否は ack ではなく `state:"rejected"` の ack で返す:

```json
{ "vdap":"1.0", "kind":"ack", "requestId":"...", "state":"rejected",
  "error": { "code":"E_DECK_EMPTY", "retryable":false, "message":"Deck A has no binding." } }
```

### 7.4 クエリ応答

```json
{ "vdap":"1.0", "kind":"ack", "requestId":"...", "state":"completed", "revision":41,
  "result": { } }
```

### 7.5 イベント

```json
{ "vdap":"1.0", "kind":"event", "event":"intent.completed",
  "intentId":"it-000481", "requestId":"c7c2e1c0-...",
  "revision":42, "runtimeTime":128.514, "result": { } }
```

イベント種別は §13 で定義する。すべてのイベントは `revision` と `runtimeTime` を **MUST** 含む。MessagePort デモ経路では、ランタイムは 1 インテントにつき論理終端を正確に 1 回生成し、その接続へ終端イベントを正確に 1 回送信する。クライアント・ランタイムとも自動再送を行わない。汎用トランスポートの再送配送契約は VDAP 1.0 P0 では規定しない(§12.4)。

### 7.6 スナップショットとデルタ

- `kind:"snapshot"`: §9 の状態モデル全体 + `revision`。
- `kind:"delta"`: `fromRevision` から `toRevision` への差分。`patch` はルート状態オブジェクトに適用する **RFC 6902 JSON Patch** の操作配列とする。VDAP 1.0 の送信側は `add` / `remove` / `replace` のみを使用し、受信側は少なくともこの 3 操作を実装 **MUST** する。クライアントは `fromRevision` が自分の保持リビジョンと一致しない場合、patch を適用せず `state.get` で再同期 **MUST** する。
- §16.2 などで存在が必須とされるフィールドを `remove` しては **MUST NOT** ならない。値を未設定状態へ戻す場合は、たとえば `{ "op":"replace", "path":"/decks/A/playback/override", "value":null }` のように JSON の `null` を明示して保持する。配列要素を個別編集してよいが、操作列は記載順に原子的に適用し、途中状態を購読者へ公開しては **MUST NOT** ならない。
- `patch` は `/revision` と `/runtimeTime` を対象にしては **MUST NOT** ならない。受信側は操作列の適用成功後、保持状態の `revision` を `toRevision`、`runtimeTime` を delta エンベロープの `runtimeTime` に設定してから、新状態を単一更新として公開 **MUST** する。いずれかの操作が失敗した場合は部分適用を破棄し、`state.get` で再同期する。

```json
{ "vdap":"1.0", "kind":"delta", "fromRevision":41, "toRevision":42,
  "runtimeTime":128.514,
  "patch": [
    { "op":"replace", "path":"/decks/A/transport/phase", "value":"playing" },
    { "op":"replace", "path":"/decks/A/playback/position",
      "value":{ "sourceSeconds":32.001, "atRuntimeTime":128.514 } }
  ] }
```

## 8. 時間モデル

VDAP は 4 つの時間座標を区別し、混用を禁止する。

### 8.1 ランタイム時刻 (runtimeTime)

- 単位: 秒(float)。単調増加。原点は任意(ランタイム起動時 0 近傍)。
- **これが唯一のスケジューリング権威である。** ブラウザ実装では `AudioContext.currentTime` の時間軸に一致させることを **MUST** とする。
- 全イベント・全スケジューリング・全位置ペアはこの軸で表す。

### 8.2 ソース秒 (sourceSeconds)

- 単位: 秒(float, `0 ≤ x ≤ durationSeconds`)。ロード済み音源内の位置。自然速度(velocity 1.0)で再生したときの経過秒。
- 解析メタデータ(beatsSeconds 等)はすべてソース秒で表現されている。

### 8.3 音楽座標 (musical coordinates)

バインドされた解析のビートグリッドに基づく離散座標。**添字の原点を次のとおり固定する。**

- `beatIndex`: **0 起点**。`beatsSeconds[beatIndex]` がそのビートのソース秒。
- `barIndex`: **0 起点**。`barIndex = 0` の開始は `downbeatsSeconds[0]` である。**MUST**。
- `beatInBar`: **1 起点**。ダウンビートが `beatInBar = 1`。**MUST**。
- `phraseIndex`, `sectionIndex`: 0 起点(解析スキーマの配列添字)。

**ピックアップ(弱起)**: `downbeatsSeconds[0]` より前のビート領域は `barIndex = -1` とする。**MUST**。この領域の `beatInBar` は、最初のダウンビートから逆算して割り当てる。拍子 B/4 でピックアップに k 個のビートがあるとき、その i 番目(0 起点)のビートは `beatInBar = B - k + i + 1` である。例: 4/4 でピックアップ 3 ビートなら `beatInBar` は 2, 3, 4。

**重要な帰結**: `beatInBar` を `beatIndex % beatsPerBar + 1` で計算しては **MUST NOT** ならない。ビート 0 がダウンビートである保証はない(実データで最初のダウンビートは beatIndex 3 のことがある。§17 G3)。

グリッド終端以降の位置には、直近区間の平均ビート長で外挿した座標を **MAY** 与える(その場合 `extrapolated: true` を付す)。

### 8.4 壁時計 (wallClock)

- RFC 3339 文字列。ログ・監査用の参考情報に限る。**スケジューリングに使用しては MUST NOT ならない。**

### 8.5 位置ペアと外挿

再生位置は常に **位置ペア** `{sourceSeconds, atRuntimeTime}` で報告する。**MUST**。クライアントは任意のランタイム時刻 `t` の位置を次式で外挿できる。

```
position(t) = sourceSeconds + (t - atRuntimeTime) × headVelocity
```

- 一時停止・ready・ended・empty 中は `headVelocity = 0` かつ `direction:"stopped"` であり、位置ペアはそのまま静止位置を表す。`configuredVelocity` は表示・次回再生・同期計算のため停止中も保持する。
- ランタイムは velocity・位置の不連続(シーク、再生開始/停止、レート変更、オーバーライド開始/解除)のたびに新しい位置ペアを含むデルタを **MUST** 発行する。
- 連続再生中の高頻度な位置配信は不要である。外挿誤差を抑えるため、再生中はおおむね 1 Hz 以下のハートビートデルタで位置ペアを更新することを **SHOULD** とする。
- これにより分散した位置計算(UI 側の setInterval 集計等)は不要になる。クライアント独自の積算位置を権威として扱っては **MUST NOT** ならない。

## 9. 状態モデル

ランタイムは以下の正準状態(canonical state)を保持し、スナップショット/デルタとして配信する。React 等の UI フレームワーク内部状態を正準状態の置き場にしては **MUST NOT** ならない(§17 G2)。

```json
{
  "revision": 42,
  "runtimeTime": 128.514,
  "audio": { "contextState": "running", "sampleRate": 48000, "outputLatencySeconds": 0.012 },
  "mixer": {
    "crossfader": { "base": 0.0, "override": null, "effective": 0.0,
      "curve": "dj", "automation": null },
    "masterGain": 0.8
  },
  "decks": {
    "A": {
      "deckId": "A",
      "load": { "phase": "idle", "intentId": null, "progress": null },
      "binding": {
        "bindingId": "bind-000012",
        "trackId": "126_long_bpm142",
        "source": { "kind": "catalog", "uri": "/tracks/126_long_BPM142.mp3", "title": "126 long" },
        "sha256": "3f6b…(64hex)",
        "durationSeconds": 214.3,
        "analysis": {
          "analysisRef": "data/analysis/126_long_bpm142.json",
          "schemaVersion": 2,
          "bpm": 142.0,
          "timeSignature": "4/4",
          "beatsPerBar": 4,
          "firstDownbeatSeconds": 1.312,
          "beatCount": 507,
          "barCount": 126,
          "key": "A#", "scale": "major", "camelot": "6B", "energy": 0.8141,
          "grid": { "available": true, "confidence": 0.55, "status": "partial" }
        }
      },
      "transport": { "phase": "playing" },
      "playback": {
        "position": { "sourceSeconds": 32.001, "atRuntimeTime": 128.514 },
        "baseVelocity": 1.0,
        "override": null,
        "configuredVelocity": 1.0,
        "headVelocity": 1.0,
        "direction": "forward"
      },
      "tempo": {
        "interpretation": "normal",
        "baseBpm": 142.0,
        "interpretedBpm": 142.0,
        "effectiveBpm": 142.0
      },
      "gain": 1.0,
      "eq": { "lowDb": 0.0, "midDb": 0.0, "highDb": 0.0 },
      "pads": {
        "selectedSlot": 1,
        "slots": [ { "slot": 1, "type": "hotCue", "label": "INTRO",
          "sourceSeconds": 0.0, "beatIndex": 0, "barIndex": -1, "beatInBar": 2,
          "source": "auto", "locked": false } ]
      }
    },
    "B": {
      "deckId": "B",
      "load": { "phase": "idle", "intentId": null, "progress": null },
      "binding": null,
      "transport": { "phase": "empty" },
      "playback": {
        "position": { "sourceSeconds": 0.0, "atRuntimeTime": 128.514 },
        "baseVelocity": 1.0, "override": null, "configuredVelocity": 1.0,
        "headVelocity": 0.0, "direction": "stopped"
      },
      "tempo": {
        "interpretation": "normal", "baseBpm": null,
        "interpretedBpm": null, "effectiveBpm": null
      },
      "gain": 1.0,
      "eq": { "lowDb": 0.0, "midDb": 0.0, "highDb": 0.0 },
      "pads": { "selectedSlot": 1, "slots": [] }
    }
  },
  "intents": {
    "it-000481": {
      "intentId": "it-000481", "requestId": "c7c2e1c0-...",
      "command": "deck.seek", "origin": "agent", "state": "scheduled",
      "target": { "deckId": "A" }, "domain": "transport",
      "when": { "at": "nextBar" },
      "scheduledFor": { "runtimeTime": 130.2, "estimate": true }
    }
  }
}
```

### 9.1 リビジョン規則

- `revision` は 1 から始まる 64bit 単調増加整数。観測可能な変化(状態フィールドの変化、インテント終端)ごとに **MUST** 増加する。
- 1 つの原子的操作(例: ロード完了 = binding + pads + tempo 同時更新)は **単一のリビジョン増加** で反映する。**MUST**。中間状態(音声だけあって解析がない等)を観測させては **MUST NOT** ならない。
- `intents` はランタイム全体の未終端 Intent map で、キーは `intentId`。デッキ操作・ミキサー操作・ロードを同じ場所で表現し、デッキ配下に `pendingIntents` を重複保持しては **MUST NOT** ならない。各値は少なくとも `intentId` / `requestId` / `command` / `origin` / `state`(`"scheduled"|"executing"`) / `target` / `domain` / `when` を持つ。`scheduledFor` は予測がある場合に含める。
- Intent は ack の受理と同じ原子的更新で map に追加し、終端イベントと同じ revision で map から削除する。即時コマンドも非同期処理中は `state:"executing"` として存在する。終端済み Intent を map に残しては **MUST NOT** ならない。

### 9.2 デッキ・トランスポートのライフサイクル（staged load）

`transport.phase` は **現在の binding の再生状態**、`load.phase` は **次の binding の準備状態**を表し、互いに独立して進行する。

`transport.phase` の状態機械:

```
empty ──ロード成功commit──▶ ready ──deck.play──▶ playing ──曲末端──▶ ended
  ▲                          ▲                    │                  │
  └──────deck.unload─────────┴────deck.pause──────┘                  │
  └──────────────────────────────deck.unload─────────────────────────┘
```

- `empty`: binding なし。`ready`: binding あり・停止中。`playing`: 進行中。`ended`: ソース終端に達し停止(位置はソース終端。既定でヘッドは終端に留まる)。
- `load.phase` は `"idle" | "loading"`。`loading` の間、`load.intentId` は進行中ロードの intentId、`load.progress` は既知なら 0..1、未知なら `null` とする。`idle` では `intentId` と `progress` はともに `null` でなければ **MUST** ならない。
- ロード処理中も旧 binding・transport・playback・pads・tempo を **MUST** 保持し、旧曲の再生を継続できるようにする。旧 binding がなければ `transport.phase` は `empty` のままである。
- ロード成功時のみ、旧 binding から新 binding への交換と pads・tempo・playback 初期位置・`load` の `idle` 化を単一リビジョンで commit する。交換後の `transport.phase` は `ready` とする。
- ロード失敗時は `load` を `idle` に戻す。追い越し時は先行ステージングを破棄し、後発ロードの intentId で `loading` を継続する。`deck.load` / `deck.unload` は即時専用なので、将来予約状態を作っては **MUST NOT** ならない。いずれの場合も unload 自身の実行までは旧 binding とその transport 状態を変更しては **MUST NOT** ならず、部分的な新 binding を残しては **MUST NOT** ならない。
- `deck.unload` は進行中ロードを追い越し、任意の状態から binding と再生状態を解除して `empty` へ遷移する。

### 9.3 ベロシティとテンポの導出規則

```
configuredVelocity = override が有効 ? override.velocity : baseVelocity
headVelocity       = transport.phase == "playing" ? configuredVelocity : 0
direction          = headVelocity > 0 ? "forward" : "stopped"
interpretedBpm     = baseBpm × multiplier(interpretation)   ; half=0.5, normal=1, double=2
effectiveBpm       = interpretedBpm × configuredVelocity
```

- `tempoInterpretation` は **メタデータの解釈のみ** を変える。音声速度・ビートグリッドを変えては **MUST NOT** ならない。クオンタイズの「ビート」「小節」は常に解析グリッドの単位である(§10.3)。
- `baseVelocity` は PLAY SPEED・テンポ同期が書き換える安定値。オーバーライド(§15)は baseVelocity を **MUST NOT** 破壊しない。
- `configuredVelocity` は停止状態と無関係な設定値、`headVelocity` は位置外挿用の実速度である。停止中に effectiveBpm を 0 にしては **MUST NOT** ならない。これにより UI と同期ロジックは停止中も「この設定で再生した場合の BPM」を観測できる。
- ハッカソン対象の core/beat は `baseVelocity > 0`、`configuredVelocity > 0` のみを受理する。したがって `direction` は `forward` または `stopped` の二値となる。逆再生時の方向・BPM 契約は本 P0 では定義しない。
- 解析の `tempo.adjustment`(analyzer 側の BPM 折り畳み記録)と本プロトコルの `tempoInterpretation` は別物であり、フィールドを共有しない。

### 9.4 パッドと CUE

- 各デッキは 8 スロット(`slot`: 1〜8、**1 起点**)のパフォーマンスパッドを持つ。
- ロード時、パッド内容はバインドされた解析/カタログ由来の hotCue で初期化される。`selectedSlot` は 1 に初期化する。**MUST**。
- パッドの座標は `sourceSeconds` を正とし、`beatIndex`/`barIndex`/`beatInBar` は §8.3 の規則に従う参考座標である。両者が矛盾する場合 `sourceSeconds` を優先する。**MUST**。
- 「CUE」は独立コマンドではなく、`deck.selectPad` と `deck.seek`(target: pad)の合成である(§11.7)。空スロットへのシークは `E_PAD_EMPTY`。

## 10. スケジューリング (`when` 句)

`when` は次の allowlist に載るコマンドだけが持てる。省略は `{"at":"immediate"}` と同義である。即時専用コマンドに非 immediate の `when` を指定した場合は `E_SCHEDULE_NOT_ALLOWED` で拒否し、クエリに `when` を付けた場合は `E_INVALID_PARAMS` で拒否する。ランタイムが `quantize` 能力を宣言しない場合、allowlist 上のコマンドでも音楽的 `when` は `E_CAPABILITY_REQUIRED` で拒否する。

| コマンド | immediate | nextBeat / nextBar | P0規則 |
|---|---:|---:|---|
| `deck.play`, `deck.pause`, `deck.seek`, `deck.selectPad` | Yes | Yes | 拍に合わせる transport 操作 |
| `deck.setGain`, `deck.setEq`, `deck.setVelocity`, `deck.sync` | Yes | Yes | 遷移準備 |
| `mixer.setCrossfader`, `mixer.rampCrossfader` | Yes | Yes | ミックス本体。ramp の `when` は開始時刻 |
| `deck.load`, `deck.unload` | Yes | No | 事前準備であり予約不可 |
| `state.subscribe`, `state.unsubscribe` | Yes | No | 接続管理は予約不可 |
| `schedule.cancel`, `runtime.panic` | Yes | No | 取消・緊急停止は即時のみ |
| `deck.setPad`, `deck.clearPad` | Yes | No | 状態編集は予約不可 |
| `deck.setTempoInterpretation`, `mixer.setMasterGain` | Yes | No | P0では即時のみ |

ハッカソン P0 の beat 適合に必須なのは `immediate` / `nextBeat` / `nextBar` だけである。`beats` / `bars` / `runtimeTime` / `sourcePosition` の形式と既存の安全規則は後方互換のため本節に維持するが、追加対応を capability で宣言した実装だけが受理してよい。コマンド allowlist 自体は形式にかかわらず同じである。scratch 拡張コマンドの allowlist は §15.3 に閉じ、本 P0 の適合対象に含めない。

### 10.1 形式

| `when.at` | 追加フィールド | 意味 |
|---|---|---|
| `"immediate"` | — | 即時実行(既定) |
| `"nextBeat"` | — | 参照デッキの次のビート境界 |
| `"nextBar"` | — | 参照デッキの次のダウンビート |
| `"beats"` | `count` (整数 ≥ 1) | 次のビート境界から数えて count 番目のビート(`count:1` は `nextBeat` と等価) |
| `"bars"` | `count` (整数 ≥ 1) | 次のダウンビートから数えて count 番目のダウンビート(`count:1` は `nextBar` と等価) |
| `"runtimeTime"` | `runtimeTime` | 絶対ランタイム時刻 |
| `"sourcePosition"` | `sourceSeconds` | 参照デッキの再生ヘッドが指定ソース位置を順方向に通過する瞬間 |

共通フィールド:

- `deckId`(MAY): 音楽的/ソース位置スケジュールの **参照デッキ**。省略時はコマンドの対象デッキ。対象デッキを持たないコマンド(ミキサー系)で音楽的 `when` を使う場合は **MUST** 指定する。
- `onGridUnavailable`(MAY): `"reject"`(既定) | `"immediate"`。音楽的 `when` がグリッド不能のときの代替動作。`"immediate"` を選んだ場合、完了イベントに `degraded: "immediate"` を **MUST** 記録する。
- `minConfidence`(MAY, 0..1): 参照デッキのグリッド confidence がこれ未満ならグリッド不能として扱う。

### 10.2 グリッド不能の条件

音楽的 `when`(nextBeat/nextBar/beats/bars)は、次のいずれかで「グリッド不能」となり、既定では `E_QUANTIZE_UNAVAILABLE` で拒否する(`reason` を同梱: `"noGrid"` / `"lowConfidence"` / `"notAdvancing"` / `"beyondGrid"`)。

1. 参照デッキに binding がない、または解析グリッドが `available:false`。
2. グリッド confidence < `minConfidence`。
3. 参照デッキが進行していない(`transport.phase != "playing"`、`headVelocity ≤ 0`、または `direction != "forward"`)。
4. 目標境界がグリッド終端を超え、外挿も不能。

この判定は受理時だけではなく、インテントの実行まで継続する。参照 binding・grid・transport・headVelocity・direction・位置の変化ごとにランタイムは実行可能性を再評価 **MUST** する。受理後に参照デッキが pause/ended/headVelocity 0 となった場合は、その時点で `intent.failed`(`E_QUANTIZE_UNAVAILABLE`, `reason:"notAdvancing"`)として終端し、horizon まで保留しては **MUST NOT** ならない。grid の消失・confidence 低下・外挿不能も対応する reason で同様に失敗させる。`onGridUnavailable:"immediate"` によるフォールバックは **受理時** の不能にだけ適用し、受理済み予約の条件喪失を予告なく即時実行へ変えては **MUST NOT** ならない。参照 binding 自体の変更には §12.3 の `bindingChanged` が優先する。同じ user 操作が §12.5 の競合取消と進行不能を同時に生じさせる場合は、同一競合ドメインの agent インテントをまず `userOverride` で取消し、その後に残った参照インテントを再評価する。

### 10.3 目標時刻の計算

参照デッキの現在位置ペアと headVelocity から、目標のソース秒 `s*`(該当ビート/ダウンビートの `beatsSeconds` / `downbeatsSeconds` 値)を選び、

```
targetRuntimeTime = atRuntimeTime + (s* − sourceSeconds) / headVelocity
```

とする。「次の境界」は現在ソース位置より **厳密に大きい** 最小の境界とする。実行までに参照デッキの velocity・位置が変化した場合、ランタイムは目標を **MUST** 再計算する(`scheduledFor.estimate:true` の意味)。再計算の結果、目標が過去になった場合は直近未来の同種境界へ繰り延べる。**MUST**。

`sourcePosition` は音楽グリッドではなく、受理時点の参照 binding における **次の連続した順方向通過**を表す。受理時に次を適用する。

1. 参照デッキに binding がない場合は `E_DECK_EMPTY`、`transport.phase != "playing"`、`headVelocity ≤ 0`、または `direction != "forward"` の場合は `E_QUANTIZE_UNAVAILABLE`(`reason:"notAdvancing"`)で拒否する。
2. 指定 `sourceSeconds` が受理時の外挿現在位置以下なら `E_SCHEDULE_IN_PAST`(`reason:"alreadyPassed"`)で拒否する。後のループ・逆方向シーク・再ロードによる再通過を待っては **MUST NOT** ならない。
3. 受理後に pause/ended/velocity 0 以下となった場合は、即座に `intent.failed`(`E_QUANTIZE_UNAVAILABLE`, `reason:"notAdvancing"`)で終端する。
4. 実行前の seek/pad jump その他の不連続な位置変更で目標位置以上へ飛び越した場合は、`intent.failed`(`E_SCHEDULE_IN_PAST`, `reason:"positionSkipped"`)で終端する。目標より手前への逆方向シークでは予約を維持し、新しい位置ペアから通過時刻を再計算する。
5. 参照 binding の変更には §12.3 の `bindingChanged` が優先する。
6. 同じ user 操作が §12.5 の競合取消と進行不能/位置飛び越しを同時に生じさせる場合は、同一競合ドメインの agent インテントに対する `userOverride` の取消を先に適用する。

### 10.4 共通規則

- allowlist にないコマンドの非 immediate 予約は `E_SCHEDULE_NOT_ALLOWED`。コマンドを実行したり Intent map へ追加したりしては **MUST NOT** ならない。
- `runtimeTime` 指定が現在より過去なら `E_SCHEDULE_IN_PAST`。
- 目標が `maxScheduleHorizonSeconds` を超えるなら `E_HORIZON_EXCEEDED`。
- scheduled Intent と取消可能な実行中 automation は `schedule.cancel`(§11.13)、ロード成功 commit / `deck.unload` による binding 変更(§12.3)、ユーザー競合(§12.5)、パニック(§11.14)で取り消される。`deck.load` の受理だけでは旧 binding 向け Intent を取り消さない。

### 10.5 実行精度

`quantize` 能力を宣言するランタイムは、音楽的/絶対時刻スケジュールの実行を `targetRuntimeTime ± toleranceSeconds` 内で **MUST** 行う。`toleranceSeconds` は 0.010 以下を **SHOULD** とする(WebAudio のノード事前スケジューリングで達成する)。core プロファイルはこの保証を負わない(即時のみ)。

## 11. コマンド

各コマンドの共通事項: デッキ対象コマンドは `params.deckId` を **MUST** 持つ。範囲外の連続値パラメータは **拒否**(`E_OUT_OF_RANGE`)であり、暗黙のクランプをしては **MUST NOT** ならない(クランプはエージェントのバグを隠す。例外: `deck.sync` §11.11 は性質上クランプし `exact` で報告する)。

### 11.1 `session.hello`(クエリ)

§6.2 のとおり。

### 11.2 `state.get`(クエリ) / `state.subscribe` / `state.unsubscribe`

- `state.get {}` → result にスナップショット全体。
- `state.subscribe {}`(ミューテーション扱いだが即時完了): 以後この接続へ `snapshot` を 1 回、続いて `delta` を配信する。
- `state.unsubscribe {}`: 配信停止。
- `state.subscribe` / `state.unsubscribe` は通常のミューテーションと同じく `ack {status:"accepted", intentId}` の後に、同じイベントループターンで論理終端1回の `intent.completed` を返す。subscribe の初回 `snapshot` は `intent.completed` より後に配送する。クエリの completed 直返しへ短絡しては **MUST NOT** ならない。

### 11.3 `deck.getGrid`(クエリ、`grid` 能力)

`{deckId}` → result にバインド中解析のグリッド全量:

```json
{ "bindingId": "bind-000012", "timeSignature": "4/4", "beatsPerBar": 4,
  "bpm": 142.0, "confidence": 0.55,
  "beatsSeconds": [0.0427, 0.4693, "…"],
  "downbeatsSeconds": [1.312, 3.008, "…"],
  "sections": [ "…解析スキーマ準拠…" ], "phrases": [ "…" ] }
```

binding がなければ `E_DECK_EMPTY`、解析なしバインドなら `E_ANALYSIS_UNAVAILABLE`。スナップショットにはグリッド全量を含めず(サイズのため)、本クエリで取得する。**SHOULD**。

### 11.4 `deck.load`

音声と解析メタデータを **原子的に** バインドする。

パラメータ:

| フィールド | 型 | 必須 | 意味 |
|---|---|---|---|
| `deckId` | string | MUST | 対象デッキ |
| `source` | object | MUST | `{kind:"catalog", trackId}` または `{kind:"url", url, title}` |
| `requireAnalysis` | boolean | MAY | 既定: `kind:"catalog"` なら `true`、`"url"` なら `false` |
| `initialPosition` | `{sourceSeconds}` | MAY | 既定 0 |
| `replacePlaying` | boolean | MAY | 既定 `false`。agent が再生中の同一デッキを明示置換する場合だけ `true` |

規範挙動:

1. **再生中 agent load の安全境界**: origin `"agent"` が `transport.phase:"playing"` のデッキへ load する場合、`params.replacePlaying:true` と、受理時の現 binding に一致する `expectedBindingId` の両方を **MUST** 指定する。どちらかがなければ `E_DECK_PLAYING`、ID 不一致なら `E_BINDING_MISMATCH` で受理拒否し、Intent を生成しない。user はこのフラグなしでも操作できる。
2. ロード処理開始時に `load` を `{phase:"loading", intentId, progress:null}` とするが、旧 binding・transport・playback・pads・tempo と、それらに対する未終端 Intent を維持する。旧曲が再生中なら、新ロードの準備中も再生を継続 **MUST** する。
3. `kind:"catalog"` の場合、ランタイムはアクティブな再生バッファとは別のステージング領域で、音声取得・デコードと解析レコードの取得・検証を行う。準備途中の音声・解析・パッドを正準 binding として公開しては **MUST NOT** ならない。
4. `requireAnalysis:true` で解析が取得・検証できない場合、ロード全体を `E_ANALYSIS_UNAVAILABLE` で失敗させる。`false` なら `analysis:null` でバインドできる(音楽的クオンタイズ不可)。失敗時は `load` を `idle` に戻し、旧 binding とその再生状態を完全に保持する。旧 binding がなかった場合だけ `empty` のままとする。
5. 解析レコードの `source.sha256` が既知で、取得音声のハッシュ検証が可能な実装は不一致を `E_LOAD_FAILED` とすることを **SHOULD** とする(音声とメタデータの取り違え防止)。この失敗にも 4 の保持規則を適用する。
6. **追い越し (supersession)**: 準備中の未終端 `deck.load` があるデッキへ新たな `deck.load` / `deck.unload` が受理された場合、先行ロードのインテントは `intent.superseded` で **MUST** 終端する。ただし先行が origin `"user"`、後発が `"agent"` の場合、後発を `E_USER_PRIORITY` で拒否し、先行ロードと旧 binding を維持 **MUST** する。先行ロードを `intent.completed` として報告しては **MUST NOT** ならず、追い越された先行ロードのステージング結果を後から commit しても **MUST NOT** ならない(§17 G1)。`deck.load` による追い越しでは旧 binding を維持し、後発の `intentId` で `load` を継続する。`deck.unload` では §11.5 のとおり全解除する。
   このロード固有の `intent.superseded` は、後発が origin `"user"`、先行が `"agent"` の場合も §12.5 の一般的な `intent.cancelled`(`userOverride`)より優先する。先行ロードへ両方の終端イベントを発行しては **MUST NOT** ならない。
7. 成功時に限り、アクティブ音声を新しいデコード済み音声へ交換し、binding・pads・tempo・playback 初期位置・transport `ready`・load `idle` を **単一リビジョンで**確定する。**MUST**。この commit と同時に、旧 binding に依存する未終端 Intent を §12.3 のとおり取消す。音声だけ先に見える状態や、新旧音声が意図せず重なる状態を作っては **MUST NOT** ならない。
8. 成功時、`intent.completed.result` に確定した `binding`(bindingId を含む)を返す。

### 11.5 `deck.unload`

`{deckId}`。準備中の未終端ロードを追い越し、binding・パッド・該当する未終端 Intent を解除し、`load` を `idle`、transport を `empty` へ遷移させる。ただし user の未終端ロードに対する agent の unload は `E_USER_PRIORITY` で受理拒否する。即時専用であり、冪等(empty かつ load idle への unload は成功)。

### 11.6 `deck.play` / `deck.pause`

- `deck.play {deckId}`: `ready`/`ended` から `playing` へ。`ended` からの play はヘッド位置を維持したまま開始する(先頭に戻さない。先頭再生は seek と合成する)。すでに `playing` なら **成功として no-op**(冪等)。`empty` は `E_DECK_EMPTY`。`load.phase:"loading"` でも旧 binding があれば通常どおり操作できる。AudioContext が suspend されており再開に人間の操作が必要な場合は `E_AUDIO_LOCKED`(retryable)。
- `deck.pause {deckId}`: `playing` から `ready` へ。位置は保持。非 playing への pause は成功 no-op。

### 11.7 `deck.seek`

```json
{ "deckId": "A",
  "target": { "type": "sourceSeconds", "sourceSeconds": 53.7067 },
  "resume": "keep" }
```

- `target.type`: `"sourceSeconds"` | `"beat"`(`beatIndex`) | `"bar"`(`barIndex`) | `"pad"`(`slot`)。音楽座標targetは解析グリッド必須(なければ `E_QUANTIZE_UNAVAILABLE` reason `"noGrid"`)。
- `resume`: `"keep"`(既定: 再生状態を維持) | `"pause"`(シーク後停止) | `"play"`(シーク後再生)。
- 範囲は `[0, durationSeconds]` 内でなければ `E_OUT_OF_RANGE`。
- `target.type:"pad"` で空スロットなら `E_PAD_EMPTY`。パッドの `sourceSeconds` へシークする。
- 完了イベントに適用位置(位置ペア)を **MUST** 含める。
- UI の「CUE ボタン」相当 = `deck.seek {target:{type:"pad",slot:<selectedSlot>}, resume:"pause"}`。

### 11.8 `deck.selectPad` / `deck.setPad` / `deck.clearPad`

- `deck.selectPad {deckId, slot}`: `selectedSlot` を変更(1〜8)。競合ドメインはデッキごとの `padSelection` とし、play/pause/seek の `transport` 予約を取り消さない。
- `deck.setPad {deckId, slot, sourceSeconds, label?}`(`padEdit` 能力): `source:"user"` のパッドを設定。座標(beatIndex 等)はランタイムがグリッドから導出する。
- `deck.clearPad {deckId, slot}`(`padEdit` 能力): `locked:true` のパッドは `E_INVALID_PARAMS` で拒否。

### 11.9 `deck.setGain` / `deck.setEq`

`{deckId, gain}`。線形ゲイン、範囲は `limits.gainRange`(既定 0〜1.5)。短い平滑化(≈10 ms)で適用することを **SHOULD** とする。

`deck.setEq {deckId, band, gainDb}`。`band` は `"low" | "mid" | "high"`、`gainDb` は −12..+12 dB。正準状態の `deck.eq` は常に `{lowDb, midDb, highDb}` を持ち、初期値はすべて 0 dB とする。短い平滑化で適用することを **SHOULD** とする。競合ドメインはデッキごとの `eq` とする。

### 11.10 `deck.setVelocity`

`{deckId, velocity}`。**baseVelocity** を設定する。単位は自然速度に対する比(1.0 = 等速。「再生速度パーセント」を使う UI は `percent / 100` で本フィールドへ変換する)。範囲は `capabilities.velocity.{min,max}`。`reverse:false` のランタイムで `velocity ≤ 0` は `E_OUT_OF_RANGE`。オーバーライド有効中も baseVelocity の変更は受理され、解除後に反映される(§15)。

### 11.11 `deck.setTempoInterpretation` / `deck.sync`

- `deck.setTempoInterpretation {deckId, interpretation}`: `"half"` | `"normal"` | `"double"`。ロード時は `"normal"` に初期化。**MUST**。
- `deck.sync {deckId, reference, mode}`: `deckId`(追従側)を `reference`(基準側)に同期する。

| `mode` | 必要能力 | 規範挙動 |
|---|---|---|
| `"tempo"` | — | `targetBpm = 基準側 effectiveBpm` とし、追従側 `baseVelocity = targetBpm / 追従側 interpretedBpm` を設定する。可動域を超える場合は境界へ **クランプ** し、結果に `exact:false` と `requestedVelocity` を **MUST** 含める |
| `"tempoPhase"` | `phaseSync` | tempo に加え、追従側のビート位相を基準側に整列する。完了後の位相誤差は 25 ms 以下 **MUST**、10 ms 以下 **SHOULD**。整列手段(微小シーク/一時的ナッジ)は実装自由だが、完了後の baseVelocity は tempo モードの値に一致しなければならない(位相合わせの速度変化を残しては **MUST NOT** ならない) |
| `"tempoBar"` | `phaseSync` | tempoPhase に加え、`beatInBar` も一致させる(ダウンビート整列) |

- 両デッキに解析(BPM)が必要。なければ `E_ANALYSIS_UNAVAILABLE`。`tempoPhase`/`tempoBar` は両デッキのグリッドと基準側の進行が必要(不能条件は §10.2 に準ずる)。
- sync は **1 回の設定操作** であり、継続的な追従(フォロー)状態を作らない。基準側がその後変化しても追従側は自動再同期しない。継続フォローは将来能力とする(§20 OD-4)。
- 完了イベント: `{appliedVelocity, requestedVelocity, targetBpm, exact, phaseErrorSeconds?}`。

### 11.12 `mixer.setCrossfader` / `mixer.rampCrossfader` / `mixer.setMasterGain`

- `mixer.setCrossfader {position}`: −1(A 全開)〜 +1(B 全開)。ベース値を設定する。手動操作の既定カーブは `dj` とし、正規化位置 `n = (position+1)/2` に対し `gainA = min(1, 2(1−n))`, `gainB = min(1, 2n)` とする。中央では両デッキがユニティゲインとなり、左右へ動かすと反対側だけを減衰させる。`mixer.rampCrossfader` のカーブは引き続き `equalPower` とする。
- `mixer.setMasterGain {gain}`: 範囲 `limits.masterRange`(既定 0〜1)。

`mixer.rampCrossfader` は beat プロファイルのゴールデンパス用クロスフェーダー automation である。細かな `mixer.setCrossfader` Intent の列へ展開しては **MUST NOT** ならず、1つの Intent として音声エンジンの時間軸へ予約する。

```json
{ "to": 1.0,
  "duration": { "bars": 2 },
  "curve": "equalPower",
  "referenceDeckId": "A" }
```

- `to` は −1..+1。`duration` は `{bars}` / `{beats}` / `{seconds}` の **正確に1つ**を持つ。`bars` / `beats` は正整数、`seconds` は有限の正数。`curve` は P0 では `"equalPower"` のみ。
- `duration.bars` / `duration.beats` では `referenceDeckId` が必須であり、そのデッキの binding・grid・confidence・`headVelocity > 0`・`direction:"forward"` を受理時、開始時、実行中に継続検証する。不能なら §10.2 と同じ `E_QUANTIZE_UNAVAILABLE` と reason を用いる。開始後に不能となった場合は、automation を現在位置で停止して `intent.failed` とし、目標までジャンプしては **MUST NOT** ならない。
- `when` は ramp の **開始時刻**、`duration` は開始後の長さである。`duration.seconds` はランタイム秒で固定する。beats/bars は開始時の次の対応境界から指定個数先までの音楽的区間とし、参照デッキの速度・位置が連続的に変わった場合は終了予定を再計算する。`durationSeconds` は最終的な実経過秒を報告する。
- ramp 開始時のクロスフェーダー値を `from` とし、`to` まで単調に進める。正規化クロスフェーダー位置を時間に対して線形に補間し、各瞬間は `n = (position+1)/2`、`gainA = cos(nπ/2)`, `gainB = sin(nπ/2)` の equal-power 式を適用する。`mixer.crossfader.automation` は実行中 `{intentId, from, to, startedAtRuntimeTime, durationSecondsEstimate}`、それ以外は `null` とする。実行中の `base` / `effective` はその時点の automation 値を表す。
- 音声パラメータはオーディオ時間軸上で連続更新してよい。正準状態の `base` / `effective` は delta・snapshot 生成時点で sampling した値であり、オーディオ量子ごとの revision 増加を要求しない。ただし開始・取消・失敗・完了は必ず revision を進める。
- 競合ドメインは mixer `crossfader`。origin `"user"` の `mixer.setCrossfader` が受理された場合、同ドメインの待機中・実行中 agent ramp を `intent.cancelled`(`reason:"userOverride"`)で終端し、音声 automation を取り消してから、ユーザー指定の手動値を `base` / `effective` に採用し、`automation:null` とする。途中の予定値や `to` へジャンプしては **MUST NOT** ならない。
- ramp は完了時に `intent.completed`、user 操作・panic・`schedule.cancel`・切断時に `intent.cancelled`、参照条件喪失または音声 automation 失敗時に `intent.failed` となる。いずれも ramp の論理終端は1回だけで、終端時の `result` に `{from, to, startedAtRuntimeTime, endedAtRuntimeTime, durationSeconds}` を含める。開始前に取消された場合は `startedAtRuntimeTime:null`, `durationSeconds:0` とする。正常完了では `base:to`, `effective:to`, `automation:null` を同一 revision で確定する。

### 11.13 `schedule.cancel`

トップレベル `intents` map を `intentId`、デッキ/ドメイン、または全件のいずれかで絞り込む。以下はそれぞれ独立した `params` の例である。

```json
{ "filter": { "intentId": "it-000481" } }
```

```json
{ "filter": { "deckId": "A", "domain": "transport" } }
```

```json
{ "filter": { "all": true } }
```

- 一致する `state:"scheduled"` Intent と、取消可能な `state:"executing"` automation(`mixer.rampCrossfader` 等)を `intent.cancelled`(`reason:"clientCancel"`)で終端する。即時の不可分操作がすでに実行済み、または終端済み ID の指定は成功 no-op(結果に `cancelledCount` を返す)。
- role `"agent"` の接続は、**他接続の user 由来インテントを取り消せない**。**MUST**(該当分は黙ってスキップせず `skippedCount` に計上する)。

### 11.14 `runtime.panic`

`{scope: "all" | deckId}`(既定 `"all"`)。緊急停止。

- 範囲内の全デッキを即時 pause し、全オーバーライドを解除し、範囲内の全 scheduled Intent と実行中 automation を `intent.cancelled`(`reason:"panic"`)で終端する。**MUST**。
- ゲイン・クロスフェーダー・binding は保持する(復帰可能性のため)。
- `expectedRevision`/`expectedBindingId` 前提条件があっても **MUST** 無視して実行する。`when` は `immediate` 以外を受理しては **MUST NOT** ならない。いかなる role からも拒否されない(observer を除く)。
- 受理から音声停止まで 50 ms 以内を **SHOULD** とする。

## 12. 原子性・前提条件・競合

### 12.1 原子性

- 1 インテントの効果は単一リビジョンで観測される(§9.1)。
- ロードの原子性は §11.4。「音声はあるがメタデータがない」「メタデータだけ前の曲」の観測は不適合である。

### 12.2 前提条件と stale 拒否

- `expectedRevision` は **受理時に限り**検査する。不一致 → `E_STALE_REVISION`。クライアントは最新スナップショット/デルタを取り込んでから再判断する。受理後は、Intent 自身の map 追加、位置ハートビート、無関係なミキサー操作などで revision が進んでも、その Intent の実行可否に影響させては **MUST NOT** ならない。
- `expectedBindingId` 不一致 → `E_BINDING_MISMATCH`。**位置・パッド・シークなど「特定のトラックであること」を前提とするエージェントコマンドは expectedBindingId を SHOULD 指定する**。これにより「ユーザーが曲を替えた直後に、前の曲向けのシークが誤って当たる」事故を防ぐ。
- スケジュール済み Intent の実行時には `expectedBindingId` と、コマンド固有の実行可能条件だけを再評価する。`expectedRevision` を再評価しては **MUST NOT** ならない。binding 不一致なら `intent.failed`(`E_BINDING_MISMATCH`)で終端する。さらに、実行までの参照デッキの進行可能性と目標位置の有効性を §10.2〜§10.3 のとおり継続評価する。

### 12.3 ロードの追い越しとデッキ内無効化

- 同一デッキへの新規 `deck.load` は準備中の未終端ロードだけを `intent.superseded` とし、アクティブな旧 binding と、それに対する他の未終端 Intent を維持する。ただし先行 user / 後発 agent は後発を `E_USER_PRIORITY` で拒否し、何も追い越さない。
- ロード成功 commit は、トップレベル `intents` map から旧 binding を対象または参照する未終端 Intent を選び、`intent.cancelled`(`reason:"bindingChanged"`)で **MUST** 終端する。新 binding 向けとして明示的に発行されたロード自身の終端はこの取消対象ではない。
- `deck.unload` は準備中の未終端ロードを `intent.superseded` とし、そのデッキの binding を対象または参照するその他の未終端 Intent を `intent.cancelled`(`reason:"bindingChanged"`)で **MUST** 終端する。ただし先行 user ロード / 後発 agent unload は `E_USER_PRIORITY` で後発を拒否し、いずれも終端させない。
- 未終端ロードの許可された追い越しは `intent.superseded` の **正確に1終端**とする。後発 user コマンドによる先行 agent ロードの追い越しにも `userOverride` を重ねない。先行 user / 後発 agent は追い越しではなく後発拒否とし、ロード以外の binding ドメイン競合には §12.5 を適用する。

### 12.4 冪等性

- `requestId` は副作用重複防止キーである。ランタイムは接続ごとに直近の requestId → ack と論理終端要約を、`idempotencyWindowSeconds`(≥60 秒)かつ ≥64 件、**MUST** 保持する。
- MessagePort デモ経路は自動再送を行わない。同一 requestId が重複到着した場合も **再実行せず** 保存済み ack を返すが、すでに送信した終端イベントを再送しては **MUST NOT** ならない。必要なら ack に `terminalSummary` を含めてクライアントを再同期させる。パラメータが異なる同一 requestId は `E_PROTOCOL`。
- したがって保証は「1 Intent につき論理終端1回、MessagePort上の終端配送1回」である。切断・損失を扱う WebSocket 等の at-least-once 配送、再接続 replay、クライアント重複排除の汎用契約は P2 で定義するまで適合要件に含めない。

### 12.5 ユーザーとエージェントの権限

**競合ドメイン** を次のとおり定義する: デッキごとに `binding`(load・unload。競合終端は §11.4〜§12.3 の専用規則を優先) / `transport`(play・pause・seek・pad ジャンプ) / `padSelection`(selectPad) / `velocity`(setVelocity・sync・setTempoInterpretation) / `gain` / `eq`、ミキサーに `crossfader`(`setCrossfader`・`rampCrossfader`) / `master`。

規範規則:

1. **user は agent に優先する。** origin `"user"` のコマンドが受理されたとき、同一競合ドメインの scheduled agent Intent と実行中 agent automation を `intent.cancelled`(`reason:"userOverride"`)で **MUST** 終端する。実行中 ramp の現在値採用は §11.12 に従う。ただし未終端 `deck.load` を user の `deck.load` / `deck.unload` が追い越す場合は、より具体的な §11.4-5 / §12.3 を適用して `intent.superseded` だけを発行する。
2. agent のコマンドは user 由来の未終端 Intent を取り消しても、上書きの目的で先回りしてもならない(**MUST NOT**)。同一競合ドメインに user 由来の未終端 Intent がある agent コマンドは `E_USER_PRIORITY` で受理拒否し、状態と先行 Intent を変更しては **MUST NOT** ならない。
3. すでに **実行済み** の効果は取り消し対象ではない(user が後から上書きするだけである)。
4. `runtime.panic` は origin を問わず常に最優先。**MUST**。
5. role `"agent"` の接続が `cancelOnDisconnect:true`(既定)で切断した場合、その接続由来の scheduled Intent と実行中 automation を `intent.cancelled`(`reason:"disconnect"`)で **MUST** 終端する。音声・状態自体は維持する(再生は止めない)。

## 13. イベント

| イベント | 意味 | 主なペイロード |
|---|---|---|
| `intent.completed` | インテント成功終端 | `result`(コマンド別)、`degraded?` |
| `intent.failed` | 失敗終端 | `error {code, retryable, message, reason?}` |
| `intent.cancelled` | 取消終端 | `reason: "clientCancel"\|"userOverride"\|"bindingChanged"\|"panic"\|"disconnect"` |
| `intent.superseded` | 後続 `deck.load` / `deck.unload` による先行ロードの追い越し終端 | `supersededBy`(intentId) |
| `deck.ended` | ソース終端到達(system 起因の transport 変化) | `deckId`, 位置ペア |
| `runtime.warning` | 非致命の運用警告(外挿グリッド使用等) | `code`, `message` |

- 1 インテントにつき論理終端を正確に 1 回生成する。**MUST**。MessagePort デモ経路ではその終端イベントを正確に 1 回送信し、重複 requestId に対して再送しては **MUST NOT** ならない(§12.4)。
- すべての終端イベントは `intentId` と `requestId` を **MUST** 含む。
- `mixer.rampCrossfader` の全終端イベントは、イベント種別に固有の `error` / `reason` に加えて §11.12 の終端 `result` を **MUST** 含む。
- 状態変化そのものは `delta`(§7.6)で配信され、終端イベントと同一 revision を共有しうる。

## 14. エラーコード・再試行・安全境界

### 14.1 安定エラーコード

| コード | retryable | 意味 |
|---|---|---|
| `E_PROTOCOL` | false | エンベロープ不正、hello 前のコマンド、requestId 再利用の不整合 |
| `E_UNSUPPORTED_VERSION` | false | 共通プロトコルバージョンなし |
| `E_ROLE_MISMATCH` | false | hello の role がランタイム割当ポートの role と不一致 |
| `E_UNSUPPORTED_COMMAND` | false | 未知のコマンド |
| `E_CAPABILITY_REQUIRED` | false | 未交渉の能力に依存 |
| `E_SCHEDULE_NOT_ALLOWED` | false | 即時専用コマンドへ非 immediate の `when` を指定 |
| `E_INVALID_PARAMS` | false | 型・必須違反、locked パッド編集等 |
| `E_OUT_OF_RANGE` | false | 宣言範囲外の連続値 |
| `E_DECK_UNKNOWN` | false | 存在しない deckId |
| `E_DECK_EMPTY` | false | binding が必要なのに transport が empty |
| `E_DECK_PLAYING` | false* | agent の再生中 load に `replacePlaying:true` と正しい expectedBindingId が揃っていない |
| `E_PAD_EMPTY` | false | 空スロット参照 |
| `E_BINDING_MISMATCH` | false* | expectedBindingId 不一致 |
| `E_STALE_REVISION` | false* | expectedRevision 不一致 |
| `E_USER_PRIORITY` | false* | 同一競合ドメインの未終端 user Intent を agent が取消・先回りしようとした |
| `E_ANALYSIS_UNAVAILABLE` | false | 解析が必要な操作で解析なし/取得不能 |
| `E_QUANTIZE_UNAVAILABLE` | false* | §10.2。`reason` 同梱 |
| `E_SCHEDULE_IN_PAST` | false | 過去の runtimeTime、通過済み/飛び越し済み sourcePosition。`reason` は該当時に `"alreadyPassed"` / `"positionSkipped"` |
| `E_HORIZON_EXCEEDED` | false | 予約可能範囲超過 |
| `E_AUDIO_LOCKED` | true | AudioContext 未解放(ユーザー操作待ち)。ユーザー操作後に再試行可 |
| `E_LOAD_FAILED` | true | 取得・デコード・ハッシュ不一致 |
| `E_BUSY` | true | `maxPendingIntents` 超過等の一時的過負荷 |
| `E_TIMEOUT` | true | ランタイム内部の時間切れ |
| `E_INTERNAL` | true | その他の内部エラー |

`false*`: 同一リクエストの機械的再送では解決しないが、最新状態を取得し前提を組み直せば再試行に意味がある(エラーオブジェクトの `retryable` は機械的再送可否を表す)。

エラーオブジェクト: `{code, retryable, message, reason?, details?}`。`code` と `reason` は安定契約であり、`message` は人間向けで安定性を保証しない。

### 14.2 安全境界

- ランタイムは hello で宣言した範囲(velocity/gain/master/horizon)を **MUST** 強制する。宣言範囲は実装のハード安全限界以下でなければならない。
- ランタイムは接続単位のレート制限を **MAY** 課し、超過は `E_BUSY` で拒否する。

### 14.3 緊急停止

`runtime.panic`(§11.14)は全プロファイル **MUST** 実装。エージェント実装者は、想定外の状態不一致(連続する `E_BINDING_MISMATCH` 等)を検出したら panic ではなくまず再同期を行い、音響事故(暴走ループ・過大音量)の恐れがある場合に限り panic を使うことを **SHOULD** とする。

## 15. 一時オーバーライドとスクラッチ(将来拡張・scratch プロファイル)

本節は `override`/`gesture` 能力を宣言するランタイムにのみ適用される。設計は memo/scratch-playback.md の速度モデルを規範化したものである。

### 15.1 オーバーライドモデル

- オーバーライド対象は `velocity`(デッキ)、`gate`(デッキゲインの乗算包絡, 0..1)、`crossfader`(ミキサー)。
- `gate` の正準状態フィールドと delta path は scratch プロファイルを実装する P3 で定義する。core/beat の正準 State に未定義の `gate` override を追加しては **MUST NOT** ならない。
- 各対象は「ベース値」と「オーバーライド」を分離して保持する: `effective = override.active ? override.value : base`。
- オーバーライドの解除はベース値の再計算を伴わない。解除時点の **最新の** ベース値へ復帰する。**MUST**(オーバーライド中に受理された `deck.setVelocity` / `deck.sync` / `mixer.setCrossfader` はベース値を更新し、解除後に自然に反映される)。
- オーバーライドは baseVelocity・ユーザー設定クロスフェーダー値を **MUST NOT** 破壊しない。

### 15.2 逆再生に関する注意(規範)

`Web Audio API` の `AudioBufferSourceNode` は負の `playbackRate` による逆再生を提供しない。したがって **負の velocity、サンプル精度の連続ヘッド移動、停止(velocity 0)からの滑らかな往復は、AudioWorklet 等でヘッド位置を自前管理するデッキ実装を前提とする**。core/beat プロファイルのランタイムは `capabilities.velocity.reverse:false` を宣言し、負値・オーバーライド系コマンドを受理しては **MUST NOT** ならない。本仕様は現行エンジンが逆再生可能であるとは主張しない。

### 15.3 ジェスチャー

- `deck.applyGesture {deckId, gesture | gestureId, anchor}`: `anchor` は `"currentPosition"` | `"selectedPad"`。ジェスチャーは `scratchGesture/1` 形式(下記)の velocity/gate/crossfader 包絡線をランタイム時刻軸へ写像して実行する 1 インテントである。実行中は該当対象のオーバーライドが active になり、終了(`durationMs` + `releaseMs`)で自動解除・`intent.completed` となる。
- `deck.releaseOverrides {deckId}`: 進行中のジェスチャー/手動オーバーライドを即時解除する(ジェスチャーインテントは `intent.cancelled` で終端)。
- velocity 包絡線の値は **自然速度比ではなく baseVelocity 比** とする(`1.0` = そのときのベース速度)。ランタイムは各サンプルで `override.velocity = baseVelocity × gesture.playhead.velocity` という絶対速度へ解決してから §9.3 の `configuredVelocity` に適用する。これにより曲の BPM・PLAY SPEED が違っても同じジェスチャーを再利用できる。**MUST**。

```json
{ "format": "scratchGesture/1", "id": "baby-scratch-2", "name": "Baby 2",
  "durationMs": 800, "releaseMs": 40,
  "playhead": [ {"timeMs":0,"velocity":0}, {"timeMs":200,"velocity":1.6},
                {"timeMs":400,"velocity":-1.2}, {"timeMs":800,"velocity":0} ],
  "gate":     [ {"timeMs":0,"gain":1}, {"timeMs":390,"gain":0}, {"timeMs":420,"gain":1} ] }
```

- ジェスチャーは `when` 句でクオンタイズ可能(例: `{"at":"nextBeat"}`)。
- パッドの `type` に `"gesture"` を追加してよい(`MAY`)。その場合 `deck.seek {type:"pad"}` の対象にはならず、専用の `deck.applyGesture {gestureId}` 参照で用いる。

## 16. 実装プロファイル

プロファイルは「どの規範をどこまで満たすか」の束であり、hello の `profile` と `capabilities` で宣言する。上位プロファイルは下位を包含する。

### 16.1 プロファイル一覧

| 項目 | **core**(現行エンジンで実装可能) | **beat**(ビート対応) | **scratch**(AudioWorklet) |
|---|---|---|---|
| エンベロープ/リビジョン/MessagePort重複防止/権限規則 (§7, §9.1, §12) | MUST | MUST | MUST |
| 位置ペア報告 (§8.5) | MUST | MUST | MUST |
| 原子ロード/追い越し (§11.4) | MUST | MUST | MUST |
| `when` | `immediate` のみ | P0 MUST: `immediate`/`nextBeat`/`nextBar`。その他は追加対応 MAY (§10) | beat を包含 |
| `deck.getGrid` (`grid` 能力) | MUST(解析バインド時) | MUST | MUST |
| `deck.sync` | `tempo` のみ | `tempo`/`tempoPhase`/`tempoBar` | 同左 |
| `schedule.cancel` | MUST(scheduled Intent) | MUST(scheduled + 実行中automation) | MUST |
| `runtime.panic` | MUST | MUST | MUST |
| `mixer.rampCrossfader` | MUST NOT | MUST (`crossfaderRamp` 能力) | MUST |
| velocity 範囲 | `{min:0.5, max:1.5, reverse:false}` | 同左(拡大 MAY) | `reverse:true`(例 `{min:-4, max:4}`) |
| 実行精度保証 (§10.5) | なし(即時のみ) | MUST(±10 ms SHOULD) | MUST |
| オーバーライド/ジェスチャー (§15) | MUST NOT(能力非宣言) | MUST NOT | MUST |
| `padEdit` | MAY | MAY | MAY |

### 16.2 プロファイル別の必須フィールド

- core: 状態モデルのトップレベル `intents` map と、全デッキの `deckId` / `load` / `binding` / `transport` / `playback` / `tempo` / `gain` / `eq` / `pads` を **MUST** 存在させる。`eq` は `lowDb` / `midDb` / `highDb` を常に持つ。empty デッキでは `binding:null`、BPM 未確定値は `null` とする。`playback` は `baseVelocity` / `configuredVelocity` / `headVelocity` / `direction` / `override` を常に持つ。`playback.override`、`mixer.crossfader.override`、`mixer.crossfader.automation` は常に `null` でよいが、フィールド自体を **MUST** 存在させる(クライアントの分岐と JSON Patch path を安定させるため)。デッキ配下の `pendingIntents` は存在しては **MUST NOT** ならない。
- beat: core に加え、`binding.analysis.grid` の `available`/`confidence` を正しく反映し、`deck.getGrid` がスキーマ v2 の配列をそのまま返し、`mixer.rampCrossfader` と実行中の `mixer.crossfader.automation` を実装すること。
- scratch: `playback.override` に `{active:true, source:"gesture"|"manual", velocity, intentId?}` を反映すること。

### 16.3 core プロファイルの注記

core は現行 `DeckEngine` の上にアダプター層(トップレベル Intent 管理・リビジョン・MessagePort requestId 重複防止・ステージング付き原子ロード修正)を足すことで実装可能である。シークが「停止→再開」で実現され小さな途切れを伴うことは core では許容する(beat 以上では §10.5 の精度内で連続的であること **SHOULD**)。

## 17. 現行実装とのギャップ(情報提供、ただし各項の不変条件は規範)

| # | 不変条件(規範) | 現行実装のギャップ |
|---|---|---|
| G1 | 追い越されたロードは成功として観測されない (§11.4-5) | `DeckEngine.loadArrayBuffer` は世代不一致時に **正常 resolve** するため、`App.tsx` の `loadCatalogTrack` が古いロードの `await` 成功後に `deckTracks` を上書きし、負けたはずのメタデータが勝つ余地がある |
| G2 | 正準状態とトップレベル Intent map はランタイムが一元保持 (§9) | トラックメタデータ・tempoInterpretation・selectedSlot が React state(`deckTracks` 等)に、音声状態が `DeckEngine` に分散しており、原子性・購読一貫性がない |
| G3 | `beatInBar` はダウンビート位相から導出 (§8.3) | `catalog.py` は `beatInBar = startBeat % 4 + 1` で計算しており、最初のダウンビートが beatIndex 3 にある実データでは全パッドの拍位置表示が誤る |
| G4 | `barIndex` 0 の原点は `downbeatsSeconds[0]` (§8.3) | カタログのセクションは `startSeconds:0.0` に `startBar:0` を与えており、bar 0 の開始(1.312 s)と矛盾。ピックアップ領域の扱い(barIndex −1)が未定義のまま流通している |
| G5 | 音声と解析は同一実体に結合 (§11.4-4) | 解析レコードに sha256 はあるが、ロード経路でファイル実体との照合をしていない |
| G6 | 範囲外パラメータは拒否 (§11) | `DeckEngine` は gain/rate/crossfader を黙ってクランプする(UI 直結では妥当だが、プロトコル境界では隠蔽になる) |
| G7 | テンポ同期のクランプは結果で報告 (§11.11) | `calculateTempoSync` は `exact` を返すが通知は UI バナー止まりで、機械可読な結果契約がない |
| G8 | 位置は位置ペアで配信 (§8.5) | 100 ms の `setInterval` によるスナップショット連打で位置を配っており、外挿契約がない |
| G9 | 新ロードの準備中も旧 binding と再生を保持し、成功時だけ交換する (§9.2, §11.4) | `DeckEngine.loadArrayBuffer` はロード開始時に現在のソースを停止して `buffer=null` とするため、別バッファへの事前デコードと commit 時交換ができない |
| G10 | base/configured/head velocity と停止中 BPM を分離する (§8.5, §9.3) | 現行 UI/Engine は playbackRate と transport 状態から表示値・実ヘッド速度を明確に分離していない |
| G11 | beat 遷移は単一 `mixer.rampCrossfader` Intent として実行する (§11.12) | 現行ミキサーは即時クロスフェーダー設定だけで、取消可能な Web Audio automation と終端結果がない |

ランタイム実装者は、VDAP 準拠層の実装時に G1〜G11 を解消しなければならない(core プロファイルでも G1・G2・G8〜G10 は必須対象、G11 は beat 対象である。G3・G4 は analyze-tool/catalog 側の修正を要する)。

## 18. 適合性要件

### 18.1 ランタイム適合性

ランタイムは、宣言したプロファイルの MUST 項目すべてと §18.3 の該当テストを満たすとき適合とする。特に:

1. hello 前コマンドの拒否、未知コマンド/未交渉能力の拒否。
2. すべてのミューテーションが ack → 正確に 1 つの論理終端。MessagePort では終端イベントを1回配送し再送しない。
3. 原子ロード・追い越し・binding 不一致拒否。
4. リビジョン単調性と delta の整合(JSON Patch を順に適用した状態が `state.get` と一致)。
5. 同一 requestId の重複受信で副作用が重複しない。
6. user 優先規則と panic。

### 18.2 クライアント適合性

1. hello を最初に送り、未交渉能力を使わない。
2. ack を完了と解釈しない。終端イベントで結果を確定する。
3. 位置は位置ペアから外挿し、独自積算を権威にしない。
4. `E_STALE_REVISION` / `E_BINDING_MISMATCH` 受領時は再同期してから再判断する。
5. MessagePort デモ経路では自動再送しない。応答不明時は `state.get` と Intent map で再同期し、新 requestId で盲目的に再発行しない。

### 18.3 テストマトリクス

| ID | 対象 | 内容 | 合格条件 | プロファイル |
|---|---|---|---|---|
| T1 | §6 | 共通バージョンなし hello | `E_UNSUPPORTED_VERSION`、接続は継続または明示クローズ | 全 |
| T2 | §7 | hello 前に `deck.play` | `E_PROTOCOL` | 全 |
| T3 | §11.4 | 通常ロード | 準備中は旧 binding/transport が維持され、単一リビジョンで新 binding+pads+tempo+playback+transport が出現。中間 binding の delta が存在しない | 全 |
| T4 | §11.4-5 | ロード中に同一デッキへ再ロード | 先行が `intent.superseded`、後発のみ `intent.completed`。commit まで旧 binding が維持され、最終 binding は後発 | 全 |
| T5 | §12.4 | MessagePort へ同一 requestId を重複送信(完了後/実行前) | 再実行なし、ack は再提示可、送信済み終端イベントは再送されない | 全 |
| T6 | §12.2 | 古い expectedRevision 付きコマンド、および正しいrevisionで受理後にIntent追加/位置更新でrevisionが進む予約 | 前者は `E_STALE_REVISION`・状態不変。後者は自分自身/無関係更新でstaleにならず実行 | 全 |
| T7 | §12.2 | ロード後に旧 bindingId 付き seek | `E_BINDING_MISMATCH` | 全 |
| T8 | §8.5 | 再生中に任意時刻 2 点で外挿位置と実位置を比較 | 誤差 ≤ 30 ms(core)、≤ 15 ms(beat 以上) | 全 |
| T9 | §10 | `nextBar` の `deck.seek` | 実行時刻がダウンビート ± tolerance | beat+ |
| T10 | §10.2 | 解析なしトラックへ `nextBeat` | `E_QUANTIZE_UNAVAILABLE` (`reason:"noGrid"`)。`onGridUnavailable:"immediate"` なら即時実行 + `degraded` | beat+ |
| T11 | §11.11 | `tempoPhase` 同期 | baseVelocity が tempo 値、位相誤差 ≤ 25 ms | beat+ |
| T12 | §11.12, §12.5 | agent の crossfader ramp 待機中/実行中に user が crossfader 操作 | ramp は `intent.cancelled (userOverride)` の1終端。automationを止め、ユーザー値をbase/effectiveへ採用 | beat+ |
| T13 | §11.14 | 再生・予約多数の状態で panic | ≤ 50 ms 目標で全停止、全予約 cancelled、binding/gain 保持 | 全 |
| T14 | §11.11 | 可動域外の tempo 同期 | クランプ + `exact:false` + `requestedVelocity` | 全 |
| T15 | §11 | 範囲外 gain/velocity | `E_OUT_OF_RANGE`、状態不変 | 全 |
| T16 | §11.10, §15 | 負 velocity を core/beat へ送信 | `E_OUT_OF_RANGE`、状態不変(逆再生を偽装しない) | core/beat |
| T17 | §15 | ジェスチャー実行と解除後の速度 | 実行中 effective が包絡線 × base、解除後 = 最新 base | scratch |
| T18 | §12.5 | agent 接続の切断 | その接続のscheduled Intent/実行中automationが `cancelled (disconnect)`、再生継続 | 全 |
| T19 | §9.2 | 曲終端 | `deck.ended` 発行、phase `ended`、位置=終端 | 全 |
| T20 | §7.6 | RFC 6902 delta 列の適用(`override`/`binding` の `null` 化を含む) | 連番適用結果が `state.get` と深い等価で、必須 nullable フィールドが削除されない | 全 |
| T21 | §9.2, §11.4 | `replacePlaying:true` + 正しいbinding前提で許可した再生中デッキへのagent loadが取得/解析失敗 | 旧 binding・位置・transport が保持され再生継続。新ロードだけ `intent.failed`、load は `idle` | 全 |
| T22 | §10.2 | A を参照する `nextBar` の mixer 予約受理後、A を pause | 即 `intent.failed` (`E_QUANTIZE_UNAVAILABLE`, `reason:"notAdvancing"`)。horizon まで残留せず即時実行もしない | beat+ |
| T23 | §10.3 | 通過済み `sourcePosition` の受理、および受理後の seek 飛び越し | 前者は `E_SCHEDULE_IN_PAST` (`alreadyPassed`)で拒否、後者は `intent.failed` (`positionSkipped`) | beat+ |
| T24 | §11.4-5, §12.3, §12.5 | agent の未終端 load を user の load/unload が追い越す | 先行 load は `intent.superseded` の正確に1終端。`userOverride` を重複発行しない | 全 |
| T25 | §11.4-5, §12.3, §12.5 | user の未終端 load 中に agent が load/unload | 後発 agent は `E_USER_PRIORITY` で受理拒否。先行 user load・旧 binding・再生は不変 | 全 |
| T26 | §5.1, §6.2 | `agentPort` から hello role `ui`、または `uiPort` から role `agent` | `E_ROLE_MISMATCH`。申告roleの権限を一切付与しない | 全 |
| T27 | §10 | `deck.load` / `state.subscribe` / `runtime.panic` へ `nextBar` を指定 | `E_SCHEDULE_NOT_ALLOWED`、Intent未生成・状態不変 | 全 |
| T28 | §11.4 | 再生中デッキへagent loadを送る | 既定は `E_DECK_PLAYING`。`replacePlaying:true` + 正しいexpectedBindingIdだけ受理。不一致は `E_BINDING_MISMATCH` | 全 |
| T29 | §11.12 | A参照2 barsのramp、および途中でAをpause | 正常時はequal-powerで単調遷移し終端result全フィールドあり。pause時は現在値で停止し `intent.failed (notAdvancing)` | beat+ |
| T30 | §8.5, §9.3 | velocity 1.25でplaying→pause→play | configuredVelocity/effectiveBpmは保持、pause中headVelocity=0/direction stopped、再開時headVelocity=1.25/direction forward | 全 |

## 19. 完全な JSON 交換例

例中の `…` は省略を表す。

### 19.1 ハンドシェイク

ランタイムが生成した `agentPort` を DJ Agent Adapter に渡した例である。role はポート割当済みで、hello はその確認値を送る。

```json
{ "vdap":"1.0", "kind":"request", "requestId":"9b0e…-01", "command":"session.hello",
  "params": { "protocolVersions":["1.0"],
    "client":{"name":"vibraxis-dj-agent","version":"0.3.0"},
    "role":"agent", "token":"lm3k…", "cancelOnDisconnect":true } }
```

```json
{ "vdap":"1.0", "kind":"ack", "requestId":"9b0e…-01", "state":"completed", "revision":17,
  "result": {
    "protocolVersion":"1.0",
    "runtime":{"name":"vibraxis-runtime","version":"1.4.0"},
    "role":"agent",
    "profile":"beat",
    "deckIds":["A","B"],
    "capabilities": {
      "velocity":{"min":0.5,"max":1.5,"reverse":false},
      "quantize":{"units":["beat","bar"],"toleranceSeconds":0.01},
      "crossfaderRamp":{"curves":["equalPower"],"durationUnits":["seconds","beats","bars"]},
      "phaseSync":{},
      "grid":{"source":"analysis"}
    },
    "limits": { "maxScheduleHorizonSeconds":60, "maxPendingIntents":16,
      "idempotencyWindowSeconds":60,
      "gainRange":{"min":0,"max":1.5}, "masterRange":{"min":0,"max":1} },
    "revision":17 } }
```

### 19.2 原子的ロード

```json
{ "vdap":"1.0", "kind":"request", "requestId":"9b0e…-02", "command":"deck.load",
  "params": { "deckId":"B",
    "source": { "kind":"catalog", "trackId":"127_long_bpm155" },
    "requireAnalysis": true } }
```

```json
{ "vdap":"1.0", "kind":"ack", "requestId":"9b0e…-02", "state":"accepted",
  "intentId":"it-000512", "revision":18 }
```

(ロード準備中も B の旧 binding と再生は維持される。成功時、binding・pads・tempo・playback・transport と load idle が revision 19 で同時に切り替わる)

```json
{ "vdap":"1.0", "kind":"event", "event":"intent.completed",
  "intentId":"it-000512", "requestId":"9b0e…-02", "revision":19, "runtimeTime":210.442,
  "result": { "binding": {
    "bindingId":"bind-000031", "trackId":"127_long_bpm155",
    "source":{"kind":"catalog","uri":"/tracks/127_long_BPM155.mp3","title":"127 long"},
    "sha256":"ab12…", "durationSeconds":198.7,
    "analysis": { "analysisRef":"data/analysis/127_long_bpm155.json", "schemaVersion":2,
      "bpm":155.0, "timeSignature":"4/4", "beatsPerBar":4,
      "firstDownbeatSeconds":0.905, "beatCount":511, "barCount":127,
      "key":"F","scale":"minor","camelot":"4A","energy":0.77,
      "grid":{"available":true,"confidence":0.55,"status":"partial"} } } } }
```

### 19.3 クオンタイズされた CUE(次の小節頭で選択パッドへ飛び、再生継続)

```json
{ "vdap":"1.0", "kind":"request", "requestId":"9b0e…-07", "command":"deck.seek",
  "expectedBindingId":"bind-000031",
  "params": { "deckId":"B", "target":{"type":"pad","slot":4}, "resume":"play" },
  "when": { "at":"nextBar", "onGridUnavailable":"reject", "minConfidence":0.4 } }
```

```json
{ "vdap":"1.0", "kind":"ack", "requestId":"9b0e…-07", "state":"accepted",
  "intentId":"it-000530", "revision":24,
  "scheduledFor": { "runtimeTime":221.318, "estimate":true } }
```

```json
{ "vdap":"1.0", "kind":"event", "event":"intent.completed",
  "intentId":"it-000530", "requestId":"9b0e…-07", "revision":25, "runtimeTime":221.320,
  "result": { "applied": {
      "position": { "sourceSeconds":53.7067, "atRuntimeTime":221.320 },
      "transport": { "phase":"playing" } } } }
```

### 19.4 テンポ + 位相同期(Deck B を Deck A へ)

```json
{ "vdap":"1.0", "kind":"request", "requestId":"9b0e…-11", "command":"deck.sync",
  "params": { "deckId":"B", "reference":"A", "mode":"tempoPhase" },
  "when": { "at":"nextBeat", "deckId":"A" } }
```

```json
{ "vdap":"1.0", "kind":"ack", "requestId":"9b0e…-11", "state":"accepted",
  "intentId":"it-000544", "revision":31,
  "scheduledFor": { "runtimeTime":233.912, "estimate":true } }
```

```json
{ "vdap":"1.0", "kind":"event", "event":"intent.completed",
  "intentId":"it-000544", "requestId":"9b0e…-11", "revision":32, "runtimeTime":233.915,
  "result": { "targetBpm":142.0, "requestedVelocity":0.9161,
    "appliedVelocity":0.9161, "exact":true, "phaseErrorSeconds":0.006 } }
```

### 19.5 ユーザー割り込み(agent の予約をユーザー操作が取り消す)

エージェントが次の小節頭から2小節かけてクロスフェーダー全開まで遷移する ramp を予約:

```json
{ "vdap":"1.0", "kind":"request", "requestId":"9b0e…-15", "command":"mixer.rampCrossfader",
  "params": { "to":1.0, "duration":{"bars":2}, "curve":"equalPower",
    "referenceDeckId":"A" },
  "when": { "at":"nextBar", "deckId":"A" } }
```

```json
{ "vdap":"1.0", "kind":"ack", "requestId":"9b0e…-15", "state":"accepted",
  "intentId":"it-000561", "revision":40,
  "scheduledFor": { "runtimeTime":245.774, "estimate":true } }
```

実行前にユーザーが UI でクロスフェーダーを操作(UI 接続の user 由来 `mixer.setCrossfader` が即時実行)。ランタイムは同一ドメインの agent 予約を取り消す:

```json
{ "vdap":"1.0", "kind":"event", "event":"intent.cancelled",
  "intentId":"it-000561", "requestId":"9b0e…-15", "revision":42, "runtimeTime":242.100,
  "reason":"userOverride",
  "result": { "from":0.0, "to":1.0, "startedAtRuntimeTime":null,
    "endedAtRuntimeTime":242.100, "durationSeconds":0.0 } }
```

```json
{ "vdap":"1.0", "kind":"delta", "fromRevision":41, "toRevision":42, "runtimeTime":242.100,
  "patch": [
    { "op":"replace", "path":"/mixer/crossfader/base", "value":-0.35 },
    { "op":"replace", "path":"/mixer/crossfader/effective", "value":-0.35 },
    { "op":"replace", "path":"/mixer/crossfader/automation", "value":null },
    { "op":"remove", "path":"/intents/it-000561" }
  ] }
```

### 19.6 スクラッチ能力交渉(非対応ランタイムへの接続)

```json
{ "vdap":"1.0", "kind":"request", "requestId":"77aa…-01", "command":"session.hello",
  "params": { "protocolVersions":["1.0"],
    "client":{"name":"scratch-pad-client","version":"0.1.0"}, "role":"agent" } }
```

ランタイムは beat プロファイルであり `override`/`gesture` を宣言しない:

```json
{ "vdap":"1.0", "kind":"ack", "requestId":"77aa…-01", "state":"completed", "revision":88,
  "result": { "protocolVersion":"1.0", "profile":"beat",
    "capabilities": { "velocity":{"min":0.5,"max":1.5,"reverse":false},
      "quantize":{"units":["beat","bar"],"toleranceSeconds":0.01},
      "phaseSync":{}, "grid":{"source":"analysis"} },
    "…":"…" } }
```

クライアントはこれを見てジェスチャー機能を無効化しなければならない。誤って送った場合:

```json
{ "vdap":"1.0", "kind":"request", "requestId":"77aa…-02", "command":"deck.applyGesture",
  "params": { "deckId":"A", "gestureId":"baby-scratch-2", "anchor":"selectedPad" } }
```

```json
{ "vdap":"1.0", "kind":"ack", "requestId":"77aa…-02", "state":"rejected",
  "error": { "code":"E_CAPABILITY_REQUIRED", "retryable":false,
    "message":"Capability 'gesture' was not negotiated on this connection." } }
```

(参考: scratch プロファイルのランタイムなら hello 結果に `"velocity":{"min":-4,"max":4,"reverse":true}, "override":{"targets":["velocity","gate","crossfader"]}, "gesture":{"formats":["scratchGesture/1"]}` が含まれる。)

## 20. 未解決事項と推奨デフォルト

以下は本仕様が意図的に確定しない事項である。各項に推奨デフォルトを示す。実装は推奨デフォルトに従うことを **SHOULD** とし、逸脱する場合は文書化する。

- **OD-1: 外部プロセス接続の認証方式。** ハッカソン P0 は Runtime 生成の role 固定 MessagePort のみを権限境界とする。WebSocket を追加する場合は、ループバック限定 + role 付き起動時ランダムトークン(URL クエリではなく hello の `token`)を推奨し、role を hello 自己申告から決定しない。汎用契約は P2 で確定する。
- **OD-2: 解析グリッドの配信形態。** `deck.getGrid` での全量返却(数百 KB)を推奨。帯域が問題になる環境では `analysisRef` を返して帯域外取得(HTTP)に切り替えてよいが、その場合も binding の原子性判定はランタイムが行う。
- **OD-3: `ended` 後のヘッド位置規約。** 本仕様は「終端に留まる」を規定した。自動で先頭へ巻き戻す運用が望ましいと判明した場合、1.1 で `deck.load.params.endBehavior` を追加する。推奨: 現行どおり終端維持(エージェントが明示的に seek する)。
- **OD-4: 継続テンポフォロー(マスター/スレーブの常時追従)。** 1.0 は単発 sync のみ。推奨: 1.1 で `deck.follow {reference}` 能力として追加し、user 操作でフォロー解除する規則を §12.5 に統合する。
- **OD-6: ピックアップ領域の解析データ表現。** §8.3 は barIndex −1 を定めたが、analysis.schema.json v2 の `section.startBar` は 0 以上に制約されている。推奨: スキーマ v3 で `firstDownbeatIndex`(beatIndex ベース)を必須化し、セクション/パッドの bar 系フィールドを §8.3 準拠で再生成する(それまでランタイムは `downbeatsSeconds` から自力導出する)。
- **OD-7: 汎用配送と冪等キャッシュのスコープ。** P0 は MessagePort の接続内 requestId 重複防止と終端1回配送だけを定める。再接続をまたぐ冪等性、at-least-once配送、イベント replay が必要になった場合は、P2 で `sessionResumeKey` と重複排除規則を追加する。推奨: 当面は `state.get` + Intent map による再同期。

## 21. 付録

### 21.1 単位・範囲一覧

| 量 | 単位/型 | 範囲・規約 |
|---|---|---|
| runtimeTime / sourceSeconds | 秒 float | 単調 / `0..duration` |
| velocity(base/configured/override) | 自然速度比 float | core/beat は capability 宣言の正数範囲。1.0 = 等速 |
| headVelocity | ソース秒/ランタイム秒 float | core/beat は playing 時 configuredVelocity、停止時 0 |
| gain(デッキ) | 線形 float | 既定 0..1.5 |
| masterGain | 線形 float | 既定 0..1 |
| crossfader | float | −1(A)..+1(B)。手動は `dj`、automationは `equalPower` |
| gate | 線形乗算 float | 0..1 |
| bpm(base/interpreted/effective) | 拍/分 float または null | binding ありでは > 0、empty では `null` |
| beatIndex / barIndex / phraseIndex | int | 0 起点(ピックアップ barIndex = −1) |
| beatInBar / pad slot | int | 1 起点 |
| confidence / energy | float | 0..1 |
| revision | uint64 | 1 起点・単調増加 |

### 21.2 列挙値一覧

- `kind`: `request` / `ack` / `event` / `snapshot` / `delta`
- `ack.state`: `accepted` / `rejected` / `completed`(クエリのみ)
- `event`: `intent.completed` / `intent.failed` / `intent.cancelled` / `intent.superseded` / `deck.ended` / `runtime.warning`
- `origin`: `user` / `agent` / `system`
- `role`: `agent` / `ui` / `observer`
- `transport.phase`: `empty` / `ready` / `playing` / `ended`
- `load.phase`: `idle` / `loading`
- `playback.direction`(core/beat): `forward` / `stopped`
- `intent.state`: `scheduled` / `executing`
- `crossfader.curve`: `dj` / `equalPower`、`ramp.curve`: `equalPower`
- `eq.band`: `low` / `mid` / `high`
- `tempoInterpretation`: `half` / `normal` / `double`
- `sync.mode`: `tempo` / `tempoPhase` / `tempoBar`
- `when.at`: `immediate` / `nextBeat` / `nextBar` / `beats` / `bars` / `runtimeTime` / `sourcePosition`
- `when.onGridUnavailable`: `reject` / `immediate`
- `seek.target.type`: `sourceSeconds` / `beat` / `bar` / `pad`
- `seek.resume`: `keep` / `pause` / `play`
- `cancel reason`: `clientCancel` / `userOverride` / `bindingChanged` / `panic` / `disconnect`
- `E_QUANTIZE_UNAVAILABLE.reason`: `noGrid` / `lowConfidence` / `notAdvancing` / `beyondGrid`
- `E_SCHEDULE_IN_PAST.reason`: `alreadyPassed` / `positionSkipped` (`runtimeTime` 過去指定では省略 MAY)
- `profile`: `core` / `beat` / `scratch`

### 21.3 コマンド一覧(参照)

クエリ: `session.hello`, `state.get`, `deck.getGrid`
ミューテーション: `state.subscribe`, `state.unsubscribe`, `deck.load`, `deck.unload`, `deck.play`, `deck.pause`, `deck.seek`, `deck.selectPad`, `deck.setPad`*, `deck.clearPad`*, `deck.setGain`, `deck.setEq`, `deck.setVelocity`, `deck.setTempoInterpretation`, `deck.sync`, `mixer.setCrossfader`, `mixer.rampCrossfader`‡, `mixer.setMasterGain`, `schedule.cancel`, `runtime.panic`, `deck.applyGesture`†, `deck.releaseOverrides`†
(* = `padEdit` 能力、‡ = beat `crossfaderRamp` 能力、† = scratch プロファイル)

---

*本仕様は Vibraxis リポジトリ内で完結し、外部ネットワーク・外部専有プロトコル・秘密情報を要求しない。*
