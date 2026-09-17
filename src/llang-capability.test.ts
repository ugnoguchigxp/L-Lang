import { afterEach, describe, expect, test } from "bun:test";
import {
  access,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { resolve } from "node:path";
import {
  checkLlangMutations,
  packageLlangCapability,
  parseLlangRequest,
  parseLlangSuite,
  requestRevision,
  verifyLlangCapability,
} from "./llang-capability";
import { createLlangCapabilityFixture } from "./llang-test-fixture";
import { contentHash } from "./prompt-source";

const roots: string[] = [];
afterEach(async () => {
  while (roots.length)
    await rm(roots.pop() as string, { recursive: true, force: true });
});

describe("L-Lang Capability v2", () => {
  test("packages raw JSONC without a lock and verifies after relocation", async () => {
    const f = await createLlangCapabilityFixture(roots);
    const built = await packageLlangCapability(
      f.source,
      f.requestPath,
      f.suitePath,
      f.metadata,
      resolve(f.root, "candidate"),
    );
    expect((await verifyLlangCapability(built.manifest)).status).toBe("pass");
    const manifest = JSON.parse(await readFile(built.manifest, "utf8"));
    expect(manifest.files.lock).toBeUndefined();
    expect(
      await readFile(
        resolve(f.root, "candidate", manifest.files.source.path),
        "utf8",
      ),
    ).toContain("// 停止されている");
    await writeFile(
      resolve(f.root, "candidate", manifest.files.tests.path),
      "{}",
      "utf8",
    );
    expect((await verifyLlangCapability(built.manifest)).status).toBe("error");
  });

  test("fixed contract cannot be changed to evade the suite", async () => {
    const f = await createLlangCapabilityFixture(roots);
    const altered = structuredClone(f.request);
    const first = altered.contract.fields[0];
    if (!first) throw new Error("fixture contract is empty");
    first.name = "renamed";
    expect(() => parseLlangSuite(f.suite, altered)).toThrow();
  });

  test("verification fails when an identified required requirement is uncovered", async () => {
    const f = await createLlangCapabilityFixture(roots);
    const suite = {
      ...f.suite,
      cases: f.suite.cases.map((item) => ({
        ...item,
        requirementIds: item.requirementIds.filter(
          (id) => id !== "not-suspended",
        ),
      })),
    };
    await writeFile(f.suitePath, JSON.stringify(suite));
    const built = await packageLlangCapability(
      f.source,
      f.requestPath,
      f.suitePath,
      f.metadata,
      resolve(f.root, "uncovered-candidate"),
    );
    expect(await verifyLlangCapability(built.manifest)).toMatchObject({
      status: "fail",
      coverage: "evaluated",
      uncoveredRequirements: ["not-suspended"],
    });
  });

  test("suite accepts every legal contract field name in undefinedFields", () => {
    const request = parseLlangRequest({
      version: 2,
      id: "special-field",
      body: "$flag の存在を判定する。",
      profile: "predicate-i32-v1",
      contract: {
        version: 1,
        fields: [
          {
            name: "$flag",
            kind: "boolean",
            values: [],
            nullable: false,
            undefinable: true,
            optional: false,
          },
        ],
      },
      requirements: [],
    });
    expect(
      parseLlangSuite(
        {
          version: 2,
          requestRevision: requestRevision(request),
          contractHash: contentHash(request.contract),
          cases: [
            {
              id: "present",
              requirementIds: [],
              input: { $flag: true },
              undefinedFields: [],
              expected: { kind: "value", value: true },
            },
            {
              id: "undefined",
              requirementIds: [],
              input: {},
              undefinedFields: ["$flag"],
              expected: { kind: "value", value: false },
            },
          ],
        },
        request,
      ).cases,
    ).toHaveLength(2);
    expect(() =>
      parseLlangSuite(
        {
          version: 2,
          requestRevision: requestRevision(request),
          contractHash: contentHash(request.contract),
          cases: [
            {
              id: "direct-undefined",
              requirementIds: [],
              input: { $flag: undefined },
              undefinedFields: [],
              expected: { kind: "value", value: false },
            },
            {
              id: "present",
              requirementIds: [],
              input: { $flag: true },
              undefinedFields: [],
              expected: { kind: "value", value: true },
            },
          ],
        },
        request,
      ),
    ).toThrow("use undefinedFields");
  });

  test("invalid-input cases never kill semantic mutants", async () => {
    const f = await createLlangCapabilityFixture(roots);
    const suite = {
      ...f.suite,
      cases: [
        ...f.suite.cases,
        {
          id: "invalid",
          requirementIds: [],
          input: { enabled: true },
          undefinedFields: [],
          expected: { kind: "error" as const, code: "INVALID_INPUT" as const },
        },
      ],
    };
    await writeFile(f.suitePath, JSON.stringify(suite));
    const report = await checkLlangMutations(
      f.source,
      f.requestPath,
      f.suitePath,
    );
    expect(
      report.mutations.every((item) => !item.killedBy.includes("invalid")),
    ).toBe(true);
  });

  test("mutation check does not report equivalent duplicate removal as survived", async () => {
    const f = await createLlangCapabilityFixture(roots);
    const program = JSON.parse(
      (await readFile(f.source, "utf8"))
        .replace(/\/\/.*$/gm, "")
        .replace(/,\s*([}\]])/g, "$1"),
    );
    program.body.conditions.splice(
      1,
      0,
      structuredClone(program.body.conditions[0]),
    );
    const source = resolve(f.root, "duplicate.llang.jsonc");
    await writeFile(source, JSON.stringify(program));
    const report = await checkLlangMutations(
      source,
      f.requestPath,
      f.suitePath,
    );
    expect(report.mutations.some((item) => item.status === "equivalent")).toBe(
      true,
    );
    expect(
      report.mutations.some(
        (item) => item.relation === "equivalent" && item.status === "survived",
      ),
    ).toBe(false);
  });

  test("artifact reader rejects a symlinked manifest", async () => {
    const f = await createLlangCapabilityFixture(roots);
    const built = await packageLlangCapability(
      f.source,
      f.requestPath,
      f.suitePath,
      f.metadata,
      resolve(f.root, "symlink-candidate"),
    );
    const linked = resolve(f.root, "manifest-link.json");
    await symlink(
      resolve(f.root, "symlink-candidate", "manifest.json"),
      linked,
    );
    const { readLlangArtifact } = await import("./llang-build");
    await expect(readLlangArtifact(linked)).rejects.toThrow("non-symlink");
    expect(built.manifest).toContain("capability.json");
  });

  test("verification rejects tampering of every packaged role", async () => {
    const f = await createLlangCapabilityFixture(roots);
    for (const role of [
      "request",
      "source",
      "build",
      "wasm",
      "tests",
    ] as const) {
      const directory = resolve(f.root, `tamper-${role}`);
      const built = await packageLlangCapability(
        f.source,
        f.requestPath,
        f.suitePath,
        f.metadata,
        directory,
      );
      const manifest = JSON.parse(await readFile(built.manifest, "utf8"));
      const target = resolve(directory, manifest.files[role].path);
      const bytes = new Uint8Array(await readFile(target));
      const changed = new Uint8Array(bytes.length + 1);
      changed.set(bytes);
      changed[changed.length - 1] = 0x20;
      await writeFile(target, changed);
      expect((await verifyLlangCapability(built.manifest)).status, role).toBe(
        "error",
      );
    }
  });

  test("verification rejects manifest path relinking and internal symlinks", async () => {
    const f = await createLlangCapabilityFixture(roots);
    const relinked = await packageLlangCapability(
      f.source,
      f.requestPath,
      f.suitePath,
      f.metadata,
      resolve(f.root, "relinked"),
    );
    const manifest = JSON.parse(await readFile(relinked.manifest, "utf8"));
    manifest.files.request.path = "../request.json";
    await writeFile(relinked.manifest, JSON.stringify(manifest));
    expect((await verifyLlangCapability(relinked.manifest)).status).toBe(
      "error",
    );

    const linked = await packageLlangCapability(
      f.source,
      f.requestPath,
      f.suitePath,
      f.metadata,
      resolve(f.root, "internal-link"),
    );
    const linkedManifest = JSON.parse(await readFile(linked.manifest, "utf8"));
    const request = resolve(
      f.root,
      "internal-link",
      linkedManifest.files.request.path,
    );
    await rm(request);
    await symlink(f.requestPath, request);
    expect((await verifyLlangCapability(linked.manifest)).status).toBe("error");
  });

  test("verification reports worker errors and terminates silent workers", async () => {
    const f = await createLlangCapabilityFixture(roots);
    const built = await packageLlangCapability(
      f.source,
      f.requestPath,
      f.suitePath,
      f.metadata,
      resolve(f.root, "worker-failures"),
    );
    const NativeWorker = globalThis.Worker;
    let terminated = 0;
    class FakeWorker {
      onerror: ((event: { message: string }) => void) | null = null;
      onmessage: ((event: { data: unknown }) => void) | null = null;
      terminate() {
        terminated++;
      }
      postMessage() {
        queueMicrotask(() => this.onerror?.({ message: "worker failed" }));
      }
    }
    try {
      globalThis.Worker = FakeWorker as unknown as typeof Worker;
      expect(await verifyLlangCapability(built.manifest)).toMatchObject({
        status: "error",
        diagnostics: ["worker failed"],
      });

      FakeWorker.prototype.postMessage = () => {};
      const timeout = await verifyLlangCapability(built.manifest);
      expect(timeout.status).toBe("error");
      expect(timeout.diagnostics[0]).toContain("exceeded 10 seconds");
      expect(terminated).toBe(2);
    } finally {
      globalThis.Worker = NativeWorker;
    }
  }, 15_000);

  test("packaging preserves existing output and creates nothing for invalid metadata", async () => {
    const f = await createLlangCapabilityFixture(roots);
    const existing = resolve(f.root, "existing");
    await mkdir(existing);
    const sentinel = resolve(existing, "keep.txt");
    await writeFile(sentinel, "keep");
    await expect(
      packageLlangCapability(
        f.source,
        f.requestPath,
        f.suitePath,
        f.metadata,
        existing,
      ),
    ).rejects.toThrow();
    expect(await readFile(sentinel, "utf8")).toBe("keep");

    const absent = resolve(f.root, "invalid-metadata-package");
    await expect(
      packageLlangCapability(
        f.source,
        f.requestPath,
        f.suitePath,
        { ...f.metadata, id: "other" },
        absent,
      ),
    ).rejects.toThrow("metadata/request/source mismatch");
    await expect(access(absent)).rejects.toThrow();
  });

  test("packaging cleans partial writes and rejects changed fixed inputs", async () => {
    const f = await createLlangCapabilityFixture(roots);
    const failed = resolve(f.root, "partial-write");
    let writes = 0;
    await expect(
      packageLlangCapability(
        f.source,
        f.requestPath,
        f.suitePath,
        f.metadata,
        failed,
        async (path, data, options) => {
          writes++;
          if (writes === 2) throw new Error("injected package write failure");
          await writeFile(path, data, options);
        },
      ),
    ).rejects.toThrow("injected package write failure");
    await expect(access(failed)).rejects.toThrow();

    const racing = resolve(f.root, "changed-input");
    let changed = false;
    await expect(
      packageLlangCapability(
        f.source,
        f.requestPath,
        f.suitePath,
        f.metadata,
        racing,
        async (path, data, options) => {
          await writeFile(path, data, options);
          if (!changed) {
            changed = true;
            const suite = JSON.parse(await readFile(f.suitePath, "utf8"));
            suite.cases.reverse();
            await writeFile(f.suitePath, JSON.stringify(suite));
          }
        },
      ),
    ).rejects.toThrow("input changed during packaging");
    await expect(access(racing)).rejects.toThrow();
  });
});
