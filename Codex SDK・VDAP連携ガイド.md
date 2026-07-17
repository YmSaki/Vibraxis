# Codex SDK・VDAP連携ガイド

最終確認日: 2026-07-17

この文書は、Vibraxisで作業する人間・Codex・Claude等のエージェントが、CodexをDJ Agentの判断器として組み込む際の共通ルールを定める。対象は主に公式TypeScriptパッケージ `@openai/codex-sdk` である。

## 先に結論

Vibraxisでは、Codexをリアルタイム音声エンジンとして使わない。Codexが行うのは、アプリが渡した候補の中から次曲と高水準な遷移案を `DjDecision` として選ぶことだけである。

```text
楽曲カタログ・現在状態・ユーザー意図
  -> CodexLocalProvider
  -> DjDecision（構造化された提案）
  -> Schema検証 + アプリ固有の意味検証
  -> TransitionPlan
  -> DJ Agent Adapter
  -> agentPort
  -> VDAP Runtime
  -> Deck / Mixer / Web Audio
```

必須原則は次のとおり。

- Codexの出力を、VDAPコマンド、URL、ファイルパス、シェルコマンドとして直接実行しない。
- Codexから `DeckEngine`、`AudioContext`、React stateを直接操作しない。
- AIの応答待ちを再生・拍同期・クロスフェードのリアルタイム処理に入れない。
- タイムアウト、認証切れ、不正な出力では `DeterministicProvider` にフォールバックする。
- VDAP Runtimeを状態と時刻の唯一の権威とする。

## 用語を混同しない

### Codex SDK

`@openai/codex-sdk` はCodex CLIを子プロセスとして起動し、標準入出力でJSONLイベントを交換するTypeScript SDKである。Node.js 18以上が必要で、ブラウザへバンドルするライブラリではない。

Vibraxisでは、ローカル単一ユーザー向けの `CodexLocalProvider` に使用する。

### OpenAI API / OpenAI SDK

OpenAI PlatformのAPIをAPIキーで直接呼ぶ別の経路である。ChatGPTサブスクリプションのCodex利用枠とは、認証・課金・データ管理の境界が異なる。将来 `OpenAiApiProvider` を追加するときの選択肢であり、`@openai/codex-sdk` と同じものとして扱わない。

### Codex app-server

Codex CLIには、JSON-RPCでより細かくthread/turnを制御するapp-serverもある。ただし、現在のハッカソン実装ではSDKの `startThread()` / `run()` で十分である。割り込み、複数クライアント、詳細なライフサイクル管理が必要になった時点で別途採用を検討する。

### 「Sign in with ChatGPT」

Vibraxis独自のOAuthボタンを実装する意味ではない。ローカル環境で利用者があらかじめ `codex login` を実行し、Codex CLIが保持するログイン状態をSDKから再利用する構成を指す。

公式にはCodex CLIは次の2方式をサポートする。

- `codex login`: ブラウザを開き、ChatGPTアカウントでログインする。
- APIキー: OpenAI Platformの利用量課金としてログインする。

ローカルデモでは前者を既定とする。公開サーバーや第三者向けサービスで、個人のChatGPTログイン情報を流用してはならない。

## セットアップと認証

### インストール

実装対象のNodeパッケージで、バージョンを固定して導入する。

```powershell
npm install --save-exact @openai/codex-sdk
```

SDKはCLIを内包して呼び出すため、アプリから任意の `codex` コマンド文字列を組み立てる必要はない。

### ChatGPTログインを使うローカル構成

```powershell
codex login
codex login status
```

SDK呼び出し前に、同じOSユーザーでログイン済みであることを確認する。ログインが必要な場合はアプリ内で認証情報を読まず、利用者に `codex login` を案内する。

ヘッドレス環境では、利用可能なら次を使う。

```powershell
codex login --device-auth
```

### APIキーを使う構成

APIキー方式はCIや信頼済みの自動化向けであり、OpenAI Platform側で課金される。キーをソース、JSON、ログ、プロンプト、フロントエンド環境変数へ入れない。

PowerShellでCLIへキーを渡す場合の概念例:

```powershell
$env:OPENAI_API_KEY | codex login --with-api-key
```

### 認証情報の禁止事項

- `~/.codex/auth.json` を読み取ってトークンを抽出しない。
- `auth.json` をリポジトリ、Issue、チャット、ログ、ビルド成果物へ含めない。
- Vibraxisの設定ファイルへアクセストークンをコピーしない。
- 他の作業者やエージェントへ認証ファイルを渡さない。
- 可能ならCodex CLIの `cli_auth_credentials_store = "keyring"` を使う。

`auth.json` はパスワードと同等に扱う。認証方式の確認はファイルの中身ではなく `codex login status` で行う。

## 最小の呼び出し方

公式SDKの基本形は次のとおり。

```ts
import { Codex } from "@openai/codex-sdk";

const codex = new Codex();
const thread = codex.startThread({
  workingDirectory: "C:/programing/Vibraxis",
});

const turn = await thread.run("このリポジトリの状態を要約してください");
console.log(turn.finalResponse);
```

同じ `thread` へ `run()` を繰り返すと会話を継続できる。保存済みthread IDを使う場合は `resumeThread()` を利用できる。ただしDJ判断は、古い会話状態に依存しすぎないよう毎回必要な `DjContext` を入力する。

### Vibraxis向けの構造化出力

`shared/dj/decision.schema.json` を `outputSchema` に渡し、返されたJSON文字列をさらにアプリ側で検証する。

```ts
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Codex } from "@openai/codex-sdk";
import type { DjContext, DjDecision, DjIntent } from "../shared/dj/index.js";

const decisionSchema = JSON.parse(
  await readFile(resolve(process.cwd(), "shared/dj/decision.schema.json"), "utf8"),
);

export async function requestDjDecision(
  context: DjContext,
  intent: DjIntent,
): Promise<unknown> {
  const codex = new Codex();
  const thread = codex.startThread({
    workingDirectory: process.cwd(),
  });

  const prompt = [
    "あなたはVibraxisの選曲判断器です。",
    "候補外の曲を選ばず、VDAPコマンド、URL、パス、シェル操作を出力しないでください。",
    "指定されたJSON Schemaに一致するDjDecisionだけを返してください。",
    JSON.stringify({ context, intent }),
  ].join("\n");

  const turn = await thread.run(prompt, { outputSchema: decisionSchema });
  return JSON.parse(turn.finalResponse);
}
```

この関数の返り値を型アサーションだけで `DjDecision` にしてはならない。JSON Schema検証と、次節の意味検証を通す。

### ストリーミング

`run()` は終了までイベントをまとめる。進捗表示が必要なら `runStreamed()` を使える。

```ts
const { events } = await thread.runStreamed(prompt, {
  outputSchema: decisionSchema,
});

for await (const event of events) {
  if (event.type === "turn.completed") {
    console.debug("Codex usage", event.usage);
  }
}
```

ストリーミング途中の文章やitemをDJ命令として実行しない。採用できるのは、turn完了後に取得し、すべての検証を通過した最終JSONだけである。

## Codexに渡してよいもの

原則として、アプリが組み立てた小さなJSONだけを渡す。

- 現在曲の `DjTrackSummary`
- 事前に絞り込んだ候補曲の `DjTrackSummary[]`
- 最近再生したtrack ID
- BPM、Camelot、energy、genre、mood、beat grid/section cueの有無
- `DjIntent`
- Runtimeが決めた再生速度・クロスフェード小節数の上限

Codexへ渡さないもの:

- 生の音源ファイルや音声バッファ
- 認証情報、個人情報、不要な絶対パス
- カタログ外のURLや、ロードに使う実ファイルURL
- VDAPの低水準コマンド列
- シェルコマンドやWeb Audio操作
- 検証されていないユーザー入力を「命令」として連結したプロンプト

ユーザー文はデータとして区切り、候補や制約を書き換えられないことをプロンプトでも明示する。最終的な安全性はプロンプトではなく、型・Schema・意味検証・VDAP Runtimeで担保する。

## `DjDecision` の検証

`shared/dj/decision.schema.json` に通っただけでは不十分である。Adapterは少なくとも次を検査する。

1. `nextTrackId` が今回渡した `context.candidates` に存在する。
2. `targetDeckId` が `context.inactiveDeckId` と一致する。
3. `crossfadeBars` が `context.limits.allowedCrossfadeBars` に含まれる。
4. `tempoSync` と `startAt` がRuntimeのcapabilityで実行可能である。
5. 選択曲に、必要なbeat gridやsection cueがある。
6. decisionにSchema外フィールド、URL、コマンド、パスが混入していない。
7. 判断開始後に現在曲・binding・active deckが変わっていない。

検証失敗時に、AIの値を都合よくクランプして実行しない。判断を破棄し、最新状態で再判断するか `DeterministicProvider` へ切り替える。

## VDAPとの接続規則

### 接続点は `agentPort` だけ

AI判断の適用にはRuntimeが生成した `agentPort` を使う。画面上の人間操作は `uiPort` を使う。Agentがhelloで `role: "ui"` を名乗ってもuser権限を得られない設計を維持する。

関連実装:

- `frontend/src/runtime/MessagePortTransport.ts`
- `frontend/src/runtime/VdapClient.ts`
- `frontend/src/runtime/CommandDispatcher.ts`
- `frontend/src/runtime/RuntimeStore.ts`

### VDAPコマンドへの変換はAdapterの仕事

Codexは「次曲」「対象デッキ」「tempo syncの有無」「nextBar開始」「crossfadeBars」を選ぶ。Adapter/TransitionExecutorが、現在のRuntime snapshotとcatalogを使って次のような具体的手順へ変換する。

1. 非アクティブデッキへ曲をprepare/loadする。
2. loadのterminal成功と新しい `bindingId` を確認する。
3. capabilityとbeat gridを再確認する。
4. tempo syncを適用する。
5. `nextBar` で再生を予約する。
6. 1個の `mixer.rampCrossfader` Intentとしてクロスフェードする。
7. 各段階でuser override、binding変更、terminal失敗を監視する。

モデルにこの低水準シーケンス自体を生成させない。

### ackは完了ではない

VDAPのrequestに対するackは「受理または拒否」を表す。予約、ロード、ramp等は、対応する `intent.completed` / `intent.failed` / `intent.cancelled` / `intent.superseded` を待って初めて終端する。

次段階へ進む条件を、ack受信だけにしてはならない。

### revisionとbinding

- `expectedRevision` はコマンド受理時のstale検出に使う。予約実行時には再検査しない。
- `expectedBindingId` は特定の曲を前提にする操作へ付け、実行時にも確認する。
- `E_STALE_REVISION` なら最新snapshotを取得し、AIの古い判断をそのまま再送しない。
- `E_BINDING_MISMATCH` なら計画を破棄する。ユーザーが曲を替えた可能性がある。

### userを最優先する

Agent実行中にユーザーが同じデッキやクロスフェーダーを操作した場合、VDAPの `user > agent` 規則に従う。Agent側から即座に操作を取り返さない。`userOverride` による取消を正常な制御フローとして扱い、必要なら次の判断周期まで待つ。

### loadの安全性

- 新曲の準備に失敗しても、旧bindingと再生を保持する。
- Agentが再生中デッキを置換する操作は原則行わない。
- 必要な場合も `replacePlaying:true` と正しい `expectedBindingId` の双方を要求するVDAP規則に従う。
- 曲のURLやローカルパスはAIから受け取らず、検証済みtrack IDをcatalog resolverで解決する。

### panic

異常時の最終手段はVDAPの `system.panic` であり、Codexへ復旧手順を考えさせている間に音声を放置しない。panicの発火条件はRuntime/Adapter側の決定論的ロジックに置く。

## リアルタイム処理とタイムアウト

Codexの応答時間は保証されない。したがって、遷移直前ではなく数十秒以上前に判断を開始する。

推奨動作:

1. 次の遷移期限より十分早く候補を絞る。
2. Codex呼び出しにアプリ側deadlineを設ける。
3. deadlineまでに有効な `DjDecision` がなければ決定論的判断を採用する。
4. 遅れて返ったCodex結果は実行せず破棄する。
5. VDAP Runtimeの再生クロックをモデル応答待ちで停止しない。

SDK/APIのバージョンによっては実行中turnの取消方法が異なる。Promise側のタイムアウトだけで子プロセス処理が止まると仮定せず、導入時に使用バージョンの型と公式READMEを確認する。取消不能なら、同時実行数を制限し、遅延結果を世代IDで無効化する。

## 権限と実行環境

Codex SDKはコーディングエージェントを起動するため、プロンプト次第ではファイルやシェルのツールを使える。DJ選曲判断にそれらは不要である。

- SDKはブラウザではなく、信頼済みローカルNodeプロセスで動かす。
- `workingDirectory` はVibraxisのGitリポジトリルートへ固定する。
- `skipGitRepoCheck: true` を通常運用の逃げ道にしない。
- DJ判断用threadには、使用中SDKバージョンが提供する最小権限・read-only sandboxを設定する。
- ネットワーク、任意のMCP、外部connectorをDJ判断用threadへ不要に許可しない。
- 親Nodeプロセスから継承する環境変数を最小化する。SDKの `env` 指定は環境を全面的に置き換えるため、必要な `PATH` 等を明示する。
- 公開された任意プロンプト実行エンドポイントを作らない。

権限optionの名前と選択肢はSDK更新で変わり得る。実装時は固定したパッケージのTypeScript型を正本とし、未確認のoptionを `as any` で押し込まない。

## 失敗時の処理表

| 状況 | 処理 |
|---|---|
| 未ログイン・認証失効 | `codex login status` / `codex login` を案内し、`DeterministicProvider` を使う |
| タイムアウト | Codex結果を無効化し、決定論的判断を使う |
| JSON parse失敗 | 出力を破棄し、決定論的判断を使う |
| Schema不一致 | 出力を破棄し、エラー理由だけ記録する |
| 候補外track ID | 実行せず、セキュリティ/意味検証エラーとして記録する |
| 状態revisionが古い | 最新snapshotから判断をやり直す |
| binding不一致 | 計画を破棄し、ユーザーの現操作を優先する |
| beat capability不足 | 対応する決定論的な非同期遷移へ落とすか、候補を選び直す |
| load失敗 | 旧bindingを維持し、次候補または手動操作へ戻る |
| user override | Agent Intentを取り消し、操作を取り返さない |
| SDK/CLI異常終了 | Providerをunavailableにし、Runtimeは継続する |

ログにはprovider名、所要時間、thread/turnの相関ID、結果区分、fallback理由を残してよい。プロンプト全文、ユーザーの認証情報、`auth.json`、環境変数、音源パスは残さない。

## Providerの推奨境界

```ts
export interface DjAgentProvider {
  decideNext(input: {
    context: DjContext;
    intent: DjIntent;
    generation: string;
  }): Promise<DjDecision>;
}

export class CodexLocalProvider implements DjAgentProvider {
  // @openai/codex-sdk。ローカルcodex loginを利用する。
}

export class DeterministicProvider implements DjAgentProvider {
  // 認証、timeout、無効出力時にも必ず利用可能にする。
}

export class OpenAiApiProvider implements DjAgentProvider {
  // 将来用。Platform API keyの管理と課金境界をCodexLocalProviderから分離する。
}
```

ProviderはVDAP clientを保持しない。判断の生成と、判断の実行を分離することで、AIを無効化してもRuntime/UIをそのまま動かせる。

## 作業者向けチェックリスト

実装またはレビュー時は、次をすべて確認する。

- [ ] `@openai/codex-sdk` のバージョンが固定されている。
- [ ] SDK呼び出しがフロントエンドbundleへ入っていない。
- [ ] `workingDirectory` がリポジトリルートに固定されている。
- [ ] ログイン情報やAPIキーを読み書き・記録していない。
- [ ] Codex出力が `shared/dj/decision.schema.json` で検証される。
- [ ] 候補ID、inactive deck、limits、capabilityの意味検証がある。
- [ ] URL、パス、VDAPコマンド、シェル操作をAI出力から受け付けない。
- [ ] AI判断の適用に `agentPort` を使い、`uiPort` を使っていない。
- [ ] ackとterminal eventを区別している。
- [ ] `expectedRevision` と `expectedBindingId` の意味を混同していない。
- [ ] user override、binding変更、load失敗を安全に処理する。
- [ ] タイムアウトと `DeterministicProvider` fallbackのテストがある。
- [ ] AI停止中でも手動DJとVDAP Runtimeが動く。
- [ ] 遅れて返った古い判断を世代IDで破棄できる。

## 関連するプロジェクト内文書

- `memo/codexsdk.md`: Codex SDK調査の詳細メモ
- `VDAP仕様実装順.md`: ハッカソンでの実装優先順位、特に順序6
- `Vibraxis DJ Agent Protocol.md`: Runtime、権限、Intent、競合、エラーの規範仕様
- `shared/dj/index.ts`: `DjContext`、`DjIntent`、`DjDecision`、`TransitionPlan`
- `shared/dj/decision.schema.json`: Codex出力の構文上の正本
- `shared/dj/intent.schema.json`: ユーザー意図の構文上の正本
- `shared/vdap/index.ts`: VDAP共有型

## 公式資料

- [Codex SDK公式ガイド](https://developers.openai.com/codex/sdk/)
- [Codex認証公式ガイド](https://developers.openai.com/codex/auth/)
- [公式TypeScript SDK README](https://github.com/openai/codex/blob/main/sdk/typescript/README.md)
- [公式TypeScript SDKソース](https://github.com/openai/codex/tree/main/sdk/typescript)
- [Codex app-server README](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)

SDKは更新される。コード例とoptionは、実装時に固定したパッケージの型および公式READMEを再確認し、この文書と差があれば文書も同じ変更で更新する。
