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

## ② wasm バックエンド — AudioWorklet(動作する)

`src/bridge.almd` を wasm にコンパイルすると `lipsync_init` / `lipsync_step` を
エクスポートし、`worklet/lipsync-processor.js` がそれを 1 render quantum ごとに呼ぶ。

```sh
mkdir -p build
almide build src/bridge.almd --target wasm -o build/lipsync.wasm
```

JS 側は:
1. WASI import を no-op スタブで埋めて instantiate、`_start()` でヒープ初期化
2. `lipsync_init(128)` で 128 sample 分のバッファを確保 → 線形メモリのオフセットを得る
3. 毎 quantum、入力 Float32 ブロックをそのオフセットへ書き、`lipsync_step(prev, ...)` を呼ぶ

**検証済み**: JS から書いた f32 サンプルに対する口の開き値が **native バックエンドと
完全一致**(loud→0.6000 / silence→0.5100)。同じ DSP コアが native でも wasm でも
同じ結果を出す。

**ツールチェーン注記**: wasm 化には almide の WASM バイナリブリッジ
`bytes.as_mut_ptr`([almide/almide#440](https://github.com/almide/almide/issues/440)
で実装)が要る。これは未リリースなので、リリース版 v0.26.6 では `--target wasm` が
まだ ICE する。リリースまでは ① の native precompute 経路を使う。なお `@export(wasm)`
関数は codegen の tree-shaking で本体が落ちないよう `src/bridge.almd` の `main` から
参照してルート化している(同 #440)。

## 開発

```sh
almide check src/main.almd
almide test spec/lipsync_test.almd
almide build src/main.almd -o build/fizz-lipsync
```

ツールチェーン: [almide](https://github.com/almide/almide) v0.26.6+。依存なし。
