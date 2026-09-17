import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { atomicWriteJson } from "../../src/atomic-file";
import {
  developLlangCapability,
  fixtureLlangAgent,
  replayLlangDevelopment,
} from "../../src/llang-development";
import {
  packageLlangCapability,
  parseLlangRequest,
  requestRevision,
  readLlangCapability,
  verifyLlangCapability,
} from "../../src/llang-capability";
import { checkLlangProgram } from "../../src/llang-program";
import { contentHash } from "../../src/prompt-source";
import { instantiateWasmPredicate } from "../../src/wasm-runtime";

/** Local promotion always re-verifies the release and records its exact package hash. */
export async function activateRelease(root: string, release: "v1" | "v2") {
  const manifest = resolve(root, "releases", release, "capability.json");
  const report = await verifyLlangCapability(manifest);
  if (report.status !== "pass")
    throw new Error(`release rejected: ${report.status}`);
  const active = { release, packageHash: report.packageHash };
  await atomicWriteJson(resolve(root, "active.json"), active);
  return active;
}

export async function invokeActive(root: string, input: unknown) {
  const active = JSON.parse(
    await readFile(resolve(root, "active.json"), "utf8"),
  );
  if (!["v1", "v2"].includes(active.release))
    throw new Error("invalid active release");
  const directory = resolve(root, "releases", active.release);
  const verified = await verifyLlangCapability(
    resolve(directory, "capability.json"),
  );
  if (verified.status !== "pass" || verified.packageHash !== active.packageHash)
    throw new Error("active package changed");
  const snapshot = await readLlangCapability(
    resolve(directory, "capability.json"),
  );
  if (snapshot.packageHash !== active.packageHash)
    throw new Error("active package changed during loading");
  return (
    await instantiateWasmPredicate(snapshot.build, snapshot.bytes)
  ).evaluate(input);
}

export async function runLifecycle(outputDirectory: string) {
  const root = resolve(outputDirectory);
  await mkdir(root);
  await mkdir(resolve(root, "releases"));
  const example = resolve(import.meta.dir, "../jsonc-enabled-user");
  const load = async (file: string) =>
    JSON.parse(await readFile(resolve(example, file), "utf8"));
  const requestV2 = parseLlangRequest(await load("request.json"));
  const suiteV2 = await load("tests.json");
  const metadata = await load("metadata.json");
  const sourceV2 = await readFile(
    resolve(example, "enabled-user.llang.jsonc"),
    "utf8",
  );
  const checked = checkLlangProgram(
    sourceV2,
    "enabled-user.llang.jsonc",
  ).checked;
  if (checked?.program.body.kind !== "all")
    throw new Error("invalid lifecycle fixture");
  const programV1 = {
    ...checked.program,
    body: checked.program.body.conditions[0],
  };
  const requestV1 = parseLlangRequest({
    ...requestV2,
    body: "enabled が true の利用者を許可する。",
    requirements: requestV2.requirements.filter(
      (item) => item.id === "enabled",
    ),
  });
  const suiteV1 = {
    ...suiteV2,
    requestRevision: requestRevision(requestV1),
    cases: suiteV2.cases.map(
      (item: { input: { enabled: boolean }; requirementIds: string[] }) => ({
        ...item,
        requirementIds: ["enabled"],
        expected: { kind: "value", value: item.input.enabled },
      }),
    ),
  };
  const inputs = resolve(root, "inputs-v1");
  await mkdir(inputs);
  await writeFile(
    resolve(inputs, "source.llang.jsonc"),
    JSON.stringify(programV1, null, 2),
  );
  await writeFile(resolve(inputs, "request.json"), JSON.stringify(requestV1));
  await writeFile(resolve(inputs, "tests.json"), JSON.stringify(suiteV1));
  await packageLlangCapability(
    resolve(inputs, "source.llang.jsonc"),
    resolve(inputs, "request.json"),
    resolve(inputs, "tests.json"),
    { ...metadata, release: "v1" },
    resolve(root, "releases/v1"),
  );
  const initial = await activateRelease(root, "v1");
  const input = { enabled: true, suspended: true };
  if ((await invokeActive(root, input)) !== true)
    throw new Error("v1 behavior mismatch");
  const development = await developLlangCapability(
    requestV2,
    suiteV2,
    { ...metadata, release: "v2" },
    {
      version: 2,
      mode: "fixture",
      model: "fixture",
      maxCalls: 2,
      maxOutputTokens: 4096,
      maxTotalTokens: 100000,
      maxWallMs: 120000,
    },
    fixtureLlangAgent(await load("development.fixture.json")),
    resolve(root, "development"),
  );
  if (development.status !== "pass" || development.attempts.length !== 2)
    throw new Error("repair did not complete");
  const replay = await replayLlangDevelopment(
    resolve(root, "development"),
    resolve(root, "replay"),
  );
  if (replay.status !== "pass") throw new Error("replay failed");
  await cp(
    resolve(root, "development/attempt-1/candidate"),
    resolve(root, "releases/v2"),
    { recursive: true },
  );
  const promoted = await activateRelease(root, "v2");
  if ((await invokeActive(root, input)) !== false)
    throw new Error("v2 behavior mismatch");
  const rolledBack = await activateRelease(root, "v1");
  if ((await invokeActive(root, input)) !== true)
    throw new Error("rollback behavior mismatch");
  const report = {
    version: 1,
    mode: "offline-fixture",
    apiCalls: 0,
    requestV1: requestRevision(requestV1),
    requestV2: requestRevision(requestV2),
    suiteV1: contentHash(suiteV1),
    suiteV2: contentHash(suiteV2),
    attempts: development.attempts,
    replay: replay.status,
    initial,
    promoted,
    rolledBack,
    behavior: [true, false, true],
    acceptance: "not-run",
    scope:
      "Local filesystem deployment; remote rollout and human acceptance are not measured.",
  };
  await atomicWriteJson(resolve(root, "lifecycle.json"), report);
  return report;
}

if (import.meta.main)
  console.log(
    JSON.stringify(
      await runLifecycle(process.argv[2] ?? "artifacts/capability-lifecycle"),
      null,
      2,
    ),
  );
