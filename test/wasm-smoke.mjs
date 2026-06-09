// wasm-smoke.mjs — fizz-lipsync の wasm (AudioWorklet 用) が native と同じ口パク
// 値を出すかを検証する。CI が `almide build src/bridge.almd --target wasm` の後に
// 走らせる。失敗時は exit 1。
//
//   node test/wasm-smoke.mjs

import { readFileSync } from "node:fs";

const wasmBytes = readFileSync(new URL("../build/lipsync.wasm", import.meta.url));

const mod = await WebAssembly.compile(wasmBytes);
// fizz_lipsync.wasm は WASI import を宣言する (DSP では使わない)。no-op スタブ。
const imports = {};
for (const i of WebAssembly.Module.imports(mod)) {
  (imports[i.module] ??= {})[i.name] = () => 0;
}
const { exports: ex } = await WebAssembly.instantiate(mod, imports);
try { ex._start(); } catch { /* proc_exit */ }

const N = 128;
const ptr = Number(ex.lipsync_init(BigInt(N)));
const view = new Float32Array(ex.memory.buffer, ptr, N);

function step(fill, prev) {
  for (let i = 0; i < N; i++) view[i] = fill;
  return ex.lipsync_step(prev, 0.6, 0.15, 4.0, 0.01);
}

// native と同じ期待値 (spec/lipsync_test.almd と整合):
//   loud (rms 0.5, target 1.0) → attack 0.6 で 0 → 0.6
//   silence → release 0.15 で 0.6 → 0.51
const loud = step(0.5, 0.0);
const silence = step(0.0, loud);

const near = (a, b) => Math.abs(a - b) < 1e-4;
let ok = true;
if (!near(loud, 0.6)) { console.error(`FAIL loud: ${loud} != 0.6`); ok = false; }
if (!near(silence, 0.51)) { console.error(`FAIL silence: ${silence} != 0.51`); ok = false; }

if (ok) {
  console.log(`wasm OK — loud=${loud.toFixed(4)} silence=${silence.toFixed(4)} (matches native)`);
} else {
  process.exit(1);
}
