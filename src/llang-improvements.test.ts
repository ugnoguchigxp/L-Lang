import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { executeLlangCli } from "./llang-cli";
import {
  runLlangSuite,
  runLlangSuiteSnapshot,
  packageLlangCapability,
  verifyLlangCapability,
} from "./llang-capability";
import { withSourceWriteLock } from "./source-write-lock";
import { requestRevision } from "./llang-capability-contracts";
import { digest } from "./wasm-contract";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function temporary() {
  const root = await mkdtemp(resolve(tmpdir(), "llang-improvements-"));
  roots.push(root);
  return root;
}

test("test and packaged verification report the same evidence hashes", async () => {
  const root = await temporary();
  const base = resolve("examples/jsonc-enabled-user");
  const source = resolve(base, "enabled-user.llang.jsonc");
  const request = resolve(base, "request.json"),
    suite = resolve(base, "tests.json");
  const tested = await runLlangSuite(source, request, suite);
  expect(tested.sourceHash).toBe(digest(await readFile(source)));
  const packaged = await packageLlangCapability(
    source,
    request,
    suite,
    JSON.parse(await readFile(resolve(base, "metadata.json"), "utf8")),
    resolve(root, "package"),
  );
  const verified = await verifyLlangCapability(packaged.manifest);
  for (const key of [
    "requestRevision",
    "suiteHash",
    "sourceHash",
    "programHash",
    "artifactHash",
  ] as const)
    expect(verified[key]).toBe(tested[key]);
  expect(tested.results).toEqual(verified.results);
});

test("help works without input and JSON errors have stable codes", async () => {
  expect(await executeLlangCli(["--help"])).toMatchObject({ exitCode: 0 });
  const help = await executeLlangCli(["mutation-check", "--help", "--json"]);
  expect(help).toMatchObject({ exitCode: 0, output: { ok: true } });
  expect(await executeLlangCli(["unknown", "x", "--json"])).toMatchObject({
    exitCode: 2,
    output: { error: { code: "INVALID_ARGUMENT" } },
  });
  expect(
    await executeLlangCli(["lint", "missing.llang.jsonc", "--json"]),
  ).toMatchObject({ exitCode: 2, output: { error: { code: "ENOENT" } } });
  expect(await executeLlangCli(["--help", "--json", "--json"])).toMatchObject({
    exitCode: 2,
  });
});

test("source lock rejects a competing writer and releases after failures", async () => {
  const root = await temporary(),
    path = resolve(root, "source.llang.jsonc");
  await writeFile(path, "{}");
  await withSourceWriteLock(path, async () => {
    await expect(
      withSourceWriteLock(path, async () => undefined),
    ).rejects.toThrow("SOURCE_CONFLICT");
  });
  await expect(
    withSourceWriteLock(path, async () => {
      throw new Error("deliberate failure");
    }),
  ).rejects.toThrow("deliberate failure");
  expect(await withSourceWriteLock(path, async () => "released")).toBe(
    "released",
  );
});

test("captured test input is unaffected by original source replacement", async () => {
  const root = await temporary(),
    source = resolve(root, "source.llang.jsonc");
  const base = resolve("examples/jsonc-enabled-user");
  const captured = await readFile(
    resolve(base, "enabled-user.llang.jsonc"),
    "utf8",
  );
  const request = JSON.parse(
    await readFile(resolve(base, "request.json"), "utf8"),
  );
  const suite = JSON.parse(await readFile(resolve(base, "tests.json"), "utf8"));
  await writeFile(source, captured);
  const expectedRevision = requestRevision(request);
  const pending = runLlangSuiteSnapshot(captured, request, suite);
  request.contract.fields[0].values.push("mutation after capture");
  await writeFile(source, "invalid replacement");
  const report = await pending;
  expect(report.sourceHash).toBe(digest(captured));
  expect(report.requestRevision).toBe(expectedRevision);
  request.contract.fields[0].values.length = 0;
  expect(report.results.every((item) => item.status === "pass")).toBe(true);
  const comments = await runLlangSuiteSnapshot(
    `// another comment\n${captured}`,
    request,
    suite,
  );
  expect(comments.sourceHash).not.toBe(report.sourceHash);
  expect(comments.programHash).toBe(report.programHash);
  expect(comments.artifactHash).toBe(report.artifactHash);
});

test("CLI JSON help works for all subcommands and byte-level BOM is rejected", async () => {
  for (const command of [
    "lint",
    "format",
    "build",
    "test",
    "package",
    "verify",
    "mutation-check",
    "migrate",
    "develop",
    "replay-development",
  ])
    expect(await executeLlangCli([command, "--help", "--json"])).toMatchObject({
      exitCode: 0,
      output: { ok: true },
    });
  const root = await temporary(),
    source = resolve(root, "bom.llang.jsonc");
  const base = resolve("examples/jsonc-enabled-user");
  await writeFile(
    source,
    Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      await readFile(resolve(base, "enabled-user.llang.jsonc")),
    ]),
  );
  const result = await executeLlangCli(["lint", source, "--json"]);
  expect(result.exitCode).toBe(1);
  expect(JSON.stringify(result.output)).toContain("BOM");
  await expect(
    runLlangSuite(
      source,
      resolve(base, "request.json"),
      resolve(base, "tests.json"),
    ),
  ).rejects.toThrow("source failed lint");
});
