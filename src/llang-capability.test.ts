import { afterEach, describe, expect, test } from "bun:test";
import {
  access,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  packageLlangCapability,
  checkLlangMutations,
  parseLlangRequest,
  parseLlangSuite,
  requestRevision,
  verifyLlangCapability,
} from "./llang-capability";
import {
  developLlangCapability,
  fixtureLlangAgent,
  replayLlangDevelopment,
} from "./llang-development";
import { migratePromptSource } from "./llang-migrate";
import { contentHash } from "./prompt-source";

const roots: string[] = [];
afterEach(async () => {
  while (roots.length)
    await rm(roots.pop() as string, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(resolve(tmpdir(), "llang-v2-"));
  roots.push(root);
  const source = resolve(
    process.cwd(),
    "examples/jsonc-enabled-user/enabled-user.llang.jsonc",
  );
  const contract = JSON.parse(
    (await readFile(source, "utf8"))
      .replace(/\/\/.*$/gm, "")
      .replace(/,\s*([}\]])/g, "$1"),
  ).contract;
  const request = parseLlangRequest({
    version: 2,
    id: "enabled-user",
    body: "enabledかつsuspendedでない利用者だけを許可する。",
    profile: "predicate-i32-v1",
    contract,
    requirements: [
      { id: "enabled", level: "must", text: "enabledであること" },
      {
        id: "not-suspended",
        level: "must-not",
        text: "suspendedを許可しないこと",
      },
    ],
  });
  const suite = parseLlangSuite(
    {
      version: 2,
      requestRevision: requestRevision(request),
      contractHash: contentHash(contract),
      cases: [
        {
          id: "accept",
          requirementIds: ["enabled", "not-suspended"],
          input: { enabled: true, suspended: false },
          undefinedFields: [],
          expected: { kind: "value", value: true },
        },
        {
          id: "disabled",
          requirementIds: ["enabled"],
          input: { enabled: false, suspended: false },
          undefinedFields: [],
          expected: { kind: "value", value: false },
        },
        {
          id: "suspended",
          requirementIds: ["not-suspended"],
          input: { enabled: true, suspended: true },
          undefinedFields: [],
          expected: { kind: "value", value: false },
        },
      ],
    },
    request,
  );
  const requestPath = resolve(root, "request.json"),
    suitePath = resolve(root, "tests.json"),
    metadataPath = resolve(root, "metadata.json");
  const metadata = {
    id: "enabled-user",
    release: "v2",
    purpose: "受付可否",
    useWhen: "利用者受付時",
    doNotUseWhen: "外部状態が必要な場合",
  };
  await writeFile(requestPath, JSON.stringify(request));
  await writeFile(suitePath, JSON.stringify(suite));
  await writeFile(metadataPath, JSON.stringify(metadata));
  return {
    root,
    source,
    request,
    suite,
    requestPath,
    suitePath,
    metadataPath,
    metadata,
  };
}

describe("L-Lang Capability v2", () => {
  test("packages raw JSONC without a lock and verifies after relocation", async () => {
    const f = await fixture();
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
    const f = await fixture();
    const altered = structuredClone(f.request);
    const first = altered.contract.fields[0];
    if (!first) throw new Error("fixture contract is empty");
    first.name = "renamed";
    expect(() => parseLlangSuite(f.suite, altered)).toThrow();
  });

  test("verification fails when an identified required requirement is uncovered", async () => {
    const f = await fixture();
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

  test("fixture repair passes and replay reproduces the hashes", async () => {
    const f = await fixture();
    const good = JSON.parse(
      (await readFile(f.source, "utf8"))
        .replace(/\/\/.*$/gm, "")
        .replace(/,\s*([}\]])/g, "$1"),
    );
    const bad = structuredClone(good);
    bad.body.conditions = [bad.body.conditions[0]];
    const reply = (program: unknown, id: string) => ({
      result: { outcome: "generated", program, diagnostics: [] },
      provider: "fixture",
      model: "fixture",
      responseId: id,
      usage: null,
    });
    const run = await developLlangCapability(
      f.request,
      f.suite,
      f.metadata,
      {
        version: 2,
        mode: "fixture",
        model: "fixture",
        maxCalls: 2,
        maxOutputTokens: 4096,
        maxTotalTokens: 100000,
        maxWallMs: 120000,
      },
      fixtureLlangAgent({
        version: 2,
        responses: [
          { stage: "implementation", reply: reply(bad, "one") },
          { stage: "repair", reply: reply(good, "two") },
        ],
      }),
      resolve(f.root, "run"),
    );
    expect(run.status).toBe("pass");
    const replay = await replayLlangDevelopment(
      resolve(f.root, "run"),
      resolve(f.root, "replay"),
    );
    expect(replay.status).toBe("pass");
  });

  test("invalid-input cases never kill semantic mutants", async () => {
    const f = await fixture();
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
    const f = await fixture();
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

  test("development records failed calls and replay reproduces the failure", async () => {
    const f = await fixture();
    const output = resolve(f.root, "failed-run");
    const run = await developLlangCapability(
      f.request,
      f.suite,
      f.metadata,
      {
        version: 2,
        mode: "fixture",
        model: "fixture",
        maxCalls: 2,
        maxOutputTokens: 4096,
        maxTotalTokens: 100000,
        maxWallMs: 120000,
      },
      async () => {
        throw new Error("fixture transport failed");
      },
      output,
    );
    expect(run).toMatchObject({
      status: "error",
      logicalCalls: 1,
      calls: [{ reply: null, error: "fixture transport failed" }],
    });
    expect(
      (await replayLlangDevelopment(output, resolve(f.root, "failed-replay")))
        .status,
    ).toBe("error");
    const changedSuite = { ...f.suite, cases: [...f.suite.cases].reverse() };
    await writeFile(
      resolve(output, "tests.json"),
      JSON.stringify(changedSuite),
    );
    await expect(
      replayLlangDevelopment(output, resolve(f.root, "tampered-replay")),
    ).rejects.toThrow("snapshot hash mismatch");
  });

  test("development validates metadata before creating its output", async () => {
    const f = await fixture();
    const output = resolve(f.root, "invalid-metadata");
    await expect(
      developLlangCapability(
        f.request,
        f.suite,
        { ...f.metadata, id: "other" },
        {
          version: 2,
          mode: "fixture",
          model: "fixture",
          maxCalls: 1,
          maxOutputTokens: 4096,
          maxTotalTokens: 100000,
          maxWallMs: 120000,
        },
        async () => {
          throw new Error("must not run");
        },
        output,
      ),
    ).rejects.toThrow("metadata id differs");
    await expect(access(output)).rejects.toThrow();
  });

  test("legacy migration requires a valid lock and emits source, request and tests", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "llang-migrate-"));
    roots.push(root);
    const output = resolve(root, "active.llang.jsonc");
    const result = await migratePromptSource(
      resolve(
        process.cwd(),
        "examples/prompt-active-customer/customer.prompt.json",
      ),
      output,
    );
    expect(await readFile(result.source, "utf8")).toContain(
      '"language": "l-lang"',
    );
    expect(JSON.parse(await readFile(result.request, "utf8")).version).toBe(2);
    await expect(
      migratePromptSource(
        resolve(
          process.cwd(),
          "examples/prompt-active-customer/customer.prompt.json",
        ),
        output,
      ),
    ).rejects.toThrow();
    await expect(
      migratePromptSource(
        resolve(
          process.cwd(),
          "examples/prompt-active-customer/customer.prompt.json",
        ),
        resolve(root, "wrong-extension.json"),
      ),
    ).rejects.toThrow("must use .llang.jsonc");
  });

  test("artifact reader rejects a symlinked manifest", async () => {
    const f = await fixture();
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
});
