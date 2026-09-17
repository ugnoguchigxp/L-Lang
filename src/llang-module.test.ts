import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdtemp,
  mkdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import binaryen from "binaryen";
import {
  loadModuleProgram,
  revalidateModuleSnapshot,
} from "./llang-module-loader";
import { evaluateModuleProgram } from "./llang-module-evaluator";
import { emitModuleWasm } from "./llang-module-wasm";
import { instantiateWasmPredicate } from "./wasm-runtime";
import { digest } from "./wasm-contract";
import { buildModuleProgram } from "./llang-module-build";
import {
  emitModuleJsonc,
  emitModuleTypeScript,
} from "./llang-module-source-emitter";
import { parseModuleSuite, verifyModuleBundle } from "./llang-module-suite";
import { executeLlangCli } from "./llang-cli";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
const user = {
  language: "l-lang",
  version: 2,
  kind: "module",
  profile: "module-bool-v1",
  imports: [],
  types: [
    {
      name: "User",
      export: true,
      kind: "record",
      fields: [
        { name: "enabled", type: "boolean" },
        { name: "suspended", type: "boolean" },
      ],
    },
  ],
  functions: [
    {
      name: "isEnabled",
      export: true,
      parameters: [{ name: "user", type: { ref: "User" } }],
      returns: "boolean",
      body: {
        kind: "field",
        base: { kind: "param", name: "user" },
        name: "enabled",
      },
    },
  ],
};
function policy(userPath: string) {
  return {
    language: "l-lang",
    version: 2,
    kind: "module",
    profile: "module-bool-v1",
    imports: [
      {
        from: userPath,
        bindings: [
          { kind: "type", name: "User", as: "User" },
          { kind: "function", name: "isEnabled", as: "isEnabled" },
        ],
      },
    ],
    types: [],
    functions: [
      {
        name: "both",
        export: false,
        parameters: [
          { name: "left", type: "boolean" },
          { name: "right", type: "boolean" },
        ],
        returns: "boolean",
        body: {
          kind: "all",
          conditions: [
            { kind: "param", name: "left" },
            { kind: "param", name: "right" },
          ],
        },
      },
      {
        name: "isAllowed",
        export: true,
        parameters: [{ name: "user", type: { ref: "User" } }],
        returns: "boolean",
        body: {
          kind: "call",
          callee: "both",
          arguments: [
            {
              kind: "call",
              callee: "isEnabled",
              arguments: [{ kind: "param", name: "user" }],
            },
            {
              kind: "not",
              condition: {
                kind: "field",
                base: { kind: "param", name: "user" },
                name: "suspended",
              },
            },
          ],
        },
      },
    ],
  };
}
function main(policyPath: string, userPath: string) {
  return {
    language: "l-lang",
    version: 2,
    kind: "module",
    profile: "module-bool-v1",
    imports: [
      {
        from: policyPath,
        bindings: [{ kind: "function", name: "isAllowed", as: "isAllowed" }],
      },
      {
        from: userPath,
        bindings: [{ kind: "type", name: "User", as: "User" }],
      },
    ],
    types: [],
    functions: [
      {
        name: "canAccess",
        export: true,
        parameters: [{ name: "user", type: { ref: "User" } }],
        returns: "boolean",
        body: {
          kind: "call",
          callee: "isAllowed",
          arguments: [{ kind: "param", name: "user" }],
        },
      },
    ],
  };
}
async function fixture(kind: "jsonc" | "ts" | "mixed") {
  const root = await mkdtemp(join(tmpdir(), "llang-module-"));
  roots.push(root);
  await mkdir(join(root, "domain"));
  await mkdir(join(root, "policy"));
  await mkdir(join(root, "application"));
  const json = async (path: string, value: unknown) =>
    writeFile(join(root, path), JSON.stringify(value, null, 2));
  const ts = async (path: string, value: string) =>
    writeFile(join(root, path), value);
  if (kind === "jsonc") {
    await json("domain/user.llang.jsonc", user);
    await json(
      "policy/access.llang.jsonc",
      policy("../domain/user.llang.jsonc"),
    );
    await json(
      "application/main.llang.jsonc",
      main("../policy/access.llang.jsonc", "../domain/user.llang.jsonc"),
    );
    return { root, entry: "application/main.llang.jsonc" };
  }
  await ts(
    "domain/user.ts",
    `export type User = { enabled: boolean; suspended: boolean };\nexport function isEnabled(user: User): boolean { return user.enabled; }\n`,
  );
  if (kind === "ts") {
    await ts(
      "policy/access.ts",
      `import type { User } from "../domain/user.ts";\nimport { isEnabled } from "../domain/user.ts";\nfunction both(left: boolean, right: boolean): boolean { return left && right; }\nexport function isAllowed(user: User): boolean { return both(isEnabled(user), !user.suspended); }\n`,
    );
    await ts(
      "application/main.ts",
      `import type { User } from "../domain/user.ts";\nimport { isAllowed } from "../policy/access.ts";\nexport function canAccess(user: User): boolean { return isAllowed(user); }\n`,
    );
    return { root, entry: "application/main.ts" };
  }
  await json("policy/access.llang.jsonc", policy("../domain/user.ts"));
  await ts(
    "application/main.ts",
    `import type { User } from "../domain/user.ts";\nimport { isAllowed } from "../policy/access.llang.jsonc";\nexport function canAccess(user: User): boolean { return isAllowed(user); }\n`,
  );
  return { root, entry: "application/main.ts" };
}

describe("L-Lang typed modules", () => {
  test("all-TS, all-JSONC and mixed graphs share semantics and Wasm bytes", async () => {
    const programs = [];
    for (const kind of ["jsonc", "ts", "mixed"] as const) {
      const f = await fixture(kind);
      programs.push(await loadModuleProgram(f.entry, f.root, "canAccess"));
    }
    expect(new Set(programs.map((p) => p.programHash)).size).toBe(1);
    expect(new Set(programs.map((p) => p.interfaceHash)).size).toBe(1);
    expect(
      new Set(
        programs.map((program) =>
          JSON.stringify([...emitModuleJsonc(program).entries()]),
        ),
      ).size,
    ).toBe(1);
    const table = [
      [false, false, false],
      [false, true, false],
      [true, false, true],
      [true, true, false],
    ] as const;
    for (const program of programs)
      for (const [enabled, suspended, expected] of table)
        expect(evaluateModuleProgram(program, { enabled, suspended })).toBe(
          expected,
        );
    const firstProgram = programs[0];
    if (!firstProgram) throw new Error("missing checked program");
    const emitted = programs.map(emitModuleWasm);
    expect(new Set(emitted.map((x) => digest(x.bytes))).size).toBe(1);
    const first = emitted[0];
    if (!first) throw new Error("missing emitted Wasm");
    const runtime = await instantiateWasmPredicate(
      {
        export: "evaluate",
        contract: first.contract,
        wasmHash: digest(first.bytes),
      },
      first.bytes,
    );
    expect(runtime.evaluate({ enabled: true, suspended: false })).toBe(true);
    expect(() =>
      runtime.evaluate({ enabled: true, suspended: false, extra: true }),
    ).toThrow("INVALID_INPUT");
    const generatedPath = join(roots[0] as string, "generated.ts");
    await writeFile(generatedPath, emitModuleTypeScript(firstProgram));
    const generated = (await import(
      `${pathToFileURL(generatedPath).href}?review=${Date.now()}`
    )) as { evaluate(input: unknown): boolean };
    const accessor = { suspended: false } as Record<string, unknown>;
    Object.defineProperty(accessor, "enabled", {
      enumerable: true,
      get: () => {
        throw new Error("getter must not run");
      },
    });
    expect(() => generated.evaluate(accessor)).toThrow("INVALID_INPUT");
    const symbolInput = { enabled: true, suspended: false };
    Object.defineProperty(symbolInput, Symbol("hidden"), { value: true });
    expect(() => generated.evaluate(symbolInput)).toThrow("INVALID_INPUT");
  });
  test("builds all targets and verifies a moved source-independent Wasm bundle", async () => {
    const f = await fixture("mixed"),
      program = await loadModuleProgram(f.entry, f.root, "canAccess"),
      out = join(f.root, "bundle");
    const manifest = await buildModuleProgram({
      entry: f.entry,
      root: f.root,
      entryName: "canAccess",
      target: "all",
      outDir: out,
    });
    expect(manifest.targets).toEqual(["typescript", "jsonc", "wasm"]);
    const suite = join(f.root, "suite.json");
    await writeFile(
      suite,
      JSON.stringify({
        format: "llang-module-suite",
        version: 1,
        interfaceHash: program.interfaceHash,
        cases: [
          {
            id: "allow",
            input: { enabled: true, suspended: false },
            expected: true,
          },
          {
            id: "deny",
            input: { enabled: true, suspended: true },
            expected: false,
          },
          {
            id: "invalid",
            input: { enabled: true },
            expected: "INVALID_INPUT",
          },
        ],
      }),
    );
    const report = await verifyModuleBundle(
      join(out, "module-build.json"),
      suite,
    );
    expect(report.ok).toBe(true);
    if (!manifest.wasm) throw new Error("missing Wasm manifest entry");
    const wasmPath = join(out, "wasm/program.wasm"),
      manifestPath = join(out, "module-build.json"),
      escapedWasm = join(f.root, "escaped.wasm");
    const originalWasm = await readFile(wasmPath),
      originalManifest = await readFile(manifestPath, "utf8"),
      hostileModule = new binaryen.Module();
    let hostileWasm: Uint8Array;
    try {
      hostileModule.setFeatures(binaryen.Features.MVP);
      const body = hostileModule.block(
        null,
        [
          hostileModule.loop("spin", hostileModule.br("spin")),
          hostileModule.i32.const(0),
        ],
        binaryen.i32,
      );
      hostileModule.addFunction(
        "evaluate",
        binaryen.createType([binaryen.i32, binaryen.i32]),
        binaryen.i32,
        [],
        body,
      );
      hostileModule.addFunctionExport("evaluate", "evaluate");
      hostileModule.addCustomSection(
        "llang.contract",
        new TextEncoder().encode(
          digest(JSON.stringify(manifest.wasm.contract)),
        ),
      );
      expect(hostileModule.validate()).toBe(1);
      hostileWasm = new Uint8Array(hostileModule.emitBinary());
    } finally {
      hostileModule.dispose();
    }
    const hostileHash = digest(hostileWasm),
      hostileManifest = JSON.parse(originalManifest) as typeof manifest,
      hostileArtifact = hostileManifest.artifacts.find(
        (artifact) => artifact.path === "wasm/program.wasm",
      );
    if (!hostileManifest.wasm || !hostileArtifact)
      throw new Error("missing Wasm manifest entry");
    hostileManifest.wasm.wasmHash = hostileHash;
    hostileArtifact.hash = hostileHash;
    hostileArtifact.bytes = hostileWasm.byteLength;
    await writeFile(wasmPath, hostileWasm);
    await writeFile(
      manifestPath,
      `${JSON.stringify(hostileManifest, null, 2)}\n`,
    );
    await expect(verifyModuleBundle(manifestPath, suite)).rejects.toThrow(
      "timed out",
    );
    await writeFile(wasmPath, originalWasm);
    await writeFile(manifestPath, originalManifest);
    await writeFile(escapedWasm, await readFile(wasmPath));
    await rm(wasmPath);
    await symlink(escapedWasm, wasmPath);
    await expect(verifyModuleBundle(manifestPath, suite)).rejects.toThrow();
    const cli = await executeLlangCli([
      "module",
      "lint",
      f.entry,
      "--root",
      f.root,
      "--entry",
      "canAccess",
      "--json",
    ]);
    expect(cli.exitCode).toBe(0);
  });
  test("rejects module cycles, recursion and unsupported TypeScript", async () => {
    const f = await fixture("jsonc");
    await writeFile(
      join(f.root, "domain/user.llang.jsonc"),
      JSON.stringify({
        ...user,
        imports: [{ from: "../application/main.llang.jsonc", bindings: [] }],
      }),
    );
    await expect(
      loadModuleProgram(f.entry, f.root, "canAccess"),
    ).rejects.toThrow("module cycle");
    const bad = await fixture("ts");
    await writeFile(
      join(bad.root, "domain/user.ts"),
      "export const sideEffect = true;",
    );
    await expect(
      loadModuleProgram(bad.entry, bad.root, "canAccess"),
    ).rejects.toThrow("unsupported top-level");
  });

  test("enforces longest call depth even when a shared callee was visited first", async () => {
    const root = await mkdtemp(join(tmpdir(), "llang-module-depth-"));
    roots.push(root);
    const chain = (prefix: string, count: number, tail?: string) =>
      Array.from({ length: count }, (_, index) => {
        const name = `${prefix}${String(index).padStart(2, "0")}`;
        const next =
          index + 1 < count
            ? `${prefix}${String(index + 1).padStart(2, "0")}`
            : tail;
        return `function ${name}(value: boolean): boolean { return ${next ? `${next}(value)` : "value"}; }`;
      }).join("\n");
    await writeFile(
      join(root, "main.ts"),
      `export type User = { enabled: boolean };\n${chain("a", 20)}\n${chain("z", 15, "a00")}\nexport function canAccess(user: User): boolean { return z00(user.enabled); }\n`,
    );
    await expect(
      loadModuleProgram("main.ts", root, "canAccess"),
    ).rejects.toThrow("call depth exceeds limit");
  });

  test("revalidates path identity and strictly parses suite cases", async () => {
    const f = await fixture("jsonc"),
      program = await loadModuleProgram(f.entry, f.root, "canAccess"),
      domain = join(f.root, "domain"),
      moved = join(f.root, "domain-real");
    await rename(domain, moved);
    await symlink(moved, domain);
    await expect(revalidateModuleSnapshot(program)).rejects.toThrow(
      "SOURCE_CONFLICT",
    );
    expect(() =>
      parseModuleSuite({
        format: "llang-module-suite",
        version: 1,
        interfaceHash: "0".repeat(64),
        cases: [{ id: "case", input: {}, expected: true, extra: true }],
      }),
    ).toThrow("invalid module suite cases");
  });
});
