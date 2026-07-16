# スクラッチ再生の設計アイデア

## 結論

スクラッチは、専用の完成音声ファイルとして保存するよりも、再生ヘッド速度と
クロスフェーダーの時間変化を「演奏データ」として保存する方が再利用しやすい。

任意の楽曲・任意のCUE位置を素材にして、同じスクラッチパターンを適用できる。

## 動作モデル

通常再生中のヘッド速度を`v_base`、スクラッチ中の操作量を`v_gesture(t)`とする。

```text
触っていない: v(t) = v_base
手で止める:   v(t) = 0
前へ送る:     v(t) > 0
後ろへ戻す:   v(t) < 0
手を離す:     v(t) → v_base
```

再生位置は速度曲線の積分で求める。

```text
position(t + dt) = position(t) + v(t) * dt
```

重要な不変条件は、何も操作していない間の回転速度`v_base`が一定であること。
PLAY SPEEDやTEMPO-SYNCが変えるのはこの基準値で、スクラッチは基準値そのものを
破壊せず、一時的なオーバーライドとして扱う。

```text
effectiveVelocity =
  scratchOverride.active
    ? scratchOverride.velocity
    : basePlaybackRate
```

操作終了時は速度を再計算する必要がなく、オーバーライドを解除するだけで、その時点の
`basePlaybackRate`へ戻る。スクラッチ中にTEMPO-SYNCが更新された場合も、解除後は
更新後の基準速度へ自然に復帰できる。

クロスフェーダーやデッキゲインも、同じタイムライン上の包絡線として持たせる。
不要な前進音・後退音を切ることで、transform、chirpなどの演奏パターンを表現できる。

同様にフェーダーも基準値と一時オーバーライドを分離する。

```text
effectiveCrossfader =
  scratchFaderOverride.active
    ? scratchFaderOverride.value
    : userCrossfader
```

これにより、スクラッチ演奏の終了後にユーザーまたはDJ Agentが設定していた元の
フェーダー位置へ戻せる。

## 推奨データ形式

```ts
type ScratchGesture = {
  id: string
  name: string
  durationMs: number
  anchor: 'currentPosition' | 'selectedCue'
  playhead: Array<{
    timeMs: number
    velocity: number // -1=通常速の逆再生、0=停止、1=通常速
  }>
  gate: Array<{
    timeMs: number
    gain: number // 0..1
  }>
  releaseMs: number
}
```

速度は絶対BPMではなく通常再生速度に対する倍率で保存する。これにより、曲のBPMや
PLAY SPEEDが異なっても同じジェスチャーを利用できる。

## 「スクラッチプレイファイル」の扱い

完成したスクラッチ音声ファイルを事前生成する方法は、決め打ちの効果音としては有効。
ただし、元の曲や実行位置が変わると再利用できず、テンポやキーにも追従しない。

代わりに、上記の`ScratchGesture`をスクラッチプレイファイルとして保存し、実行時に
選択中CUE周辺の音声へ適用する方式がよい。必要なら実行結果を後から音声へ書き出せる。

## 現在のエンジンとの差分

現在の`AudioBufferSourceNode`方式には次の制限がある。

- 負の`playbackRate`による逆再生ができない
- 再生ヘッドをサンプル単位で連続的に前後移動できない
- source nodeは一度しか開始できず、細かいseekの連打には向かない

本実装では`AudioWorkletProcessor`へデッキのPCMを渡し、worklet側で浮動小数点の
再生位置を管理する。線形補間以上でサンプルを読み、速度曲線に従って前後再生する。

```text
AudioBuffer
   ↓ PCM
Scratch AudioWorklet
   ├─ playhead position
   ├─ velocity curve
   └─ interpolation
   ↓
deck gain → crossfader → master
```

## 実装段階

1. `ScratchGesture`のデータ形式とプリセットを用意する
2. オフラインレンダラーでCUE周辺からスクラッチ音を生成し、成立性を確認する
3. `AudioWorklet`デッキを試作し、正逆再生と停止を実装する
4. パフォーマンスパッドへスクラッチジェスチャーを割り当てる
5. クロスフェーダー／ゲイン包絡線を同期実行する
6. マウス、タッチ、DJコントローラーのジョグ入力を同じ速度モデルへ接続する

## DJ Agentとの関係

DJ Agentは物理的に円盤を操作する必要がなく、次の命令だけで実行できる。

```text
deck A / selected cue / gesture "baby-scratch-2" / quantize next beat
```

したがって、スクラッチジェスチャーは8スロットのパフォーマンスパッドへ割り当て可能な
アクション種別として扱う。
