import { afterEach, describe, expect, test } from "bun:test";
import {
  access,
  cp,
  mkdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { resolve } from "node:path";
import { packageLlangCapability } from "./llang-capability";
import {
  caseInput,
  parseLlangRequest,
  parseLlangSuite,
  readLlangCapability,
  requestRevision,
} from "./llang-capability-contracts";
import { inspectLlangCapability } from "./llang-capability-inspection";
import { executeLlangCli, runLlangCli } from "./llang-cli";
import { createLlangCapabilityFixture } from "./llang-test-fixture";
import { contentHash } from "./prompt-source";
import { evaluatePredicateExpression } from "./semantic-test-generator";
import { digest } from "./wasm-contract";
import { instantiateWasmPredicate } from "./wasm-runtime";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function loadProjection(source: string) {
  const javascript = `${new Bun.Transpiler({ loader: "ts" }).transformSync(source)}\n// ${crypto.randomUUID()}`;
  return (await import(
    `data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`
  )) as { evaluate(input: Record<string, unknown>): boolean };
}

async function packaged() {
  const fixture = await createLlangCapabilityFixture(roots);
  const directory = resolve(fixture.root, "package");
  const built = await packageLlangCapability(
    fixture.source,
    fixture.requestPath,
    fixture.suitePath,
    fixture.metadata,
    directory,
  );
  return { fixture, directory, manifest: built.manifest };
}

describe("L-Lang capability inspection", () => {
  test("reports the reader snapshot and deterministic TypeScript without executing it", async () => {
    const item = await packaged();
    const snapshot = await readLlangCapability(item.manifest);
    const report = await inspectLlangCapability(item.manifest);
    expect(report).toMatchObject({
      format: "llang-capability-inspection",
      version: 1,
      packageHash: snapshot.packageHash,
      request: {
        body: snapshot.request.body,
        requirements: snapshot.request.requirements,
      },
      artifacts: {
        sourceHash: snapshot.checked.sourceHash,
        programHash: snapshot.checked.programHash,
        artifactHash: snapshot.build.wasmHash,
      },
      inspection: {
        integrity: "checked",
        verification: "not-run",
        acceptance: "not-run",
        semanticEquivalence: "not-checked",
        apiCalls: 0,
      },
    });
    expect(report.typescript.projectionHash).toBe(
      digest(report.typescript.source),
    );
    expect(report.requirementCoverage.uncoveredRequirements).toEqual([]);
  });

  test("does not instantiate Wasm or start the suite worker", async () => {
    const item = await packaged();
    const nativeInstantiate = WebAssembly.instantiate;
    const NativeWorker = globalThis.Worker;
    let instantiateCalls = 0;
    let workerCalls = 0;
    class FailingWorker {
      constructor() {
        workerCalls++;
        throw new Error("inspection must not start a worker");
      }
    }
    try {
      WebAssembly.instantiate = ((..._args: unknown[]) => {
        instantiateCalls++;
        throw new Error("inspection must not instantiate Wasm");
      }) as typeof WebAssembly.instantiate;
      globalThis.Worker = FailingWorker as unknown as typeof Worker;
      await expect(
        inspectLlangCapability(item.manifest),
      ).resolves.toMatchObject({ inspection: { verification: "not-run" } });
      expect(instantiateCalls).toBe(0);
      expect(workerCalls).toBe(0);
    } finally {
      WebAssembly.instantiate = nativeInstantiate;
      globalThis.Worker = NativeWorker;
    }
  });

  test("is relocation-independent and publishes inspection.json last with matching content", async () => {
    const item = await packaged();
    const moved = resolve(item.fixture.root, "moved");
    await cp(item.directory, moved, { recursive: true });
    const first = await inspectLlangCapability(item.manifest);
    const output = resolve(item.fixture.root, "inspection");
    const second = await inspectLlangCapability(
      resolve(moved, "capability.json"),
      output,
    );
    expect(second).toEqual(first);
    expect(
      await readFile(resolve(output, "program.inspection.ts"), "utf8"),
    ).toBe(first.typescript.source);
    expect(
      JSON.parse(await readFile(resolve(output, "inspection.json"), "utf8")),
    ).toEqual(first);
  });

  test("matches the packaged IR expectations and Wasm, and detects a projection fault", async () => {
    const item = await packaged();
    const snapshot = await readLlangCapability(item.manifest);
    const report = await inspectLlangCapability(item.manifest);
    const projection = await loadProjection(report.typescript.source);
    const wasm = await instantiateWasmPredicate(snapshot.build, snapshot.bytes);
    for (const item of snapshot.suite.cases) {
      if (item.expected.kind !== "value") continue;
      const input = caseInput(item);
      expect(projection.evaluate(input), item.id).toBe(item.expected.value);
      expect(projection.evaluate(input), item.id).toBe(
        evaluatePredicateExpression(
          snapshot.checked.program.body,
          input as never,
        ),
      );
      expect(projection.evaluate(input), item.id).toBe(wasm.evaluate(input));
    }

    const faultySource = report.typescript.source.replace(
      'ownValue(input, "enabled") === true',
      'ownValue(input, "enabled") === false',
    );
    expect(faultySource).not.toBe(report.typescript.source);
    expect(digest(faultySource)).not.toBe(report.typescript.projectionHash);
    const faulty = await loadProjection(faultySource);
    expect(
      snapshot.suite.cases.some((item) => {
        if (item.expected.kind !== "value") return false;
        return faulty.evaluate(caseInput(item)) !== item.expected.value;
      }),
    ).toBe(true);
  });

  test("propagates tampering of every package role and leaves no successful output", async () => {
    for (const role of [
      "request",
      "source",
      "build",
      "wasm",
      "tests",
    ] as const) {
      const item = await packaged();
      const manifest = JSON.parse(await readFile(item.manifest, "utf8"));
      await writeFile(resolve(item.directory, manifest.files[role].path), "{}");
      const output = resolve(item.fixture.root, `tampered-${role}-inspection`);
      await expect(
        inspectLlangCapability(item.manifest, output),
      ).rejects.toThrow("hash mismatch");
      await expect(access(output)).rejects.toThrow();
    }
  });

  test("cleans partial output after a write failure", async () => {
    const item = await packaged();
    const failed = resolve(item.fixture.root, "failed-write");
    await expect(
      inspectLlangCapability(item.manifest, failed, async (path, value) => {
        await writeFile(path, value);
        throw new Error("injected inspection write failure");
      }),
    ).rejects.toThrow("injected inspection write failure");
    await expect(access(failed)).rejects.toThrow();
  });

  test("rejects a package change while publishing the final report", async () => {
    const item = await packaged(),
      output = resolve(item.fixture.root, "changed-during-report");
    let writes = 0;
    await expect(
      inspectLlangCapability(item.manifest, output, async (path, value) => {
        await writeFile(path, value);
        writes++;
        if (writes === 2) {
          const manifest = JSON.parse(await readFile(item.manifest, "utf8"));
          manifest.packageHash = "0".repeat(64);
          await writeFile(item.manifest, JSON.stringify(manifest));
        }
      }),
    ).rejects.toThrow();
    expect(writes).toBe(2);
    await expect(access(output)).rejects.toThrow();
  });

  test("rejects an output file change without a directory replacement", async () => {
    const item = await packaged(),
      output = resolve(item.fixture.root, "changed-output-file");
    let writes = 0;
    await expect(
      inspectLlangCapability(item.manifest, output, async (path, value) => {
        await writeFile(path, value);
        writes++;
        if (writes === 2)
          await writeFile(resolve(output, "program.inspection.ts"), "tampered");
      }),
    ).rejects.toThrow("output changed during publication");
    await expect(access(output)).rejects.toThrow();
  });

  test("does not delete a directory that replaces its owned output", async () => {
    const item = await packaged();
    const output = resolve(item.fixture.root, "replaced-output");
    const displaced = resolve(item.fixture.root, "displaced-output");
    const sentinel = resolve(output, "keep.txt");
    await expect(
      inspectLlangCapability(item.manifest, output, async (path) => {
        await rename(resolve(path, ".."), displaced);
        await mkdir(resolve(path, ".."));
        await writeFile(sentinel, "keep");
        throw new Error("injected output replacement");
      }),
    ).rejects.toThrow("injected output replacement");
    expect(await readFile(sentinel, "utf8")).toBe("keep");
    await access(displaced);
  });

  test("keeps unlinked cases and uncovered requirements visible without claiming success", async () => {
    const fixture = await createLlangCapabilityFixture(roots);
    const suite = {
      ...fixture.suite,
      cases: fixture.suite.cases.map((item, index) => ({
        ...item,
        requirementIds:
          index === 0
            ? []
            : item.requirementIds.filter((id) => id !== "not-suspended"),
      })),
    };
    await writeFile(fixture.suitePath, JSON.stringify(suite));
    const directory = resolve(fixture.root, "coverage-package");
    const built = await packageLlangCapability(
      fixture.source,
      fixture.requestPath,
      fixture.suitePath,
      fixture.metadata,
      directory,
    );
    const report = await inspectLlangCapability(built.manifest);
    expect(report.requirementCoverage.uncoveredRequirements).toEqual([
      "not-suspended",
    ]);
    expect(report.cases).toContainEqual({ id: "accept", requirementIds: [] });
    expect(report.inspection.verification).toBe("not-run");
  });

  test("keeps hostile-looking request text as report data and out of generated code", async () => {
    const fixture = await createLlangCapabilityFixture(roots);
    const hostile = '*/ export const injected = true; // "quoted"';
    const request = parseLlangRequest({
      ...fixture.request,
      body: hostile,
      requirements: fixture.request.requirements.map((item, index) => ({
        ...item,
        text: index === 0 ? hostile : item.text,
      })),
    });
    const suite = parseLlangSuite(
      {
        ...fixture.suite,
        requestRevision: requestRevision(request),
        contractHash: contentHash(request.contract),
      },
      request,
    );
    await writeFile(fixture.requestPath, JSON.stringify(request));
    await writeFile(fixture.suitePath, JSON.stringify(suite));
    const built = await packageLlangCapability(
      fixture.source,
      fixture.requestPath,
      fixture.suitePath,
      fixture.metadata,
      resolve(fixture.root, "hostile-text-package"),
    );
    const report = await inspectLlangCapability(built.manifest);
    expect(report.request.body).toBe(hostile);
    expect(report.request.requirements[0]?.text).toBe(hostile);
    expect(report.typescript.source).not.toContain("injected");
  });

  test("rejects package-contained, symlink-contained, and existing outputs without damage", async () => {
    const item = await packaged();
    await expect(
      inspectLlangCapability(
        item.manifest,
        resolve(item.directory, "inspection"),
      ),
    ).rejects.toThrow("outside the capability package");

    const packageLink = resolve(item.fixture.root, "package-link");
    await symlink(item.directory, packageLink);
    await expect(
      inspectLlangCapability(item.manifest, resolve(packageLink, "inspection")),
    ).rejects.toThrow("symbolic link");

    const externalParent = resolve(item.fixture.root, "external-parent");
    await mkdir(externalParent);
    const externalLink = resolve(item.fixture.root, "external-link");
    await symlink(externalParent, externalLink);
    await expect(
      inspectLlangCapability(
        item.manifest,
        resolve(externalLink, "inspection"),
      ),
    ).rejects.toThrow("symbolic link");

    const existing = resolve(item.fixture.root, "existing");
    await mkdir(existing);
    const sentinel = resolve(existing, "keep.txt");
    await writeFile(sentinel, "keep");
    await expect(
      inspectLlangCapability(item.manifest, existing),
    ).rejects.toThrow();
    expect(await readFile(sentinel, "utf8")).toBe("keep");
  });

  test("exposes JSON-only and file-output CLI forms and rejects misuse", async () => {
    const item = await packaged();
    expect(await runLlangCli(["inspect", item.manifest])).toMatchObject({
      exitCode: 0,
      output: { inspection: { apiCalls: 0 } },
    });
    const output = resolve(item.fixture.root, "cli-inspection");
    expect(
      await runLlangCli(["inspect", item.manifest, "--out-dir", output]),
    ).toMatchObject({ exitCode: 0 });
    await expect(
      runLlangCli(["inspect", item.manifest, "--bad", output]),
    ).rejects.toThrow("usage: llang");
    expect(
      await executeLlangCli([
        "inspect",
        item.manifest,
        "--bad",
        output,
        "--json",
      ]),
    ).toMatchObject({
      exitCode: 2,
      output: { ok: false, error: { code: "INVALID_ARGUMENT" } },
    });
  });

  test("rejects an unsupported package profile at the CLI boundary", async () => {
    const item = await packaged();
    const manifest = JSON.parse(await readFile(item.manifest, "utf8"));
    manifest.profile = "module-effects-v1";
    await writeFile(item.manifest, JSON.stringify(manifest));
    const output = resolve(item.fixture.root, "unsupported-profile-output");
    expect(
      await executeLlangCli([
        "inspect",
        item.manifest,
        "--out-dir",
        output,
        "--json",
      ]),
    ).toMatchObject({
      exitCode: 2,
      output: { ok: false, error: { code: "INVALID_CAPABILITY" } },
    });
    await expect(access(output)).rejects.toThrow();
  });
});
