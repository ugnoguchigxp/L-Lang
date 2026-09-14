import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import binaryen from "binaryen";
import { atomicWriteFile } from "./atomic-file";
import {
  parseManifest,
  readArtifact,
  readBounded,
  saveArtifact,
} from "./wasm-artifact";
import { runWasmCli } from "./wasm-cli";
import { digest, WASM_LIMITS } from "./wasm-contract";
import { loadWasmPredicate } from "./wasm-runtime";
import { fixtureArtifact } from "./wasm-test-fixture";

async function workspace(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(resolve(tmpdir(), "llang-wasm-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("Wasm artifact and host boundary", () => {
  test("saves, reloads and reuses the instance", async () =>
    workspace(async (root) => {
      const { bytes, manifest } = fixtureArtifact();
      const path = await saveArtifact(root, bytes, manifest);
      const loaded = await readArtifact(path);
      expect(loaded.bytes).toEqual(bytes);
      const runtime = await loadWasmPredicate(path);
      for (let i = 0; i < 10; i++) {
        expect(
          runtime.evaluate({ status: "active", deletedAt: null, email: "" }),
        ).toBe(true);
        expect(
          runtime.evaluate({ status: "suspended", deletedAt: null, email: "" }),
        ).toBe(false);
      }
      const input = resolve(root, "input.json");
      await writeFile(
        input,
        JSON.stringify({ status: "active", deletedAt: null, email: "" }),
      );
      expect(await runWasmCli(["run", path, "--input", input])).toEqual({
        result: true,
      });
    }));
  test("strict manifest and bounded reads reject malformed artifacts", async () =>
    workspace(async (root) => {
      const { bytes, manifest } = fixtureArtifact();
      for (const bad of [
        { ...manifest, extra: true },
        { ...manifest, version: 2 },
        { ...manifest, file: "../outside.wasm" },
        { ...manifest, provenance: {} },
        {
          ...manifest,
          provenance: { ...manifest.provenance, contextVersion: 2 },
        },
      ])
        expect(() => parseManifest(bad)).toThrow();
      const path = await saveArtifact(root, bytes, manifest);
      await writeFile(resolve(root, manifest.file), new Uint8Array([0, 1]));
      await expect(readArtifact(path)).rejects.toThrow("ARTIFACT_MISMATCH");
      await expect(
        saveArtifact(root, new Uint8Array([1]), manifest),
      ).rejects.toThrow();
      const large = resolve(root, "large");
      await writeFile(large, new Uint8Array(WASM_LIMITS.bytes + 1));
      await expect(readBounded(large)).rejects.toThrow("size limit");
    }));
  test("ABI edits cannot silently reinterpret unchanged Wasm", async () =>
    workspace(async (root) => {
      const { bytes, manifest } = fixtureArtifact();
      const changed = structuredClone(manifest);
      const field = changed.contract.fields.find((f) => f.name === "email");
      if (!field) throw new Error("fixture");
      field.optional = true;
      const path = await saveArtifact(root, bytes, changed);
      await expect(loadWasmPredicate(path)).rejects.toThrow("ABI contract");
    }));
  test("failed publication keeps the previous manifest usable", async () =>
    workspace(async (root) => {
      const first = fixtureArtifact();
      const path = await saveArtifact(root, first.bytes, first.manifest);
      const before = await readFile(path, "utf8");
      const next = fixtureArtifact({
        kind: "not",
        condition: { kind: "present", property: ["email"] },
      });
      await expect(
        saveArtifact(root, next.bytes, next.manifest, async (target, data) => {
          if (target === path) throw new Error("injected write failure");
          await atomicWriteFile(target, data);
        }),
      ).rejects.toThrow("injected");
      expect(await readFile(path, "utf8")).toBe(before);
      expect(
        (await loadWasmPredicate(path)).evaluate({
          status: "active",
          deletedAt: null,
          email: "",
        }),
      ).toBe(true);
    }));
  test("rejects symlinked binary", async () =>
    workspace(async (root) => {
      const { bytes, manifest } = fixtureArtifact();
      const path = await saveArtifact(root, bytes, manifest);
      const binary = resolve(root, manifest.file);
      await rm(binary);
      await writeFile(resolve(root, "other.wasm"), bytes);
      await symlink(resolve(root, "other.wasm"), binary);
      await expect(readArtifact(path)).rejects.toThrow("symbolic link");
    }));
  test("rejects unexpected imports, exports and non-boolean returns", async () =>
    workspace(async (root) => {
      for (const kind of [
        "extra-export",
        "import",
        "result",
        "missing-binding",
        "arity",
      ]) {
        const { manifest } = fixtureArtifact();
        const module = new binaryen.Module();
        try {
          module.addFunction(
            "evaluate",
            binaryen.createType(
              kind === "arity"
                ? []
                : [binaryen.i32, binaryen.i32, binaryen.i32],
            ),
            binaryen.i32,
            [],
            module.i32.const(2),
          );
          module.addFunctionExport("evaluate", "evaluate");
          if (kind === "extra-export")
            module.addFunctionExport("evaluate", "extra");
          if (kind === "import")
            module.addFunctionImport(
              "host",
              "host",
              "read",
              binaryen.none,
              binaryen.i32,
            );
          if (kind !== "missing-binding")
            module.addCustomSection(
              "llang.contract",
              new TextEncoder().encode(
                digest(JSON.stringify(manifest.contract)),
              ),
            );
          const bytes = new Uint8Array(module.emitBinary());
          const wasmHash = digest(bytes);
          const path = await saveArtifact(root, bytes, {
            ...manifest,
            wasmHash,
            file: `${wasmHash}.wasm`,
          });
          if (kind === "result") {
            const runtime = await loadWasmPredicate(path);
            expect(() =>
              runtime.evaluate({
                status: "active",
                deletedAt: null,
                email: "",
              }),
            ).toThrow("boolean result");
          } else await expect(loadWasmPredicate(path)).rejects.toThrow();
        } finally {
          module.dispose();
        }
      }
    }));
  test("CLI rejects missing and unknown options", async () => {
    await expect(runWasmCli([])).rejects.toThrow("USAGE");
    await expect(runWasmCli(["run", "x", "--bad", "y"])).rejects.toThrow(
      "USAGE",
    );
  });
});
