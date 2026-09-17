import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  parseLlangRequest,
  parseLlangSuite,
  requestRevision,
} from "./llang-capability";
import { runLlangCli } from "./llang-cli";
import { LLANG_SOURCE_BYTES } from "./llang-jsonc";
import { contentHash } from "./prompt-source";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function cliFixture() {
  const root = await mkdtemp(resolve(tmpdir(), "llang-cli-all-"));
  roots.push(root);
  const source = resolve(root, "enabled-user.llang.jsonc");
  const program = JSON.parse(
    (
      await readFile(
        resolve(
          process.cwd(),
          "examples/jsonc-enabled-user/enabled-user.llang.jsonc",
        ),
        "utf8",
      )
    )
      .replace(/\/\/.*$/gm, "")
      .replace(/,\s*([}\]])/g, "$1"),
  );
  await writeFile(source, JSON.stringify(program, null, 2));
  const request = parseLlangRequest({
    version: 2,
    id: program.id,
    body: "enabledかつsuspendedでない利用者だけを許可する。",
    profile: "predicate-i32-v1",
    contract: program.contract,
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
      contractHash: contentHash(request.contract),
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
  const metadata = {
    id: program.id,
    release: "v2",
    purpose: "受付可否",
    useWhen: "利用者受付時",
    doNotUseWhen: "外部状態が必要な場合",
  };
  const paths = {
    root,
    source,
    request: resolve(root, "request.json"),
    suite: resolve(root, "tests.json"),
    metadata: resolve(root, "metadata.json"),
    fixture: resolve(root, "agent-fixture.json"),
  };
  await writeFile(paths.request, JSON.stringify(request));
  await writeFile(paths.suite, JSON.stringify(suite));
  await writeFile(paths.metadata, JSON.stringify(metadata));
  await writeFile(
    paths.fixture,
    JSON.stringify({
      version: 2,
      responses: [
        {
          stage: "implementation",
          reply: {
            result: { outcome: "generated", program, diagnostics: [] },
            provider: "fixture",
            model: "fixture",
            responseId: "cli-pass",
            usage: null,
          },
        },
      ],
    }),
  );
  return { paths, program, request, suite, metadata };
}

describe("L-Lang CLI complete command matrix", () => {
  test("runs test, mutation, package and verify with stable exit codes", async () => {
    const f = await cliFixture();
    const tested = await runLlangCli([
      "test",
      f.paths.source,
      "--request",
      f.paths.request,
      "--suite",
      f.paths.suite,
    ]);
    expect(tested).toMatchObject({ exitCode: 0, output: { ok: true } });

    const mutation = await runLlangCli([
      "mutation-check",
      f.paths.source,
      "--request",
      f.paths.request,
      "--suite",
      f.paths.suite,
    ]);
    expect([0, 1]).toContain(mutation.exitCode);
    expect(mutation.output).toMatchObject({ version: 2 });

    const candidate = resolve(f.paths.root, "candidate");
    const packaged = await runLlangCli([
      "package",
      f.paths.source,
      "--request",
      f.paths.request,
      "--suite",
      f.paths.suite,
      "--metadata",
      f.paths.metadata,
      "--out-dir",
      candidate,
    ]);
    expect(packaged).toMatchObject({
      exitCode: 0,
      output: { verification: "not-run" },
    });
    const manifest = (packaged.output as { manifest: string }).manifest;
    expect(await runLlangCli(["verify", manifest])).toMatchObject({
      exitCode: 0,
      output: { status: "pass" },
    });
    await writeFile(resolve(candidate, "tests.json"), "{}");
    expect(await runLlangCli(["verify", manifest])).toMatchObject({
      exitCode: 2,
      output: { status: "error" },
    });
  });

  test("returns one for failed acceptance and uncovered verification", async () => {
    const f = await cliFixture();
    const wrong = structuredClone(f.program);
    wrong.body.conditions = [wrong.body.conditions[0]];
    const wrongPath = resolve(f.paths.root, "wrong.llang.jsonc");
    await writeFile(wrongPath, JSON.stringify(wrong));
    expect(
      (
        await runLlangCli([
          "test",
          wrongPath,
          "--request",
          f.paths.request,
          "--suite",
          f.paths.suite,
        ])
      ).exitCode,
    ).toBe(1);

    const uncovered = {
      ...f.suite,
      cases: f.suite.cases.map((item) => ({
        ...item,
        requirementIds: item.requirementIds.filter(
          (id) => id !== "not-suspended",
        ),
      })),
    };
    await writeFile(f.paths.suite, JSON.stringify(uncovered));
    const candidate = resolve(f.paths.root, "uncovered");
    const packaged = await runLlangCli([
      "package",
      f.paths.source,
      "--request",
      f.paths.request,
      "--suite",
      f.paths.suite,
      "--metadata",
      f.paths.metadata,
      "--out-dir",
      candidate,
    ]);
    const manifest = (packaged.output as { manifest: string }).manifest;
    expect(await runLlangCli(["verify", manifest])).toMatchObject({
      exitCode: 1,
      output: { status: "fail" },
    });
  });

  test("runs fixture development and offline replay", async () => {
    const f = await cliFixture();
    const runDirectory = resolve(f.paths.root, "development");
    const developed = await runLlangCli([
      "develop",
      f.paths.request,
      "--suite",
      f.paths.suite,
      "--metadata",
      f.paths.metadata,
      "--fixtures",
      f.paths.fixture,
      "--out-dir",
      runDirectory,
      "--max-output-tokens",
      "4096",
      "--max-total-tokens",
      "100000",
      "--max-wall-ms",
      "120000",
    ]);
    expect(developed).toMatchObject({
      exitCode: 0,
      output: { status: "pass" },
    });
    expect(
      await runLlangCli([
        "replay-development",
        runDirectory,
        "--out-dir",
        resolve(f.paths.root, "replay"),
      ]),
    ).toMatchObject({ exitCode: 0, output: { status: "pass" } });
  });

  test("runs legacy migration and rejects the command option error matrix", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "llang-cli-migrate-"));
    roots.push(root);
    const migrated = await runLlangCli([
      "migrate",
      resolve(
        process.cwd(),
        "examples/prompt-active-customer/customer.prompt.json",
      ),
      "--out",
      resolve(root, "migrated.llang.jsonc"),
    ]);
    expect(migrated).toMatchObject({ exitCode: 0, output: { apiCalls: 0 } });

    const invalid = [
      [],
      ["unknown", "x"],
      ["lint", "x", "--bad"],
      ["format", "x"],
      ["build", "x", "--bad", "out"],
      ["test", "x", "--suite", "s", "--request", "r"],
      ["package", "x"],
      ["verify", "x", "extra"],
      ["mutation-check", "x"],
      ["migrate", "x", "--bad", "out"],
      ["develop", "x", "--suite", "s"],
      ["replay-development", "x", "--bad", "out"],
    ];
    for (const args of invalid)
      await expect(runLlangCli(args)).rejects.toThrow("usage: llang");
  });

  test("rejects unsafe source and supporting JSON files before processing", async () => {
    const f = await cliFixture();
    const wrongExtension = resolve(f.paths.root, "source.json");
    await writeFile(wrongExtension, "{}");
    await expect(runLlangCli(["lint", wrongExtension])).rejects.toThrow(
      ".llang.jsonc",
    );
    const oversized = resolve(f.paths.root, "oversized.llang.jsonc");
    await writeFile(oversized, "x".repeat(LLANG_SOURCE_BYTES + 1));
    await expect(runLlangCli(["lint", oversized])).rejects.toThrow("exceeds");
    const link = resolve(f.paths.root, "link.llang.jsonc");
    await symlink(f.paths.source, link);
    await expect(runLlangCli(["lint", link])).rejects.toThrow("non-symlink");

    await writeFile(f.paths.metadata, '{// no JSONC here\n"id":"x"}');
    await expect(
      runLlangCli([
        "package",
        f.paths.source,
        "--request",
        f.paths.request,
        "--suite",
        f.paths.suite,
        "--metadata",
        f.paths.metadata,
        "--out-dir",
        resolve(f.paths.root, "bad-json"),
      ]),
    ).rejects.toThrow("standard JSON");
  });
});
