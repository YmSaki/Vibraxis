# Codex SDK 調査メモ（DJ Agent 用途）

調査日: 2026-07-16

## 結論

Vibraxis の **ローカル開発版・デモ版**で DJ Agent を動かす実験基盤として、TypeScript版 Codex SDK は利用できる。ただし、公式ドキュメントは Codex SDK を「コーディング中心のCodexスレッド」向けとしているため、汎用DJエージェントの本命基盤としては推奨しない。

APIキーをユーザーに入力させたくない場合、現時点の公式な現実解は次の形である。

1. ユーザー自身がローカルPCで `codex login` を実行する。
2. ブラウザーで **Sign in with ChatGPT** を完了する。
3. 同じOSユーザー、同じ `CODEX_HOME` のローカルNodeプロセスから Codex SDK を実行する。

Codex CLIのSign in with ChatGPTは、現在の公式ドキュメントでは実装済みであり、ChatGPTサブスクリプションアクセスに使える。ただし、これは **Codex CLI／IDE拡張／ChatGPTデスクトップアプリ向けのログイン機能**である。Vibraxis自身に「Sign in with ChatGPT」ボタンを埋め込み、第三者アプリがChatGPTユーザーのサブスクリプションをモデルAPI利用へ転用するための、一般公開されたOAuth/APIは公式資料上確認できない。

したがって採用判断は次のとおり。

- ハッカソンのローカルデモ: **条件付き採用可**
- 開発者本人だけが使うローカルDJ Agent: **採用可**
- 不特定ユーザーへ配布するデスクトップアプリ: **非推奨**
- Webサービス／公開SaaSのバックエンド: **非推奨**。OpenAI APIまたはAgents SDKをAPIキー等の正式なサーバー認証で使うべき

## 1. Codex SDKの公式な用途

公式ページはCodex SDKを「ローカルCodexエージェントをプログラムから制御する」ためのSDKと説明し、次の用途を挙げている。

- CI/CDへの組み込み
- Codexと連携する独自エージェントの作成
- 社内ツールやワークフローへの組み込み
- 独自アプリケーションへの統合

一方で、公式ページには「Codex SDKはコーディング中心のCodexスレッドに使う」と明記されている。Codexをより広いエージェントワークフロー内の専門家として使う場合は、Codex CLIをMCPサーバーとして動かし、Agents SDKからオーケストレーションする構成が案内されている。

公式URL:

- [Codex SDK](https://developers.openai.com/codex/sdk/)
- [OpenAI Codex公式リポジトリ内 TypeScript SDK](https://github.com/openai/codex/tree/main/sdk/typescript)

## 2. 導入方法とNode/TypeScriptからの利用

TypeScript版はサーバー側での利用を前提とし、Node.js 18以上が必要。

```powershell
npm install @openai/codex-sdk
```

最小例:

```ts
import { Codex } from "@openai/codex-sdk";

const codex = new Codex();
const thread = codex.startThread({
  workingDirectory: process.cwd(),
});

const result = await thread.run(
  "data/analysis の解析結果を読み、次に再生する曲を提案してください。",
);

console.log(result.finalResponse);
```

主な機能:

- `startThread()` でスレッド開始
- 同じスレッドで `run()` を繰り返して会話を継続
- `resumeThread(threadId)` で保存済みスレッドを再開
- `runStreamed()` でツール実行や進捗をイベントとして受信
- JSON Schemaを渡して構造化出力を要求
- `workingDirectory`、sandbox、ネットワーク許可、承認ポリシー等を指定

TypeScript SDKは内部的に `@openai/codex` のCodex CLIを子プロセスとして起動し、標準入出力でJSONLイベントを交換するラッパーである。通常のHTTP APIクライアントとは異なる。

実装上 `apiKey` はオプションであり、SDKはAPIキーが明示された場合だけ `CODEX_API_KEY` を子プロセスへ注入する。また、環境を明示的に上書きしなければNodeプロセスの環境をCodex CLIへ引き継ぐ。

一次資料:

- [TypeScript SDK README](https://github.com/openai/codex/blob/main/sdk/typescript/README.md)
- [CodexOptions（apiKeyはoptional）](https://github.com/openai/codex/blob/main/sdk/typescript/src/codexOptions.ts)
- [CLI子プロセス起動実装](https://github.com/openai/codex/blob/main/sdk/typescript/src/exec.ts)

## 3. 認証方式

公式ドキュメントによると、OpenAIモデルを使うCodexには次の2方式がある。

### A. Sign in with ChatGPT

- ChatGPTサブスクリプションアクセスを利用
- Codex CLIでは `codex login` を実行し、ブラウザーでログイン
- 有効なセッションがなければ、これがCLIの標準ログイン経路
- ログイン情報は `~/.codex/auth.json` またはOSの資格情報ストアへキャッシュ
- ChatGPTログインのトークンは使用中に自動更新される

確認用コマンド:

```powershell
codex login status
```

### B. OpenAI APIキー

- 使用量ベースのOpenAI Platform課金
- ローカルCodexのプログラム実行やCI/CDでは、公式ドキュメントはこちらを推奨
- SDKでは `new Codex({ apiKey: process.env.OPENAI_API_KEY })` の形で渡せる

```ts
const codex = new Codex({
  apiKey: process.env.OPENAI_API_KEY,
});
```

### C. Enterprise向けCodex access token

ChatGPT Enterpriseでは、管理者が許可したメンバー向けに、信頼されたスクリプト、スケジューラー、プライベートCIランナー用のCodex access tokenが提供される。これは一般ユーザー向けの第三者アプリOAuthではなく、Enterprise内部自動化向けである。一般的なOpenAI API呼び出しには引き続きPlatform APIキーを使うよう公式に案内されている。

公式URL:

- [Codex Authentication](https://developers.openai.com/codex/auth/)
- [Using Codex with your ChatGPT plan](https://help.openai.com/en/articles/11369540-using-codex-with-chatgpt)

## 4. 「APIキーなし」の正確な扱い

### ローカルVibraxisで可能と考えられること

同じユーザー環境で先に `codex login` を済ませ、`apiKey` を指定せずにSDKを起動すれば、SDKが起動するCodex CLIが保存済み認証を使う構成にできる。

これは以下の公式情報を組み合わせた判断である。

- SDKはローカルCodex CLIを起動するラッパーである
- CLIはChatGPTログイン情報をローカルへキャッシュして再利用する
- SDKの `apiKey` はオプションで、指定時のみCLI環境へ注入される

ただし、Codex SDKの公式ページは「SDKがCLIのChatGPT認証キャッシュを第三者アプリ向けに利用すること」を独立した保証事項として明記していない。このため、Vibraxisで採用する場合は **現在のローカル実装に基づく統合**として扱い、Codex/SDKのバージョンを固定し、実機テストを行う必要がある。

### 公開された公式手段として確認できないこと

次の仕組みは、2026-07-16時点の公開公式資料では確認できない。

- 第三者アプリが独自UIに汎用の「Sign in with ChatGPT」ボタンを埋め込むためのOAuthクライアント登録
- 取得したChatGPTユーザートークンをOpenAI APIへ渡す公開API
- ChatGPT Plus/Pro等のサブスクリプション枠を、任意の第三者製Webサービスの推論バックエンドとして利用する仕組み
- Codex SDKが第三者アプリ向けログインUIや認証コールバックを提供するAPI

従って、「VibraxisにChatGPTログインを直接実装して、エンドユーザーの契約枠でDJ Agentを動かす」とは表現しないこと。正確には「ローカルCodex CLIへユーザーが別途ログインし、そのローカルCodex実行をVibraxisがSDKから制御する」である。

また、ChatGPT Apps SDKは方向が逆で、ChatGPTから第三者のMCPツールやUIを呼べるようにする製品である。第三者アプリへChatGPTのモデル推論権限を渡す認証手段ではない。

## 5. Vibraxis向け構成案

### 推奨する実験構成

```text
Vibraxis UI
    |
    | IPC / localhost（ユーザー入力、現在曲、再生状態）
    v
DJ Agent Adapter（Node/TypeScript）
    |
    | @openai/codex-sdk
    v
ローカル Codex CLI 子プロセス
    |
    | 事前に codex login 済み
    v
ChatGPT-managed Codex entitlement

DJ Agent Adapter
    |
    +--> data/analysis/*.json（読み取り）
    +--> 構造化された選曲・遷移提案を返す
            |
            v
    決定論的な再生／クロスフェードエンジン
```

責務は明確に分ける。

- Codex/DJ Agent: 候補曲の比較、理由付け、次曲・遷移案の提案
- 決定論的エンジン: BPM整合、再生時刻、音量、クロスフェード、失敗時フォールバック
- 解析ツール: BPM、キー、コード、セクション等を事前計算しJSON化

DJ Agentに音声再生そのものを直接操作させず、JSON Schemaで次のような意思決定だけ返させると安全で検証しやすい。

```ts
type DjDecision = {
  nextTrackId: string;
  mixInSeconds: number;
  mixOutSeconds: number;
  crossfadeSeconds: number;
  confidence: number;
  reasons: string[];
};
```

### 起動フロー案

1. `codex login status` を子プロセスで確認する。
2. 未ログインならVibraxis内で資格情報を扱わず、ターミナルで `codex login` を実行する案内を表示する。
3. ログイン済みなら `new Codex()` を生成する。
4. `workingDirectory` をVibraxisリポジトリに限定する。
5. 解析JSONは読み取り専用で参照させる。
6. 構造化出力をアプリ側でSchema検証・意味検証する。不正出力はクランプせずそのまま拒否する。
7. タイムアウト、認証切れ、利用上限、SDK異常時の既定挙動は拒否（reject）とする。決定論的な選曲ロジックへの切り替えは、リクエストが明示的にオプトインし必要な入力を供給した場合に限る（AGENTS.md §0）。フォールバック結果はCodex/GPTの結果として表示しない。遅延結果は世代IDで無効化する。

### セキュリティ上の注意

- `~/.codex/auth.json` をVibraxisへコピー、読み取り、アップロード、同梱しない。
- `auth.json` はアクセストークンを含むため、秘密情報として扱う。
- 資格情報ストアは可能なら `cli_auth_credentials_store = "keyring"` を使う。
- 不特定ユーザーから自由なプロンプトを受け取る公開サーバーとしてCodex実行を露出しない。公式も信頼されない／公開環境へのCodex実行の露出を避けるよう案内している。
- Agentへ不要な書き込み権限やネットワーク権限を与えない。
- SDKはNodeサーバー側で使い、ブラウザーバンドルへ入れない。

## 6. 制約とリスク

- **用途のずれ**: Codex SDKは公式にはコーディング中心。DJ選曲は汎用エージェント用途である。
- **ローカル依存**: CLI子プロセス、ユーザー環境、`CODEX_HOME`、ログイン状態へ依存する。
- **認証UX**: SDK自身は第三者アプリ用のログインUIを提供しない。別途 `codex login` が必要。
- **配布性**: ローカルログイン前提はWebサービスや複数ユーザーのホスト環境に向かない。
- **権限**: Codexはファイルやシェルを扱えるため、DJ判断だけに必要な範囲へsandboxを絞る必要がある。
- **Git前提**: SDKは標準では作業ディレクトリがGitリポジトリであることを要求する。Vibraxisリポジトリ内で動かすなら満たせる。
- **利用上限**: ChatGPTプランのCodex利用上限を消費し、上限や対象プランは変更され得る。
- **互換性**: SDK／CLI更新により認証やイベント形式が変わる可能性を考え、バージョン固定と統合テストが必要。
- **リアルタイム性**: LLM応答をクロスフェード直前の必須処理にしてはいけない。数曲先を事前計画し、失敗時はローカルスコアで選曲する。

## 7. 最終推奨

短期のハッカソンでは、次の条件でCodex SDKを採用してよい。

- 「ローカル・単一ユーザー・事前に `codex login` 済み」のデモに限定する
- APIキー不要を「Vibraxis独自のChatGPTログイン」ではなく「ローカルCodex CLIのChatGPTログインを利用」と説明する
- Agentは構造化されたDJ判断だけを返す
- 音声制御は決定論的ロジックに残す
- Codexが使えない場合の非AIフォールバックを必ず持つ

中長期に一般配布するなら、Codex SDKをDJ Agentの中核に固定しない。公式に汎用エージェント向けであるOpenAI Agents SDK／Responses APIへ交換できる `DjAgentProvider` インターフェースを設ける。ただし、これらをVibraxisのバックエンドから利用する場合は原則としてOpenAI Platformの正式な認証とAPI課金が必要であり、ChatGPTサブスクリプションを第三者アプリのAPI利用へ転用できるとは扱わない。

```ts
interface DjAgentProvider {
  decideNext(input: DjContext): Promise<DjDecision>;
}

class CodexLocalProvider implements DjAgentProvider {
  // ハッカソン／ローカルデモ用
}

class DeterministicProvider implements DjAgentProvider {
  // 認証切れ、上限、ネットワーク障害時のフォールバック
}

class OpenAiApiProvider implements DjAgentProvider {
  // 将来の正式なサーバー運用用
}
```

## 参照した一次資料

- [Codex SDK公式ドキュメント](https://developers.openai.com/codex/sdk/)
- [Codex Authentication公式ドキュメント](https://developers.openai.com/codex/auth/)
- [Using Codex with your ChatGPT plan（OpenAI Help Center）](https://help.openai.com/en/articles/11369540-using-codex-with-chatgpt)
- [OpenAI Codex公式GitHub: TypeScript SDK](https://github.com/openai/codex/tree/main/sdk/typescript)
- [TypeScript SDK README](https://github.com/openai/codex/blob/main/sdk/typescript/README.md)
- [TypeScript SDK CodexOptions](https://github.com/openai/codex/blob/main/sdk/typescript/src/codexOptions.ts)
- [TypeScript SDK CLI実行実装](https://github.com/openai/codex/blob/main/sdk/typescript/src/exec.ts)

