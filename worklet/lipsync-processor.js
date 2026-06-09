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
    // fizz_lipsync.wasm は WASI import を宣言する (実際の DSP は使わない)。
    // 呼ばれない前提で no-op スタブを与える。
    const mod = await WebAssembly.compile(wasmBytes);
    const imports = {};
    for (const i of WebAssembly.Module.imports(mod)) {
      (imports[i.module] ??= {})[i.name] = () => 0;
    }
    const instance = await WebAssembly.instantiate(mod, imports);
    this.ex = instance.exports;
    this.mem = this.ex.memory;
    // ヒープ/グローバル初期化のため _start を一度走らせる (proc_exit stub で抜ける)。
    try { this.ex._start(); } catch (_) { /* proc_exit */ }
    // 128 sample のバッファを 1 度だけ確保し、書き込みオフセットを得る。毎 quantum 使い回す。
    this.n = 128;
    this.ptr = Number(this.ex.lipsync_init(BigInt(this.n)));
    this.ready = true;
  }

  process(inputs) {
    const ch = inputs[0]?.[0];
    if (!ch || !this.ready) return true;
    // 入力ブロック (128 sample) を wasm メモリの確保済みオフセットへ書き込む。
    // メモリは grow で再確保され得るので毎回 view を作る (buffer が detach する)。
    new Float32Array(this.mem.buffer, this.ptr, this.n).set(ch.subarray(0, this.n));
    // 1 ステップ進める。前フレームの mouth を渡し、更新後を受け取る。
    // 引数は Float のみ = JS の number でそのまま呼べる (Int は wasm i64=BigInt のため避けた)。
    this.mouth = this.ex.lipsync_step(
      this.mouth, this.attack, this.release, this.gain, this.floor,
    );
    this.port.postMessage(this.mouth);
    return true;
  }
}

registerProcessor("fizz-lipsync", LipsyncProcessor);
