import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import {
  cp,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { runCapabilityCli } from "./capability-cli";
import {
  inspectCapability,
  packageCapability,
  parseCapabilityManifest,
  parseCapabilityMetadata,
  readCapability,
  verifyCapability,
  writeCapabilityReport,
} from "./capability-package";
import { parseCapabilityReport } from "./capability-report";
import { parseCapabilitySuite, runCapabilityCases } from "./capability-tests";
import { resolvePromptSource } from "./prompt-resolution";
import { contentHash, createPromptSource } from "./prompt-source";
import { digest, WasmError } from "./wasm-contract";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((p) => rm(p, { recursive: true, force: true })),
  );
});
const field = (name: string) => ({
  name,
  kind: "boolean",
  values: [],
  optional: false,
  nullable: false,
  undefinable: false,
});
const source = {
  version: 1,
  kind: "predicate",
  id: "access",
  intent: "有効かつ停止中でない利用者だけ許可する。",
  requirements: [
    { id: "enabled", level: "must", text: "enabledがtrue" },
    {
      id: "suspension",
      level: "must-not",
      text: "suspendedがtrueなら許可しない",
    },
  ],
  unresolvedWhen: ["表現できない要求"],
  profile: "predicate-i32-v1",
  contract: { version: 1, fields: [field("enabled"), field("suspended")] },
  examples: [
    {
      id: "yes",
      input: { enabled: true, suspended: false },
      undefinedFields: [],
      expected: true,
    },
    {
      id: "no",
      input: { enabled: false, suspended: false },
      undefinedFields: [],
      expected: false,
    },
  ],
};
const metadata = {
  id: "access",
  release: "v1",
  purpose: "受付判定",
  useWhen: "利用者を受け付ける前",
  doNotUseWhen: "時刻や外部データが必要",
};
function suiteFor(revision: string) {
  return {
    version: 1,
    sourceRevision: revision,
    cases: [
      {
        id: "allowed",
        requirementIds: ["enabled", "suspension"],
        input: { enabled: true, suspended: false },
        undefinedFields: [],
        expected: { kind: "value", value: true },
      },
      {
        id: "blocked",
        requirementIds: ["suspension"],
        input: { enabled: true, suspended: true },
        undefinedFields: [],
        expected: { kind: "value", value: false },
      },
      {
        id: "invalid",
        requirementIds: ["enabled"],
        input: { enabled: "yes", suspended: false },
        undefinedFields: [],
        expected: { kind: "error", code: "INVALID_INPUT" },
      },
    ],
  };
}
async function fixture(wrong = false) {
  const root = await mkdtemp(resolve(tmpdir(), "capability-"));
  directories.push(root);
  const path = resolve(root, "access.json");
  const made = await createPromptSource(path, source);
  const enabled = { kind: "equals", property: ["enabled"], value: true };
  await resolvePromptSource(path, async () => ({
    provider: "fixture",
    model: "fixture",
    responseId: "one",
    usage: null,
    result: {
      outcome: "resolved",
      diagnostics: [],
      body: wrong
        ? enabled
        : {
            kind: "all",
            conditions: [
              enabled,
              { kind: "equals", property: ["suspended"], value: false },
            ],
          },
    },
  }));
  const tests = resolve(root, "tests.json");
  await writeFile(tests, JSON.stringify(suiteFor(made.revision)));
  const out = resolve(root, "candidate");
  const built = await packageCapability(path, tests, metadata, out);
  return { root, path, tests, out, built };
}

describe("capability candidate", () => {
  test("portable snapshot, actual Wasm verification and external immutable report", async () => {
    const f = await fixture();
    const report = await verifyCapability(f.built.manifest);
    expect(() => parseCapabilityReport({ ...report, passed: 99 })).toThrow();
    expect(() =>
      parseCapabilityReport({ ...report, acceptance: "pass" }),
    ).toThrow();
    expect(parseCapabilityReport(report)).toEqual(report);
    expect(report.status).toBe("pass");
    expect(report.passed).toBe(5);
    expect(report.acceptance).toBe("not-run");
    expect(report.apiCalls).toBe(0);
    expect(report.packageHash).toBe(f.built.packageHash);
    expect(report.requirements[1]?.caseIds).toContain("blocked");
    const moved = resolve(f.root, "moved");
    await cp(f.out, moved, { recursive: true });
    await rm(f.out, { recursive: true });
    await rm(f.path);
    await rm(`${f.path}.lock.json`);
    await rm(f.tests);
    const path = resolve(moved, "capability.json");
    expect((await verifyCapability(path)).packageHash).toBe(report.packageHash);
    expect((await inspectCapability(path)).verification).toBe("not-run");
    const reportPath = resolve(f.root, "report.json");
    await writeCapabilityReport(reportPath, report, path);
    expect(JSON.parse(await readFile(reportPath, "utf8"))).toEqual(report);
    await expect(
      writeCapabilityReport(reportPath, report, path),
    ).rejects.toThrow();
    await expect(
      writeCapabilityReport(resolve(moved, "report.json"), report, path),
    ).rejects.toThrow("outside");
  });
  test("additional tests detect a missing requirement and repaired candidate passes", async () => {
    const bad = await fixture(true);
    const good = await fixture();
    const report = await verifyCapability(bad.built.manifest);
    expect(report.status).toBe("fail");
    expect(report.failed).toBe(1);
    expect(report.results.find((r) => r.id === "blocked")?.actual).toEqual({
      kind: "value",
      value: true,
    });
    expect((await verifyCapability(good.built.manifest)).status).toBe("pass");
    expect(good.built.packageHash).not.toBe(bad.built.packageHash);
  });
  test("existing output is preserved and stale test suite rejected before writing", async () => {
    const f = await fixture();
    await expect(
      packageCapability(f.path, f.tests, metadata, f.out),
    ).rejects.toThrow();
    expect((await verifyCapability(f.built.manifest)).status).toBe("pass");
    const tests = JSON.parse(await readFile(f.tests, "utf8"));
    tests.sourceRevision = "0".repeat(64);
    await writeFile(f.tests, JSON.stringify(tests));
    await expect(
      packageCapability(f.path, f.tests, metadata, resolve(f.root, "new")),
    ).rejects.toThrow("revision");
  });
  test.each(["source", "lock", "build", "wasm", "tests"] as const)(
    "detects changed %s bytes",
    async (role) => {
      const f = await fixture();
      const m = (await readCapability(f.built.manifest)).manifest;
      await writeFile(resolve(f.out, m.files[role].path), "tampered");
      const report = await verifyCapability(f.built.manifest);
      expect(report.status).toBe("error");
      expect(report.diagnostics.join()).toContain("hash mismatch");
    },
  );
  test("rejects relinked build, unknown metadata, and symlinks", async () => {
    const f = await fixture();
    const { manifest } = await readCapability(f.built.manifest);
    const buildPath = resolve(f.out, manifest.files.build.path);
    const build = JSON.parse(await readFile(buildPath, "utf8"));
    build.provenance.sourceHash = "0".repeat(64);
    const raw = JSON.stringify(build);
    await writeFile(buildPath, raw);
    manifest.files.build.hash = digest(raw);
    await writeFile(f.built.manifest, JSON.stringify(manifest));
    expect(
      (await verifyCapability(f.built.manifest)).diagnostics.join(),
    ).toContain("linkage");
    await rm(buildPath);
    await symlink(f.tests, buildPath);
    expect((await verifyCapability(f.built.manifest)).status).toBe("error");
    expect(() =>
      parseCapabilityMetadata({ ...metadata, unknown: true }),
    ).toThrow();
    const escaping = structuredClone(manifest);
    escaping.files.source.path = "../access.json";
    expect(() => parseCapabilityManifest(escaping)).toThrow("path");
    const duplicate = structuredClone(manifest);
    duplicate.files.tests.path = duplicate.files.source.path;
    expect(() => parseCapabilityManifest(duplicate)).toThrow("duplicate");
    expect(() =>
      parseCapabilityManifest({ ...manifest, permissions: ["network"] }),
    ).toThrow();
    expect(() =>
      parseCapabilityManifest({ ...manifest, output: "string" }),
    ).toThrow();
  });
  test("suite validates requirement coverage, expectations and bounded cases", async () => {
    const f = await fixture();
    const snapshot = await readCapability(f.built.manifest);
    const original = suiteFor(contentHash(snapshot.source));
    const mutations = [
      (s: typeof original) => {
        s.cases = [];
      },
      (s: typeof original) => {
        (s.cases[1] as (typeof s.cases)[number]).id = "allowed";
      },
      (s: typeof original) => {
        (s.cases[0] as (typeof s.cases)[number]).requirementIds = ["unknown"];
      },
      (s: typeof original) => {
        for (const c of s.cases) c.requirementIds = ["suspension"];
      },
      (s: typeof original) => {
        (s.cases[0] as (typeof s.cases)[number]).expected.value = false;
      },
      (s: typeof original) => {
        (s.cases[2] as (typeof s.cases)[number]).input.enabled = true as never;
      },
      (s: typeof original) => {
        (s.cases[2] as (typeof s.cases)[number]).expected.code =
          "INVALID_ARTIFACT";
      },
      (s: typeof original) => {
        s.cases = Array(129).fill(s.cases[0]);
      },
    ];
    for (const mutate of mutations) {
      const s = structuredClone(original);
      mutate(s);
      expect(() => parseCapabilitySuite(s, snapshot.source)).toThrow();
    }
    const runtimeError = runCapabilityCases(
      snapshot.source,
      snapshot.suite,
      () => {
        throw new WasmError("INVALID_ARTIFACT", "trap");
      },
    );
    expect(runtimeError.every((r) => r.status === "error")).toBe(true);
    const unknownError = runCapabilityCases(
      snapshot.source,
      snapshot.suite,
      () => {
        throw new Error("trap");
      },
    );
    expect(unknownError[0]?.actual).toEqual({
      kind: "error",
      code: "EXECUTION_ERROR",
    });
  });
  test("CLI reports pass/fail/error and rejects invalid options", async () => {
    const f = await fixture();
    expect(
      (await runCapabilityCli(["inspect", f.built.manifest, "--json"]))
        .exitCode,
    ).toBe(0);
    expect(
      (
        await runCapabilityCli([
          "verify",
          f.built.manifest,
          "--report",
          resolve(f.root, "pass.json"),
        ])
      ).exitCode,
    ).toBe(0);
    for (const args of [
      [],
      ["unknown", "x"],
      ["verify", "x"],
      ["inspect", "x", "--json", "--json"],
      ["verify", "x", "--report"],
      ["inspect", "x", "--bad"],
    ])
      await expect(runCapabilityCli(args)).rejects.toThrow();
    const child = Bun.spawn(
      [
        process.execPath,
        "run",
        resolve(import.meta.dir, "capability-cli.ts"),
        "verify",
        f.built.manifest,
        "--report",
        resolve(f.root, "child.json"),
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const text = await new Response(child.stdout).text();
    expect(await child.exited).toBe(0);
    expect(JSON.parse(text).packageHash).toBe(f.built.packageHash);
    const bad = await fixture(true);
    expect(
      (
        await runCapabilityCli([
          "verify",
          bad.built.manifest,
          "--report",
          resolve(bad.root, "fail.json"),
        ])
      ).exitCode,
    ).toBe(1);
    await rm(resolve(f.out, "tests.json"));
    expect(
      (
        await runCapabilityCli([
          "verify",
          f.built.manifest,
          "--report",
          resolve(f.root, "error.json"),
        ])
      ).exitCode,
    ).toBe(2);
  });
});

test("runtime initialization errors are reported and unbounded Wasm is interrupted", async () => {
  const binaryen = (await import("binaryen")).default;
  const f = await fixture();
  async function replaceWasm(wat: string, bind: boolean) {
    const snapshot = await readCapability(f.built.manifest);
    const module = binaryen.parseText(wat);
    if (bind)
      module.addCustomSection(
        "llang.contract",
        new TextEncoder().encode(
          digest(JSON.stringify(snapshot.build.contract)),
        ),
      );
    const bytes = new Uint8Array(module.emitBinary());
    module.dispose();
    const hash = digest(bytes);
    const filename = `${hash}.wasm`;
    await writeFile(resolve(f.out, filename), bytes);
    snapshot.build.wasmHash = hash;
    snapshot.build.file = filename;
    const raw = JSON.stringify(snapshot.build);
    await writeFile(resolve(f.out, snapshot.manifest.files.build.path), raw);
    snapshot.manifest.files.build.hash = digest(raw);
    snapshot.manifest.files.wasm = { path: filename, hash };
    await writeFile(f.built.manifest, JSON.stringify(snapshot.manifest));
  }
  await replaceWasm(
    '(module (func (export "evaluate") (param i32 i32) (result i32) (i32.const 0)))',
    false,
  );
  const invalid = await verifyCapability(f.built.manifest);
  expect(invalid.status).toBe("error");
  expect(invalid.diagnostics.join()).toContain("ABI");
  await replaceWasm(
    '(module (func (export "evaluate") (param i32 i32) (result i32) (loop $forever (br $forever)) (i32.const 0)))',
    true,
  );
  const timeout = await verifyCapability(f.built.manifest);
  expect(timeout.status).toBe("error");
  expect(timeout.diagnostics.join()).toContain("EXECUTION_TIMEOUT");
}, 30_000);

test("offline verification does not resolve compiler or model dependencies", async () => {
  const f = await fixture();
  const runner = resolve(f.root, "offline.ts");
  const modulePath = resolve(import.meta.dir, "capability-cli.ts").replaceAll(
    "\\",
    "/",
  );
  await writeFile(
    runner,
    `import { plugin } from "bun";
plugin({ name: "offline", setup(b) { b.onResolve({ filter: /binaryen|wasm-emitter|typescript|openai|semantic-source|generator/ }, () => { throw new Error("forbidden offline dependency"); }); } });
const { runCapabilityCli } = await import(${JSON.stringify(modulePath)});
console.log(JSON.stringify(await runCapabilityCli(process.argv.slice(2))));`,
  );
  const p = Bun.spawn(
    [
      process.execPath,
      runner,
      "verify",
      f.built.manifest,
      "--report",
      resolve(f.root, "offline.json"),
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, OPENAI_API_KEY: "", AZURE_OPENAI_API_KEY: "" },
    },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
  expect(JSON.parse(stdout).result.status).toBe("pass");
});

test("packaging rejects concurrent source updates and cleans its partial output", async () => {
  const f = await fixture();
  const output = resolve(f.root, "racing");
  let changed = false;
  await expect(
    packageCapability(
      f.path,
      f.tests,
      metadata,
      output,
      async (path, data, options) => {
        await writeFile(path, data, options);
        if (!changed) {
          changed = true;
          const updated = JSON.parse(await readFile(f.path, "utf8"));
          updated.intent = "changed concurrently";
          await writeFile(f.path, JSON.stringify(updated));
        }
      },
    ),
  ).rejects.toThrow("input changed");
  await expect(readFile(resolve(output, "capability.json"))).rejects.toThrow();
  expect((await verifyCapability(f.built.manifest)).status).toBe("pass");
});

test("partial write failure does not publish a candidate", async () => {
  const f = await fixture();
  const output = resolve(f.root, "failed-write");
  await expect(
    packageCapability(f.path, f.tests, metadata, output, async () => {
      throw new Error("simulated write failure");
    }),
  ).rejects.toThrow("simulated");
  await expect(readFile(resolve(output, "capability.json"))).rejects.toThrow();
});

test("a report for another candidate cannot be attached as a current result", async () => {
  const a = await fixture();
  const b = await fixture(true);
  const report = await verifyCapability(a.built.manifest);
  await expect(
    writeCapabilityReport(
      resolve(b.root, "wrong-report.json"),
      report,
      b.built.manifest,
    ),
  ).rejects.toThrow("different candidate");
});

test("a candidate changed while its snapshot runs cannot receive a passing report", async () => {
  const f = await fixture();
  const NativeWorker = globalThis.Worker;
  globalThis.Worker = class extends NativeWorker {
    override postMessage(message: unknown) {
      const modified = JSON.parse(readFileSync(f.built.manifest, "utf8"));
      modified.metadata.release = "v2";
      writeFileSync(f.built.manifest, JSON.stringify(modified));
      super.postMessage(message);
    }
  };
  try {
    const report = await verifyCapability(f.built.manifest);
    expect(report.status).toBe("error");
    expect(report.diagnostics.join()).toContain("changed during verification");
  } finally {
    globalThis.Worker = NativeWorker;
  }
});
