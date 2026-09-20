import { describe, expect, test } from "bun:test";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { resolve } from "node:path";

import {
  hybridArtifactHash,
  loadImportedPredicateArtifact,
  readHybridArtifact,
  verifyImportedPredicateArtifact,
} from "./hybrid-artifact";
import { buildImportedPredicateArtifact } from "./hybrid-artifact-builder";
import { rebuildVerifyImportedPredicateArtifact } from "./hybrid-artifact-rebuild";
import { canonicalJson } from "./hybrid-artifact-values";
import {
  hybridImportResolutionHash,
  parseHybridImportResolution,
} from "./hybrid-import-resolution";
import { hybridTypeScriptProfileHash } from "./hybrid-typescript-profile";
import { sha256 } from "./stable-hash";
import { WASM_LIMITS } from "./wasm-contract";

const repo = resolve(import.meta.dir, "..");
const source = resolve(repo, "examples/hybrid-order/can-ship.ts");

describe("Hybrid imported Predicate artifact", () => {
  test("builds, verifies, rebuilds, and executes offline", async () => {
    await withWorkspace(async (workspace) => {
      const built = await build(workspace, "canShip", "can-ship");
      expect(built).toMatchObject({
        semanticHash:
          "e92e379d4b51cab9e551b945f74fe381f2e539396ef03dc8aeebcac0403d8e69",
        wasmHash:
          "b9d6849e6d5d91beab447ba6d318c0ee531cdd450b6701b28bef4a6cfbb5c582",
        apiCalls: 0,
      });
      expect(
        await verifyImportedPredicateArtifact(built.manifest),
      ).toMatchObject({
        mode: "portable",
        status: "passed",
        writes: 0,
      });
      expect(
        await rebuildVerifyImportedPredicateArtifact(built.manifest),
      ).toMatchObject({ mode: "rebuild", status: "passed", apiCalls: 0 });
      const runtime = await loadImportedPredicateArtifact(built.manifest);
      expect(
        runtime.evaluate({
          paymentStatus: "paid",
          inventoryReserved: true,
          holdReason: null,
          cancelled: false,
        }),
      ).toBe(true);
      expect(
        runtime.evaluate({
          paymentStatus: "pending",
          inventoryReserved: true,
        }),
      ).toBe(false);
      expect(() => runtime.evaluate({ paymentStatus: "paid" })).toThrow(
        "inventoryReserved",
      );

      const review = await build(
        workspace,
        "needsManualReview",
        "needs-manual-review",
      );
      expect(review).toMatchObject({
        artifactHash:
          "a55792faa7e194678531c67114a15c5fb8b3185c40a14dc48eaa241b69725522",
        semanticHash:
          "d50530d67a204c5ff30f99f7d8261db8a9ec04cc518dc20682fca6f33c8ba6f3",
        wasmHash:
          "31e35f6157e4f5b7255f95a90784fb6fe5525d2af4aced75727d364389dabe4b",
      });
      await expect(
        rebuildVerifyImportedPredicateArtifact(review.manifest),
      ).resolves.toHaveProperty("status", "passed");
    });
  });

  test("is byte-for-byte deterministic across output directories", async () => {
    await withWorkspace(async (workspace) => {
      const first = await build(workspace, "canShip", "first");
      const second = await build(workspace, "canShip", "second");
      expect(second.artifactHash).toBe(first.artifactHash);
      const firstArtifact = await readHybridArtifact(first.manifest);
      const secondArtifact = await readHybridArtifact(second.manifest);
      expect(secondArtifact.manifest).toEqual(firstArtifact.manifest);
      for (const ref of Object.values(firstArtifact.manifest.files)) {
        expect(await readFile(resolve(workspace, "first", ref.path))).toEqual(
          await readFile(resolve(workspace, "second", ref.path)),
        );
      }
    });
  });

  test("keeps semantic and Wasm hashes stable across source-only formatting", async () => {
    await withWorkspace(async (workspace) => {
      const first = await build(workspace, "canShip", "original");
      const formattedSource = resolve(workspace, "formatted.ts");
      await writeFile(formattedSource, `${await readFile(source, "utf8")}\n`);
      const second = await buildImportedPredicateArtifact({
        workspaceRoot: repo,
        sourcePath: formattedSource,
        functionName: "canShip",
        outputDirectory: resolve(workspace, "formatted"),
      });
      expect(second.artifactHash).not.toBe(first.artifactHash);
      expect(second.semanticHash).toBe(first.semanticHash);
      expect(second.wasmHash).toBe(first.wasmHash);
    });
  });

  test("detects every independently modified artifact file", async () => {
    await withWorkspace(async (workspace) => {
      const built = await build(workspace, "canShip", "base");
      const artifact = await readHybridArtifact(built.manifest);
      for (const [role, ref] of Object.entries(artifact.manifest.files)) {
        const copy = resolve(workspace, `tamper-${role}`);
        await cp(resolve(workspace, "base"), copy, { recursive: true });
        const path = resolve(copy, ref.path);
        const bytes = new Uint8Array(await readFile(path));
        bytes[0] = (bytes[0] ?? 0) ^ 1;
        await writeFile(path, bytes);
        await expect(
          verifyImportedPredicateArtifact(resolve(copy, "artifact.json")),
        ).rejects.toThrow(`${role} hash mismatch`);
      }
      const manifestCopy = resolve(workspace, "tamper-manifest");
      await cp(resolve(workspace, "base"), manifestCopy, { recursive: true });
      const manifest = JSON.parse(
        await readFile(resolve(manifestCopy, "artifact.json"), "utf8"),
      );
      manifest.functionName = "other";
      await writeFile(
        resolve(manifestCopy, "artifact.json"),
        canonicalJson(manifest),
      );
      await expect(
        verifyImportedPredicateArtifact(resolve(manifestCopy, "artifact.json")),
      ).rejects.toThrow("artifact linkage mismatch");
    });
  });

  test("detects coordinated source and hash tampering through linkage", async () => {
    await withWorkspace(async (workspace) => {
      await build(workspace, "canShip", "base");
      const copy = resolve(workspace, "coordinated");
      await cp(resolve(workspace, "base"), copy, { recursive: true });
      const sourcePath = resolve(copy, "source.ts");
      await writeFile(sourcePath, `${await readFile(sourcePath, "utf8")}\n`);
      const manifestPath = resolve(copy, "artifact.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      manifest.files.source.hash = sha256(
        new Uint8Array(await readFile(sourcePath)),
      );
      await writeFile(manifestPath, canonicalJson(manifest));
      await expect(
        verifyImportedPredicateArtifact(manifestPath),
      ).rejects.toThrow("artifact linkage mismatch");
    });
  });

  test("does not overwrite output and allows only one concurrent publisher", async () => {
    await withWorkspace(async (workspace) => {
      await build(workspace, "canShip", "existing");
      await expect(build(workspace, "canShip", "existing")).rejects.toThrow(
        "OUTPUT_EXISTS",
      );
      const results = await Promise.allSettled([
        build(workspace, "canShip", "race"),
        build(workspace, "canShip", "race"),
      ]);
      expect(
        results.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      expect(
        results.filter((result) => result.status === "rejected"),
      ).toHaveLength(1);
      await expect(
        verifyImportedPredicateArtifact(
          resolve(workspace, "race/artifact.json"),
        ),
      ).resolves.toHaveProperty("status", "passed");
    });
  }, 15_000);

  test("cleans partial output after write and publication failures", async () => {
    await withWorkspace(async (workspace) => {
      let writes = 0;
      await expect(
        buildImportedPredicateArtifact(input(workspace, "write-failure"), {
          writeFile: async (...args) => {
            writes += 1;
            if (writes === 3) throw new Error("injected write failure");
            return writeFile(...args);
          },
        }),
      ).rejects.toThrow("PUBLICATION_FAILED");
      expect(await pathExists(resolve(workspace, "write-failure"))).toBe(false);
      await expect(
        buildImportedPredicateArtifact(input(workspace, "move-failure"), {
          rename: async () => {
            throw new Error("injected rename failure");
          },
        }),
      ).rejects.toThrow("PUBLICATION_FAILED");
      expect(await pathExists(resolve(workspace, "move-failure"))).toBe(false);
    });
  }, 15_000);

  test("detects a source race before publication", async () => {
    await withWorkspace(async (workspace) => {
      const localSource = resolve(workspace, "race-source.ts");
      await writeFile(localSource, await readFile(source));
      try {
        await expect(
          buildImportedPredicateArtifact(
            {
              workspaceRoot: repo,
              sourcePath: localSource,
              functionName: "canShip",
              outputDirectory: resolve(workspace, "source-race"),
            },
            {
              afterImport: async () => {
                await writeFile(
                  localSource,
                  `${await readFile(localSource, "utf8")}\n`,
                );
              },
            },
          ),
        ).rejects.toThrow("SOURCE_CHANGED");
        expect(await pathExists(resolve(workspace, "source-race"))).toBe(false);
      } finally {
        await rm(localSource, { force: true });
      }
    });
  });

  test("rejects imported source dependencies and symlinked artifact files", async () => {
    await withWorkspace(async (workspace) => {
      const importedSource = resolve(workspace, "imported.ts");
      await writeFile(
        importedSource,
        'import type { Order } from "../examples/hybrid-order/can-ship";\nexport function f(input: Order): boolean { return input.cancelled === true; }\n',
      );
      await expect(
        buildImportedPredicateArtifact({
          workspaceRoot: repo,
          sourcePath: importedSource,
          functionName: "f",
          outputDirectory: resolve(workspace, "imported-artifact"),
        }),
      ).rejects.toThrow("not supported in artifact source");

      const built = await build(workspace, "canShip", "symlink-base");
      const artifact = await readHybridArtifact(built.manifest);
      const schema = resolve(workspace, "symlink-base/schema.json");
      const target = resolve(workspace, "schema-target.json");
      await rename(schema, target);
      await symlink(target, schema);
      await expect(
        verifyImportedPredicateArtifact(built.manifest),
      ).rejects.toThrow("artifact directory");
      expect(hybridArtifactHash(artifact.manifest)).toBe(built.artifactHash);
    });
  });

  test("rejects oversized entries and symlinked output parents", async () => {
    await withWorkspace(async (workspace) => {
      await build(workspace, "canShip", "oversized");
      const root = resolve(workspace, "oversized");
      const schema = resolve(root, "schema.json");
      const oversized = new Uint8Array(WASM_LIMITS.bytes + 1);
      await writeFile(schema, oversized);
      const manifestPath = resolve(root, "artifact.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      manifest.files.jsonSchema.hash = sha256(oversized);
      await writeFile(manifestPath, canonicalJson(manifest));
      await expect(
        verifyImportedPredicateArtifact(manifestPath),
      ).rejects.toThrow("size limit");

      const actualParent = resolve(workspace, "actual-parent");
      await mkdir(actualParent);
      const linkedParent = resolve(workspace, "linked-parent");
      await symlink(actualParent, linkedParent);
      await expect(
        buildImportedPredicateArtifact({
          workspaceRoot: repo,
          sourcePath: source,
          functionName: "canShip",
          outputDirectory: resolve(linkedParent, "artifact"),
        }),
      ).rejects.toThrow("non-symlink directory");
    });
  });

  test("never executes the inspected TypeScript module", async () => {
    await withWorkspace(async (workspace) => {
      const throwingSource = resolve(workspace, "throwing.ts");
      await writeFile(
        throwingSource,
        [
          "export interface Input { enabled: boolean; }",
          'throw new Error("source module was executed");',
          "export function isEnabled(input: Input): boolean {",
          "  return input.enabled === true;",
          "}",
          "",
        ].join("\n"),
      );
      const built = await buildImportedPredicateArtifact({
        workspaceRoot: repo,
        sourcePath: throwingSource,
        functionName: "isEnabled",
        outputDirectory: resolve(workspace, "throwing-artifact"),
      });
      await expect(
        verifyImportedPredicateArtifact(built.manifest),
      ).resolves.toHaveProperty("status", "passed");
    });
  });

  test("separates portable success from a rebuild toolchain mismatch", async () => {
    await withWorkspace(async (workspace) => {
      await build(workspace, "canShip", "toolchain");
      const root = resolve(workspace, "toolchain");
      const profilePath = resolve(root, "typescript.json");
      const resolutionPath = resolve(root, "resolution.json");
      const buildPath = resolve(root, "build.json");
      const manifestPath = resolve(root, "artifact.json");
      const profile = JSON.parse(await readFile(profilePath, "utf8"));
      profile.typescriptVersion = "0.0.0";
      await writeFile(profilePath, canonicalJson(profile));
      const resolution = JSON.parse(await readFile(resolutionPath, "utf8"));
      resolution.typescript.version = "0.0.0";
      resolution.typescript.optionsHash = hybridTypeScriptProfileHash(profile);
      const parsedResolution = parseHybridImportResolution(resolution, profile);
      await writeFile(resolutionPath, canonicalJson(parsedResolution));
      const buildManifest = JSON.parse(await readFile(buildPath, "utf8"));
      buildManifest.resolutionHash =
        hybridImportResolutionHash(parsedResolution);
      await writeFile(buildPath, canonicalJson(buildManifest));
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      manifest.files.typescriptProfile.hash = sha256(
        new Uint8Array(await readFile(profilePath)),
      );
      manifest.files.resolution.hash = sha256(
        new Uint8Array(await readFile(resolutionPath)),
      );
      manifest.files.build.hash = sha256(
        new Uint8Array(await readFile(buildPath)),
      );
      await writeFile(manifestPath, canonicalJson(manifest));
      await expect(
        verifyImportedPredicateArtifact(manifestPath),
      ).resolves.toHaveProperty("status", "passed");
      await expect(
        rebuildVerifyImportedPredicateArtifact(manifestPath),
      ).rejects.toThrow("TOOLCHAIN_MISMATCH");
    });
  });
});

async function withWorkspace(run: (workspace: string) => Promise<void>) {
  const workspace = await mkdtemp(resolve(repo, ".tmp-hybrid-artifact-test-"));
  try {
    await run(workspace);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

function input(workspace: string, output: string) {
  return {
    workspaceRoot: repo,
    sourcePath: source,
    functionName: "canShip",
    outputDirectory: resolve(workspace, output),
  };
}

function build(workspace: string, functionName: string, output: string) {
  return buildImportedPredicateArtifact({
    workspaceRoot: repo,
    sourcePath: source,
    functionName,
    outputDirectory: resolve(workspace, output),
  });
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return false;
    }
    throw error;
  }
}
