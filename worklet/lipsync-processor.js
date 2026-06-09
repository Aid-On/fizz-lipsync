// lipsync-processor.js — AudioWorklet that runs the Almide lipsync DSP (wasm).
//
// 1 render quantum (128 sample) ごとに:
//   1. 入力 Float32 ブロックを wasm 線形メモリに書く
//   2. エクスポートされた lipsync_step(n, prev, ...) を呼ぶ
//   3. 返ってきた口の開き [0,1] をメインスレッドへ postMessage
//
// DSP 本体は fizz_lipsync (Almide、src/mod.almd) を wasm にコンパイルしたもの。
// Web Audio の I/O だけ JS が担当し、数学は Almide コアが担う。同じコアが native
// バックエンド (オフライン precompute CLI) でも走る。
//
// ── 前提 (現状の制約) ─────────────────────────────────────────────
// この glue は wasm エクスポート lipsync_init / lipsync_step + 線形メモリの export
// を必要とする。それには almide の WASM バックエンドが RawPtr / 線形メモリブリッジ
// (bytes.as_mut_ptr 等) を実装している必要があるが、現状 native cdylib 専用で
// --target wasm では未実装 (almide/almide#440)。
// ブリッジが入るまでは、native の precompute CLI (build/fizz-lipsync) で口パク
// カーブをオフライン生成し、再生に同期させる経路を使う。

class LipsyncProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.mouth = 0;
    this.ready = false;
    // パラメータ (口の開きの追従特性)。processorOptions で上書き可。
    const p = options?.processorOptions ?? {};
    this.attack = p.attack ?? 0.6;
    this.release = p.release ?? 0.15;
    this.gain = p.gain ?? 4.0;
    this.floor = p.floor ?? 0.01;
    const wasm = p.wasm; // ArrayBuffer of the compiled fizz_lipsync wasm
    if (wasm) this._init(wasm);
  }

  async _init(wasmBytes) {
    const { instance } = await WebAssembly.instantiate(wasmBytes, {});
    this.ex = instance.exports;
    this.mem = this.ex.memory;
    // 128 sample 分 (f32 = 4 byte) のバッファを 1 度だけ確保し、毎 quantum 使い回す。
    this.ptr = Number(this.ex.lipsync_init(128 * 4));
    this.ready = true;
  }

  process(inputs) {
    const ch = inputs[0]?.[0];
    if (!ch || !this.ready) return true;
    // 入力ブロックを wasm メモリの確保済みオフセットへ書き込む。
    new Float32Array(this.mem.buffer, this.ptr, ch.length).set(ch);
    // 1 ステップ進める。前フレームの mouth を渡し、更新後を受け取る。
    this.mouth = this.ex.lipsync_step(
      ch.length, this.mouth, this.attack, this.release, this.gain, this.floor,
    );
    this.port.postMessage(this.mouth);
    return true;
  }
}

registerProcessor("fizz-lipsync", LipsyncProcessor);
