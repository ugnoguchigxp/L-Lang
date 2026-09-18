import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { replayLinearEffects } from "./llang-effects-wasm";
import {
  buildEffectsModuleProgram,
  readEffectsModuleBuildManifest,
} from "./llang-module-effects-build";

const definition = {
  module: "example/effects",
  operations: [
    {
      id: "host.increment",
      version: 1,
      requestType: { value: "i32" },
      responseType: { value: "i32" },
      errorType: { code: "string" },
      effect: "host",
      resource: "none",
      cancellable: true,
      idempotent: true,
    },
  ],
  initial: 1,
  steps: [
    {
      operation: "host.increment",
      version: 1,
      payload: 41,
      combine: "add",
    },
  ],
} as const;

describe("module-effects-v1 build", () => {
  test("JSONC and TypeScript build all targets with matching Wasm semantics", async () => {
    const root = await mkdtemp(join(tmpdir(), "llang-effects-module-"));
    try {
      await writeFile(
        join(root, "main.llang.jsonc"),
        JSON.stringify({
          language: "l-lang",
          version: 5,
          kind: "module",
          profile: "module-effects-v1",
          entry: "main",
          ...definition,
        }),
      );
      await writeFile(
        join(root, "main.ts"),
        `import { defineEffects } from "llang:effects";\nexport const main = defineEffects(${JSON.stringify(definition)});\n`,
      );
      const jsonOut = join(root, "json-out"),
        tsOut = join(root, "ts-out"),
        jsonBuild = await buildEffectsModuleProgram({
          entry: "main.llang.jsonc",
          root,
          entryName: "main",
          target: "all",
          outDir: jsonOut,
        }),
        tsBuild = await buildEffectsModuleProgram({
          entry: "main.ts",
          root,
          entryName: "main",
          target: "all",
          outDir: tsOut,
        });
      expect(tsBuild.programHash).toBe(jsonBuild.programHash);
      expect(tsBuild.interfaceHash).toBe(jsonBuild.interfaceHash);
      const wasmContractHash = jsonBuild.wasm?.contract.programHash;
      if (!wasmContractHash) throw new Error("missing test Wasm contract");
      expect(
        (
          await readEffectsModuleBuildManifest(
            join(jsonOut, "module-build.json"),
          )
        ).manifest.loweredHash,
      ).toBe(wasmContractHash);
      const jsonWasm = new Uint8Array(
          await readFile(join(jsonOut, "wasm/program.wasm")),
        ),
        tsWasm = new Uint8Array(
          await readFile(join(tsOut, "wasm/program.wasm")),
        );
      expect(tsWasm).toEqual(jsonWasm);
      const event = [
        {
          request: { generation: 0, sequence: 1, operation: 0, payload: 41 },
          response: { ok: true, value: 2 },
        },
      ];
      expect(replayLinearEffects(jsonWasm, event).result).toBe(3);
      const generated = (await import(
        `${pathToFileURL(join(jsonOut, "typescript/program.generated.ts")).href}?test=${Date.now()}`
      )) as {
        main(host: {
          invoke(request: unknown): Promise<{ ok: true; value: number }>;
        }): Promise<number>;
      };
      expect(
        await generated.main({
          invoke: async () => ({ ok: true, value: 2 }),
        }),
      ).toBe(3);

      const sourceOnlyOut = join(root, "source-only"),
        sourceOnly = await buildEffectsModuleProgram({
          entry: "main.llang.jsonc",
          root,
          entryName: "main",
          target: "typescript",
          outDir: sourceOnlyOut,
        });
      expect(sourceOnly.wasm).toBeUndefined();
      expect(
        (
          await readEffectsModuleBuildManifest(
            join(sourceOnlyOut, "module-build.json"),
          )
        ).manifest.targets,
      ).toEqual(["typescript"]);

      const manifestPath = join(jsonOut, "module-build.json"),
        manifestText = await readFile(manifestPath, "utf8"),
        changedManifest = JSON.parse(manifestText) as {
          operations: { signatureHash: string }[];
        };
      const firstOperation = changedManifest.operations[0];
      if (!firstOperation) throw new Error("missing test operation");
      firstOperation.signatureHash = "0".repeat(64);
      await writeFile(manifestPath, JSON.stringify(changedManifest));
      await expect(
        readEffectsModuleBuildManifest(manifestPath),
      ).rejects.toThrow("INVALID_ARTIFACT: effects module interface");
      await writeFile(manifestPath, manifestText);

      const changed = new Uint8Array(jsonWasm),
        last = changed.at(-1);
      if (last === undefined) throw new Error("empty test Wasm");
      changed[changed.length - 1] = last ^ 1;
      await writeFile(join(jsonOut, "wasm/program.wasm"), changed);
      await expect(
        readEffectsModuleBuildManifest(join(jsonOut, "module-build.json")),
      ).rejects.toThrow("ARTIFACT_MISMATCH");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
