# fizz-lipsync

Fizz の **口パき (lipsync) DSP コア**。音声サンプルの RMS を取り、エンベロープ追従で
滑らかな口の開き値 [0,1] に変換する。

設計の肝: **DSP を Almide で 1 回だけ書き、native と wasm の両バックエンドで使う**。

```
            ┌─────────────────────────┐
audio  ──▶  │  fizz_lipsync DSP core   │  ──▶  mouth value [0,1]
samples     │  (src/mod.almd, 純 Almide) │
            └─────────────────────────┘
                 ▲                  ▲
        native (Rust)          wasm (AudioWorklet)
   オフライン precompute CLI    1 quantum ごとに呼ぶ
   (src/main.almd)             (worklet/lipsync-processor.js)
```

Web Audio の I/O (`AudioContext` / 再生 / マイク) はブラウザ専用なので JS グルーが
担当し、**数学はこの Almide コアが担う**。

## DSP

エンベロープ追従は一極ローパス。`target = clamp01((rms - floor) * gain)` に、開く時は
`attack`(速い)、閉じる時は `release`(ゆっくり)の係数で寄せる。既定値は
`attack=0.6 / release=0.15 / gain=4.0 / floor=0.01`。

## ① native バックエンド — オフライン precompute(動作する)

raw f32 LE モノラルサンプル(例: `ffmpeg -i in.wav -f f32le -ac 1 out.f32`)を
口パクカーブに変換する:

```sh
almide build src/main.almd -o build/fizz-lipsync
FIZZ_LIPSYNC_INPUT=out.f32 FIZZ_LIPSYNC_BLOCK=512 ./build/fizz-lipsync
# {"i":0,"mouth":0}
# {"i":1,"mouth":0.6}    ← 大音量で速く開く
# {"i":2,"mouth":0.51}   ← 無音でゆっくり閉じる
```

ランタイムはこのカーブを再生に同期させるだけでよい(live 解析よりタブ間同期が正確)。

## ② wasm バックエンド — AudioWorklet(ブリッジ待ち)

`src/bridge.almd` を wasm にコンパイルすると `lipsync_init` / `lipsync_step` を
エクスポートし、`worklet/lipsync-processor.js` がそれを 1 render quantum ごとに呼ぶ。

**現状の制約**: これには almide の WASM バックエンドが RawPtr / 線形メモリブリッジ
(`bytes.as_mut_ptr` 等)を実装している必要があるが、現状 **native cdylib 専用**で
`--target wasm` では未実装([almide/almide#440](https://github.com/almide/almide/issues/440))。
ブリッジが入れば、同じ DSP コアがそのまま AudioWorklet で走る。それまでは ① の
precompute 経路を使う。

## 開発

```sh
almide check src/main.almd
almide test spec/lipsync_test.almd
almide build src/main.almd -o build/fizz-lipsync
```

ツールチェーン: [almide](https://github.com/almide/almide) v0.26.6+。依存なし。
