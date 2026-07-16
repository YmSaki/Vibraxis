# Vibraxis

自然言語で意図を伝えられるAI DJを目指すローカルWebアプリです。現在は本体M1として、
2デッキDJミキサーとオフライン音源解析ツールを実装しています。

## 本体を起動

Node.js 20以降が必要です。

```powershell
npm install
npm start
```

ブラウザで `http://localhost:5173` を開くと、解析済みの楽曲ライブラリが表示されます。
曲カードの`LOAD DECK A`または`LOAD DECK B`でデッキへ読み込み、`PLAY`で再生します。
従来どおり各デッキの`LOAD TRACK`から手元の音源を選ぶこともできます。音源データは
ローカルのViteサーバーからブラウザへ渡され、外部へ送信されません。

楽曲カードとデッキには解析済みのBPM、キー、Camelot、energy、構成区間数を表示します。
開発サーバーは`data/catalog.json`を`/api/catalog`、`data/sample/`の音源を
`/tracks/<filename>`としてローカル配信します。

各デッキで操作できるもの:

- 音源の読み込み、再生、一時停止、CUE（先頭停止）、シーク
- ゲイン（0〜150%）
- 再生速度（0.5〜1.5倍）
- 解析済み楽曲ライブラリからのワンクリックロード

中央ミキサーで操作できるもの:

- equal-powerクロスフェーダー
- マスターボリューム

## 検証

```powershell
npm run check
```

TypeScriptの型チェック、Vitest、Vite本番ビルドを実行します。

音声解析については [analyze-tool/README.md](analyze-tool/README.md) を参照してください。
