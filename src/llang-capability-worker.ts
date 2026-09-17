import type { LlangBuildManifest } from "./llang-build";
import type { LlangSuite } from "./llang-capability";
import { executeCases } from "./llang-case-runner";
import { instantiateWasmPredicate } from "./wasm-runtime";

declare const self: Worker;

self.onmessage = async (
  event: MessageEvent<{
    build: LlangBuildManifest;
    bytes: Uint8Array;
    suite: LlangSuite;
  }>,
) => {
  try {
    const predicate = await instantiateWasmPredicate(
      event.data.build,
      event.data.bytes,
    );
    const results = executeCases(event.data.suite, predicate.evaluate);
    self.postMessage({ results });
  } catch (error) {
    self.postMessage({
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
