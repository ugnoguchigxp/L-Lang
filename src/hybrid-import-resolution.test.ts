import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import {
  parseHybridImportResolution,
  type HybridImportResolution,
} from "./hybrid-import-resolution";
import {
  createHybridTypeScriptProfile,
  hybridTypeScriptProfileHash,
  parseHybridTypeScriptProfile,
} from "./hybrid-typescript-profile";
import { importTypeScriptPredicate } from "./typescript-predicate-importer";

const repo = resolve(import.meta.dir, "..");
const example = resolve(repo, "examples/hybrid-order/can-ship.ts");

describe("Hybrid artifact contracts", () => {
  test("strictly parses the fixed TypeScript profile", () => {
    const profile = createHybridTypeScriptProfile();
    expect(parseHybridTypeScriptProfile(profile)).toEqual(profile);
    expect(hybridTypeScriptProfileHash(profile)).toMatch(/^[a-f0-9]{64}$/);
    expect(() =>
      parseHybridTypeScriptProfile({ ...profile, extra: true }),
    ).toThrow("unknown field extra");
    expect(() =>
      parseHybridTypeScriptProfile({
        ...profile,
        compilerOptions: {
          ...profile.compilerOptions,
          strictNullChecks: false,
        },
      }),
    ).toThrow("unsupported TypeScript artifact profile");
  });

  test("links source, TypeScript profile, canonical type, and semantic IR", async () => {
    const imported = await importTypeScriptPredicate({
      workspaceRoot: repo,
      sourcePath: example,
      functionName: "canShip",
    });
    const profile = createHybridTypeScriptProfile();
    const input = {
      version: 1,
      profile: "predicate-i32-v1",
      source: {
        file: "source.ts",
        functionName: imported.source.functionName,
        sourceHash: imported.source.sourceHash,
      },
      typescript: {
        profile: profile.profile,
        version: profile.typescriptVersion,
        optionsHash: hybridTypeScriptProfileHash(profile),
      },
      input: {
        parameterName: imported.input.parameterName,
        typeName: imported.input.typeName,
        canonicalType: imported.input.canonicalType,
        canonicalTypeHash: imported.input.canonicalTypeHash,
      },
      body: imported.body,
      semanticHash: imported.semanticHash,
    } satisfies HybridImportResolution;
    expect(parseHybridImportResolution(input, profile)).toEqual(input);
    expect(() =>
      parseHybridImportResolution({
        ...input,
        semanticHash: "0".repeat(64),
      }),
    ).toThrow("semantic hash mismatch");
    expect(() =>
      parseHybridImportResolution(input, {
        ...profile,
        typescriptVersion: "0.0.0",
      }),
    ).toThrow("TypeScript profile linkage mismatch");

    let invoked = false;
    const unsafeBody = Object.defineProperty({}, "kind", {
      enumerable: true,
      get() {
        invoked = true;
        return "present";
      },
    });
    expect(() =>
      parseHybridImportResolution({ ...input, body: unsafeBody }),
    ).toThrow("enumerable data field");
    expect(invoked).toBe(false);
  });

  test("rejects accessors and symbols without invoking them", () => {
    let invoked = false;
    const profile = Object.defineProperty({}, "version", {
      enumerable: true,
      get() {
        invoked = true;
        throw new Error("must not run");
      },
    });
    expect(() => parseHybridTypeScriptProfile(profile)).toThrow(
      "enumerable data field",
    );
    expect(invoked).toBe(false);
    const valid = createHybridTypeScriptProfile() as Record<
      PropertyKey,
      unknown
    >;
    valid[Symbol("hidden")] = true;
    expect(() => parseHybridTypeScriptProfile(valid)).toThrow("symbol fields");
  });
});
