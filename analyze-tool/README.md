# Vibraxis analyze-tool

Vibraxis DJ Agent向けのオフライン音源解析器です。音源を一度解析し、実行時には
Pythonや音源デコードを必要としないJSON catalogを生成します。

## 解析内容

`--profile full`（既定値）はschema v2として次を出力します。

- BPM、拍、推定ダウンビート、4/4小節グリッド
- グローバルキー、Camelot表記、局所キー区間
- タイムスタンプ付きコードとディグリーネーム（`Am` + `vi`など）
- `intro / verse / chorus / build / drop / breakdown / outro / other`等の構成区間
- 8小節単位を基本とするフレーズ
- energy、RMS、ダイナミックレンジ、onset rate、spectral centroid
- 機能別のprovider、confidence、成功／失敗状態

高度解析は現在ローカルのlibrosa/chromaヒューリスティックで完結します。ChordMiniは
アプリ本体がMITで公開されていますが、モデルを含む全依存の利用条件とWindows動作を
固定できるまで同梱しません。SongFormerも利用許諾を確認できるまで取得・実行しません。

## セットアップとコマンド

```powershell
cd analyze-tool
uv sync
uv run task unit
uv run task analyze-samples
uv run task build-catalog
uv run task check
```

個別の音源またはディレクトリを解析できます。

```powershell
uv run python main.py ../tracks/song.mp3 --profile full --require-complete
uv run python main.py ../tracks --output ../data/analysis --force
```

- `--profile baseline|full`: baselineは従来特徴と拍のみ、fullはコードと構成を含む
- `--require-complete`: 機能が`complete`でない場合に失敗させる
- `--allow-partial`: 不完全な解析をcatalogへ入れることを明示的に許可する
- `--allow-unverified-license`: 権利未確認のローカルサンプルを開発catalogに限り許可する
- `--catalog-source/--catalog-output`: 手動メタデータを解析結果と結合する
- `--force`: schema・hashが一致するキャッシュも再解析する

## schema v2

契約の機械可読版は`analysis.schema.json`です。主要構造は次の通りです。

```text
analysis
├─ source / analyzer / capabilities
├─ tempo: bpm, beatsSeconds, downbeatsSeconds, barsSeconds
├─ tonal: key, scale, camelot, keyRegions[]
├─ harmony.chords[]: symbol, root, quality, localKey, degree, timestamps
├─ structure.sections[] / phrases[]
├─ features
└─ overridesApplied
```

秒を時間軸の原本とし、`beatIndex`と`barIndex`を派生値として保存します。コードは
実際の重ね合わせに必要な絶対表記と、移調に依存しない比較用ディグリーを併記します。
`N`はコードなし、`bVII`等はノンダイアトニックコードを表します。

schema v1は高度情報を持たないため変換しません。schema番号が異なるキャッシュは自動で
無効化され、音源から再生成されます。書込前、cache採用時、catalog読込時に時系列・
区間被覆・能力状態を意味検証し、一時ファイルから原子的に置換します。

## catalog-source.json

`data/catalog-source.json`は`trackId`をキーとし、次を必須とします。

```json
{
  "tracks": {
    "song-id": {
      "file": "song.mp3",
      "title": "Song",
      "artist": "Artist",
      "genre": "House",
      "mood": ["uplifting"],
      "license": "CC BY 4.0",
      "sourceUrl": "https://example.com/song"
    }
  }
}
```

同梱サンプルのartist、genre、license、sourceUrlはまだ確認できないため明示的に
`Unknown` / `Unverified local sample` / `local:`としています。公開前に必ず正しい値へ
置き換えてください。通常のcatalog生成は未確認licenseを拒否し、開発用taskだけが
`--allow-unverified-license`を明示します。欠落、重複、解析との不一致もエラーになります。

## 手動override

`overrides.json`はファイル名またはtrackIdをキーにします。自動解析後に適用されるため、
常に手動値が優先されます。既存の`bpm / key / scale / camelot / energy`に加えて、
`keyRegions / chords / sections`をschema v2と同じcamelCase形式で指定できます。
override変更は対象曲のキャッシュを無効化します。

## 品質確認と制約

- `tests/golden/annotations.json`の3曲でBPM、全区間被覆、コード出力を自動確認します。
- コード／構成の精度数値を主張するには、人が聴取して`chords`と`sections`の正解値を
  入れる必要があります。未入力の間、benchmarkはその精度を`pending`と表示します。
- 人手精度ゲートが未完了のため、beatGrid、harmony、structureの状態は`partial`です。
  データが生成されたことと、受入精度を満たしたことを区別しています。
- ダウンビートは4/4を前提にした推定です。変拍子は手動修正または別providerが必要です。
- 構成ラベルは反復・エネルギー変化による低信頼ヒューリスティックです。
- ボーカル検出、ステム分離、リアルタイム解析、DJ接続スコアは今回の対象外です。

## 第三者ソフトウェア

- librosa: ISC License（Python依存としてuv.lockで固定）
- ChordMiniApp: MIT License。現時点ではコード・モデルとも未同梱
- SongFormer: 利用条件の確認が完了していないため未同梱・未実行
