import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { readCapability } from "./capability-package";
import { verifyInventory } from "./paper-evidence";
import { buildPromptWasm } from "./prompt-wasm";
import { contentHash, readJson } from "./prompt-source";
import { parseResolutionLock } from "./prompt-resolution";
import { lowerPredicate } from "./wasm-core";
import { loadWasmPredicate, instantiateWasmPredicate } from "./wasm-runtime";

type OracleCase = {
  id: string;
  input: Record<string, unknown>;
  expected:
    | { kind: "value"; value: boolean }
    | { kind: "error"; code: "INVALID_INPUT" };
};
export function parsePaperOracle(value: unknown): {
  version: 1;
  taskId: string;
  origin: string;
  review: string;
  cases: OracleCase[];
} {
  if (!value || typeof value !== "object") throw new Error("invalid oracle");
  const raw = value as Record<string, unknown>;
  if (
    raw.version !== 1 ||
    typeof raw.taskId !== "string" ||
    !/^[a-z][a-z0-9-]*$/.test(raw.taskId) ||
    typeof raw.origin !== "string" ||
    !raw.origin.trim() ||
    !["unreviewed", "reviewed"].includes(String(raw.review)) ||
    !Array.isArray(raw.cases) ||
    Object.keys(raw).some(
      (key) =>
        !["version", "taskId", "origin", "review", "cases"].includes(key),
    )
  )
    throw new Error("invalid oracle header");
  const cases = raw.cases as OracleCase[];
  if (
    !cases.length ||
    new Set(cases.map((c) => c.id)).size !== cases.length ||
    cases.some(
      (c) =>
        !c ||
        typeof c !== "object" ||
        typeof c.id !== "string" ||
        !/^[a-z][a-z0-9-]*$/.test(c.id) ||
        !c.input ||
        typeof c.input !== "object" ||
        Array.isArray(c.input) ||
        !c.expected ||
        typeof c.expected !== "object" ||
        !(
          (c.expected.kind === "value" &&
            typeof c.expected.value === "boolean" &&
            Object.keys(c.expected).every((key) =>
              ["kind", "value"].includes(key),
            )) ||
          (c.expected.kind === "error" &&
            c.expected.code === "INVALID_INPUT" &&
            Object.keys(c.expected).every((key) =>
              ["kind", "code"].includes(key),
            ))
        ) ||
        Object.keys(c).some(
          (key) => !["id", "input", "expected"].includes(key),
        ),
    )
  )
    throw new Error("invalid oracle cases");
  return raw as ReturnType<typeof parsePaperOracle>;
}
function observed(fn: () => boolean) {
  try {
    return { kind: "value", value: fn() };
  } catch (error) {
    return {
      kind: "error",
      code:
        error && typeof error === "object" && "code" in error
          ? String(error.code)
          : "EXECUTION_ERROR",
    };
  }
}
async function rejects(fn: () => unknown | Promise<unknown>) {
  try {
    await fn();
    return { detected: false, stage: "none" };
  } catch (error) {
    return {
      detected: true,
      stage:
        error && typeof error === "object" && "code" in error
          ? String(error.code)
          : "validation",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
export async function evaluatePaper(
  inventoryPath: string,
  oraclePath: string,
  outDir: string,
) {
  const inventory = await verifyInventory(inventoryPath);
  if (inventory.diagnostics.length || inventory.runStatus !== "pass")
    throw new Error("invalid inventory for evaluation");
  const oracle = parsePaperOracle(await readJson(oraclePath));
  const input = resolve(dirname(inventoryPath), "evidence");
  const attempt =
    ((await readJson(resolve(input, "run.json"))) as { attempts: unknown[] })
      .attempts.length - 1;
  const candidate = resolve(input, `attempt-${attempt}`, "candidate");
  const pkg = await readCapability(resolve(candidate, "capability.json"));
  if (pkg.source.id !== oracle.taskId)
    throw new Error("oracle task differs from package");
  const runtime = await loadWasmPredicate(resolve(candidate, "manifest.json"));
  const cases = oracle.cases.map((c) => {
    const actual = observed(() => runtime.evaluate(c.input));
    return {
      id: c.id,
      expected: c.expected,
      actual,
      status:
        JSON.stringify(actual) === JSON.stringify(c.expected) ? "pass" : "fail",
    };
  });
  const output = resolve(outDir);
  await mkdir(dirname(output), { recursive: true });
  await mkdir(output);
  const wrongBody = {
    kind: "equals" as const,
    property: ["enabled"],
    value: true,
  };
  const wrongLockBase = {
    ...pkg.lock,
    body: wrongBody,
    irHash: contentHash(wrongBody),
  };
  const { checksum: _checksum, ...unsigned } = wrongLockBase;
  const wrongLock = { ...unsigned, checksum: contentHash(unsigned) };
  const wrongSource = resolve(output, "wrong-source.json");
  await writeFile(wrongSource, JSON.stringify(pkg.source), { flag: "wx" });
  await writeFile(`${wrongSource}.lock.json`, JSON.stringify(wrongLock), {
    flag: "wx",
  });
  const wrongDir = resolve(output, "wrong-build");
  await mkdir(wrongDir);
  await buildPromptWasm(wrongSource, wrongDir);
  const wrongRuntime = await loadWasmPredicate(
    resolve(wrongDir, "manifest.json"),
  );
  const counterexamples = oracle.cases
    .filter(
      (c) =>
        c.expected.kind === "value" &&
        observed(() => wrongRuntime.evaluate(c.input)).kind === "value" &&
        wrongRuntime.evaluate(c.input) !== c.expected.value,
    )
    .map((c) => c.id);
  const alteredWasm = Uint8Array.from(pkg.bytes);
  alteredWasm[alteredWasm.length - 1] =
    (alteredWasm[alteredWasm.length - 1] as number) ^ 1;
  const negative = {
    unknownField: await rejects(() =>
      lowerPredicate(
        { kind: "equals", property: ["unknown"], value: true },
        pkg.source.contract,
      ),
    ),
    typeMismatch: await rejects(() =>
      lowerPredicate(
        { kind: "equals", property: ["enabled"], value: "true" },
        pkg.source.contract,
      ),
    ),
    lockChange: await rejects(() =>
      parseResolutionLock({ ...pkg.lock, body: wrongBody }, pkg.source),
    ),
    contractChange: await rejects(() =>
      instantiateWasmPredicate(
        {
          ...pkg.build,
          contract: {
            ...pkg.source.contract,
            fields: pkg.source.contract.fields.slice(0, 1),
          },
        },
        pkg.bytes,
      ),
    ),
    wasmChange: await rejects(() =>
      instantiateWasmPredicate(pkg.build, alteredWasm),
    ),
    legalWrongIr: {
      detected: counterexamples.length > 0,
      stage: "independent-oracle",
      counterexamples,
    },
  };
  const result = {
    version: 1,
    taskId: oracle.taskId,
    origin: inventory.origin,
    oracleReview: oracle.review,
    packageHash: pkg.packageHash,
    wasmHash: pkg.build.wasmHash,
    cases,
    status:
      cases.every((c) => c.status === "pass") &&
      Object.values(negative).every((n) => n.detected)
        ? "pass"
        : "fail",
  };
  await writeFile(
    resolve(output, "evaluation.json"),
    `${JSON.stringify(result, null, 2)}\n`,
    { flag: "wx" },
  );
  await writeFile(
    resolve(output, "negative-results.json"),
    `${JSON.stringify(negative, null, 2)}\n`,
    { flag: "wx" },
  );
  return { ...result, negative };
}
