import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildEffectsProgram,
  readEffectsBuild,
  verifyEffectsBundle,
  type EffectsReplaySuite,
} from "./llang-effects-build";
import {
  effectsManifest,
  HostOperationRegistry,
} from "./llang-effects-contract";

describe("effects portable build and replay", () => {
  test("relocated bundle verifies without compiler or adapter", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "llang-effects-build-")),
      output = join(temporary, "output"),
      moved = join(temporary, "moved"),
      registry = new HostOperationRegistry([
        {
          id: "host.add",
          version: 1,
          requestType: "i32",
          responseType: "i32",
          errorType: "error",
          effect: "host",
          resource: "none",
          cancellable: true,
          idempotent: true,
        },
      ]);
    try {
      const manifest = await buildEffectsProgram({
        program: {
          initial: 1,
          steps: [{ operation: 0, payload: 4, combine: "add" }],
        },
        manifest: effectsManifest(registry, [{ id: "host.add", version: 1 }]),
        outDir: output,
      });
      await rename(output, moved);
      const suite: EffectsReplaySuite = {
        format: "llang-effects-suite",
        version: 5,
        profile: "module-effects-v1",
        programHash: manifest.programHash,
        cases: [
          {
            id: "add",
            events: [
              {
                request: {
                  generation: 0,
                  sequence: 1,
                  operation: 0,
                  payload: 4,
                },
                response: { ok: true, value: 2 },
              },
            ],
            expected: 3,
          },
        ],
      };
      expect(
        (await verifyEffectsBundle(join(moved, "effects-build.json"), suite))
          .ok,
      ).toBe(true);
      const wasm = join(moved, "program.wasm"),
        bytes = await readFile(wasm);
      bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 1;
      await writeFile(wasm, bytes);
      expect(
        readEffectsBuild(join(moved, "effects-build.json")),
      ).rejects.toThrow("ARTIFACT_MISMATCH");
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });
});
