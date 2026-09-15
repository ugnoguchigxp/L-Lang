import { runCapabilityCases } from "./capability-tests";
import { instantiateWasmPredicate } from "./wasm-runtime";

self.onmessage = async (event: MessageEvent) => {
  try {
    const { manifest, bytes, source, suite } = event.data;
    const runtime = await instantiateWasmPredicate(manifest, bytes);
    self.postMessage({
      results: runCapabilityCases(source, suite, runtime.evaluate),
    });
  } catch (error) {
    self.postMessage({
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
