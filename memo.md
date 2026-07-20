**ある。ただし、メジャー楽曲をフル尺で取得し、2デッキ再生・テンポ変更・スクラッチ・波形解析まで自由に行える一般公開APIは、ほぼありません。**
現実的には、試作は Audius／Jamendo／SoundCloud、本番の商用カタログは Beatport 等とのパートナー契約、という二段構えになります。

## すぐ試せる候補

### Audius

公開REST APIから楽曲の検索・取得・ストリーミングが可能です。公式も「音楽をストリームするアプリ」の構築を想定しています。メジャーレーベル中心ではありませんが、DJエンジンの技術検証にはかなり使いやすい候補です。 ([docs.audius.org][1])

**向いている用途**

* 2デッキ再生
* シーク、プリロード
* BPM解析・波形生成
* タイムストレッチの試作
* APIアダプターの設計検証

ただし、ユーザー投稿型カタログなので、各楽曲の権利状態まで一律に保証されるものとしては扱わない方が安全です。

### Jamendo

APIレスポンスに直接 `audio` ストリームURLが含まれ、MP3・Ogg・FLACを指定できます。約50万曲規模のインディーズ／Creative Commons系カタログを提供し、公式ドキュメントでもマッシュアップなどの利用を想定しています。 ([Jamendo API][2])

**利点**

* 独自オーディオパイプラインに載せやすい
* FLACも選択可能
* ライセンス情報をAPIで取得可能
* デモ版や公開プロトタイプ向き

`CC-ND`、`CC-NC`、商用ライセンスの扱いは分ける必要があります。特に製品化時は、単にストリームできることと、加工・商用利用できることを同一視しない方がよいです。

### SoundCloud API

公開楽曲のうち `playable` なものは、`stream_url` を使った独自プレイヤーで再生できます。検索時にBPMや再生可能状態でフィルタリングすることもできます。現行ドキュメントではAPIキー取得に Artist Pro が必要です。 ([SoundCloud Developers][3])

ただし制約があります。

* 全楽曲を再生できるわけではない
* 地域制限、投稿者設定、課金状態でブロックされる
* 永続キャッシュやオフライン再生は禁止
* 商用利用できる範囲が狭く、その他は個別承認扱い

そのため、**非商用試作には使えるが、有料DJアプリの主力音源として無承認で採用するのは危険**です。 ([SoundCloud Developers][4])

## 本番向けだが提携が必要な候補

### Beatport Streaming／Beatsource

DJ用途として最も正攻法です。フル尺再生、DJソフト統合、プランによってはオフラインロッカーやFLAC、ステム機能まで用意されています。Beatport自身がDJソフト・ハードウェア統合を前提にしています。 ([Beatport Streaming][5])

ただし利用規約上、ストリーミング統合先は **Partner Company** とされており、一般開発者向けのセルフサービスAPIではありません。事業提携・審査前提です。 ([ビートポートサポート][6])

電子音楽中心なら Beatport、ヒップホップ・ポップス・オープンフォーマット寄りなら Beatsource が第一候補です。

### Spotify

現在は rekordbox、Serato、djay などでSpotify Premium楽曲を直接ミックスできます。 ([Spotify][7])

しかし、一般公開されている Web Playback SDK では、

* 商用ストリーミングアプリは禁止
* Spotifyコンテンツの改変は禁止
* Premiumユーザーのみフル再生可能

と明記されています。したがって、通常のDeveloper APIを利用して独自DJエンジンを作るルートではなく、**Spotifyとの承認済みDJ統合が必要**です。 ([Spotify for Developers][8])

### Apple Music

通常のMusicKitでApple Musicカタログをアプリ内再生できます。一方、Apple MusicのDJ統合は AlphaTheta、Serato、Denon DJ、Algoriddimなど、特定プラットフォーム向けに提供されています。 ([Apple Developer][9])

公開MusicKitを、PCM取得・スクラッチ・任意タイムストレッチ可能なAPIとして設計に組み込むのは避けるべきです。高度なDJ統合はパートナー枠と考えるのが妥当です。

## 推奨方針

マスターのアプリなら、次の順序が堅いです。

1. **ローカルファイルを基準実装**にする
2. **AudiusまたはJamendo**でストリーミング経路を検証する
3. SoundCloudは追加プロバイダーとして実験する
4. 動くDJエンジンとユーザー実績を作った段階で、Beatport／Beatsource／Spotify等に提携を打診する

設計上は、共通インターフェースを単純な `getStreamUrl()` にしない方がよいです。DRM系はURLやPCMを渡さず、制御されたプレイヤーしか提供しない可能性が高いためです。

```text
TrackProvider
├─ search()
├─ authenticate()
├─ preparePlayback()
└─ capabilities
   ├─ rawAudioAccessible
   ├─ simultaneousDecks
   ├─ sampleAccurateSeek
   ├─ tempoControl
   ├─ keyLock
   ├─ offlineCache
   ├─ waveformAccess
   └─ stems
```

**現時点の主力案は「ローカル＋Audius/Jamendoで完成させ、Beatport系提携に進む」です。** Spotifyを最初の依存先にすると、技術より契約がblockingになり、完成経路を失いやすいです。

[1]: https://docs.audius.org/developers/api/stream-track "Getting Started – Audius Developer Docs"
[2]: https://developer.jamendo.com/v3.0/tracks "Jamendo Api Documentation - tracks method"
[3]: https://developers.soundcloud.com/docs/api/guide "API - Guide - SoundCloud Developers"
[4]: https://developers.soundcloud.com/docs/api/terms-of-use.html "API Terms of Use - SoundCloud Developers"
[5]: https://stream.beatport.com/?utm_source=chatgpt.com "Beatport Streaming | DJ Streaming | Access Your Music Anywhere"
[6]: https://support.beatport.com/hc/en-us/articles/4412639493012-What-are-the-terms-of-use-for-Beatport-Streaming "What are the terms of use for Beatport Streaming? – Beatport Customer Support"
[7]: https://newsroom.spotify.com/2025-09-24/dj-software-integration-premium/ "Spotify Premium Integrates With Leading DJ Software in 51 Markets — Spotify"
[8]: https://developer.spotify.com/policy "Spotify Developer Policy | Spotify for Developers"
[9]: https://developer.apple.com/musickit/?utm_source=chatgpt.com "MusicKit"
