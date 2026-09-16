import { instantiateWasmPredicate } from "./wasm-runtime";
self.onmessage = async (event: MessageEvent) => {
  try {
    const { build, bytes, input } = event.data;
    const runtime = await instantiateWasmPredicate(build, bytes);
    self.postMessage({ value: runtime.evaluate(input) });
  } catch {
    self.postMessage({ error: true });
  }
};
