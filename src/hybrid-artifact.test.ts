import { describe, expect, test } from "bun:test";

import {
  parseHybridArtifactManifest,
  type HybridArtifactManifest,
} from "./hybrid-artifact";
import { HybridArtifactError } from "./hybrid-artifact-values";
import { assertStatelessWasmBinary } from "./wasm-runtime";

const hash = "a".repeat(64);
const manifest = {
  version: 1,
  kind: "hybrid-imported-predicate",
  profile: "predicate-i32-v1",
  functionName: "predicate",
  files: {
    source: { path: "source.ts", hash },
    typescriptProfile: { path: "typescript.json", hash },
    resolution: { path: "resolution.json", hash },
    jsonSchema: { path: "schema.json", hash },
    specification: { path: "specification.md", hash },
    build: { path: "build.json", hash },
    wasm: { path: `${hash}.wasm`, hash },
  },
} satisfies HybridArtifactManifest;

describe("Hybrid artifact manifest", () => {
  test("strictly parses the fixed portable file set", () => {
    expect(parseHybridArtifactManifest(manifest)).toEqual(manifest);
    expect(() =>
      parseHybridArtifactManifest({ ...manifest, unknown: true }),
    ).toThrow("unknown field unknown");
    expect(() =>
      parseHybridArtifactManifest({
        ...manifest,
        files: {
          ...manifest.files,
          source: { path: "../source.ts", hash },
        },
      }),
    ).toThrow("invalid or duplicate artifact path");
    expect(() =>
      parseHybridArtifactManifest({
        ...manifest,
        files: {
          ...manifest.files,
          source: { path: "source.ts", hash },
          resolution: { path: "source.ts", hash },
        },
      }),
    ).toThrow("invalid or duplicate artifact path");
  });

  test("bounds diagnostics", () => {
    const error = new HybridArtifactError(
      "INVALID_ARTIFACT",
      "x".repeat(9_000),
    );
    expect(error.message.length).toBeLessThanOrEqual(2_000);
  });

  test("rejects stateful Wasm sections without loading Binaryen", () => {
    const memoryOnlyModule = new Uint8Array([
      0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x05, 0x03, 0x01, 0x00,
      0x01,
    ]);
    expect(WebAssembly.validate(memoryOnlyModule)).toBe(true);
    expect(() => assertStatelessWasmBinary(memoryOnlyModule)).toThrow(
      "stateful Wasm sections",
    );
  });
});
