import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { evaluateValueProgram } from "./llang-module-value-evaluator";
import type {
  ValueExpression,
  ValueModuleSource,
} from "./llang-module-value-ir";
import { loadValueModuleProgram } from "./llang-module-value-loader";
import { instantiateValueModule } from "./llang-module-value-runtime";
import {
  emitValueModuleJsonc,
  emitValueModuleTypeScript,
} from "./llang-module-value-source-emitter";
import { emitValueModuleWasm } from "./llang-module-value-wasm";

export type ValueDifferentialInput = unknown;

export type ValueDifferentialOutcome =
  | Readonly<{ kind: "value"; value: number }>
  | Readonly<{
      kind: "fault";
      code: "ARITHMETIC_OVERFLOW" | "DIVISION_BY_ZERO" | "RESOURCE_LIMIT";
    }>;

export type ValueDifferentialOutcomes = Readonly<{
  oracle: ValueDifferentialOutcome;
  reference: ValueDifferentialOutcome;
  typescript: ValueDifferentialOutcome;
  jsonc: ValueDifferentialOutcome;
  wasm: ValueDifferentialOutcome;
}>;

export const VALUE_DIFFERENTIAL_LANES = [
  "oracle",
  "reference",
  "typescript",
  "jsonc",
  "wasm",
] as const;

const I32_MIN = -2_147_483_648;
const I32_MAX = 2_147_483_647;
const FAULTS = new Set([
  "ARITHMETIC_OVERFLOW",
  "DIVISION_BY_ZERO",
  "RESOURCE_LIMIT",
]);

export function captureValueDifferentialOutcome(
  run: () => unknown,
): ValueDifferentialOutcome {
  try {
    const value = run();
    if (
      typeof value !== "number" ||
      !Number.isInteger(value) ||
      value < I32_MIN ||
      value > I32_MAX
    )
      throw new Error("value differential lane returned a non-i32 result");
    return Object.freeze({
      kind: "value",
      value: Object.is(value, -0) ? 0 : value,
    });
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? String(error.code)
        : undefined;
    if (code && FAULTS.has(code))
      return Object.freeze({
        kind: "fault",
        code,
      }) as ValueDifferentialOutcome;
    throw error;
  }
}

export function sameValueDifferentialOutcome(
  left: ValueDifferentialOutcome,
  right: ValueDifferentialOutcome,
): boolean {
  if (left.kind === "value")
    return right.kind === "value" && left.value === right.value;
  return right.kind === "fault" && left.code === right.code;
}

export function assertFiveValueDifferentialLanes(
  outcomes: ValueDifferentialOutcomes,
): void {
  const keys = Object.keys(outcomes);
  if (
    keys.length !== VALUE_DIFFERENTIAL_LANES.length ||
    VALUE_DIFFERENTIAL_LANES.some((lane) => !Object.hasOwn(outcomes, lane))
  )
    throw new Error("value differential outcomes must contain all five lanes");
}

function sourceExpression(node: ValueExpression): unknown {
  switch (node.kind) {
    case "literal":
    case "param":
    case "local":
      return node;
    case "field":
      return { ...node, base: sourceExpression(node.base) };
    case "unary":
      return { ...node, operand: sourceExpression(node.operand) };
    case "binary":
      return {
        ...node,
        left: sourceExpression(node.left),
        right: sourceExpression(node.right),
      };
    case "call":
    case "intrinsic":
      return { ...node, arguments: node.arguments.map(sourceExpression) };
    case "record":
    case "variant":
      return {
        ...node,
        fields: node.fields.map((field) => ({
          name: field.name,
          value: sourceExpression(field.value),
        })),
      };
    case "block":
      return {
        ...node,
        bindings: node.bindings.map((binding) => ({
          ...binding,
          value: sourceExpression(binding.value),
        })),
        result: sourceExpression(node.result),
      };
    case "if":
      return Object.fromEntries([
        ["kind", "if"],
        ["condition", sourceExpression(node.condition)],
        // biome-ignore lint/suspicious/noThenProperty: The JSONC source grammar names this branch "then".
        ["then", sourceExpression(node.whenTrue)],
        ["else", sourceExpression(node.whenFalse)],
      ]);
    case "match":
      return {
        ...node,
        value: sourceExpression(node.value),
        cases: node.cases.map((item) => ({
          tag: item.tag,
          body: sourceExpression(item.body),
        })),
      };
  }
}

function sourceJson(source: ValueModuleSource): unknown {
  return {
    ...source,
    functions: source.functions.map((fn) => ({
      ...fn,
      body: sourceExpression(fn.body),
    })),
  };
}

function parseTypeScriptOutcomes(
  text: string,
  expectedLength: number,
): readonly ValueDifferentialOutcome[] {
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed) || parsed.length !== expectedLength)
    throw new Error("generated TypeScript returned an invalid outcome list");
  return Object.freeze(
    parsed.map((item) => {
      if (!item || typeof item !== "object")
        throw new Error("generated TypeScript returned an invalid outcome");
      const record = item as Record<string, unknown>;
      if (record.kind === "value")
        return captureValueDifferentialOutcome(() => record.value);
      if (
        record.kind === "fault" &&
        typeof record.code === "string" &&
        FAULTS.has(record.code)
      )
        return Object.freeze({
          kind: "fault",
          code: record.code,
        }) as ValueDifferentialOutcome;
      throw new Error("generated TypeScript returned an unknown outcome");
    }),
  );
}

async function runGeneratedTypeScript(
  root: string,
  inputs: readonly ValueDifferentialInput[],
): Promise<readonly ValueDifferentialOutcome[]> {
  const inputsPath = join(root, "inputs.json"),
    runnerPath = join(root, "typescript-runner.ts");
  await writeFile(inputsPath, `${JSON.stringify(inputs)}\n`);
  await writeFile(
    runnerPath,
    `import { evaluate } from "./program.generated";
const inputs = await Bun.file(process.argv[2]!).json() as unknown[];
const outcomes = inputs.map((input) => {
  try {
    return { kind: "value", value: evaluate(input) };
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error
      ? String(error.code)
      : "UNKNOWN";
    return { kind: "fault", code };
  }
});
process.stdout.write(JSON.stringify(outcomes));
`,
  );
  const child = Bun.spawn([process.execPath, "run", runnerPath, inputsPath], {
    cwd: root,
    env: {},
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, 5_000);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (exitCode !== 0)
      throw new Error(
        timedOut
          ? "generated TypeScript execution timed out"
          : `generated TypeScript execution failed: ${stderr.slice(0, 2_000)}`,
      );
    return parseTypeScriptOutcomes(stdout, inputs.length);
  } finally {
    clearTimeout(timeout);
  }
}

export async function runValueDifferentialLanes(options: {
  source: ValueModuleSource;
  inputs: readonly ValueDifferentialInput[];
  oracle: (input: ValueDifferentialInput, inputIndex: number) => unknown;
  assertOutcomes: (
    inputIndex: number,
    outcomes: ValueDifferentialOutcomes,
  ) => void;
  temporaryPrefix: string;
}): Promise<Readonly<{ programHash: string; inputs: number }>> {
  const root = await mkdtemp(join(tmpdir(), options.temporaryPrefix));
  try {
    const sourcePath = join(root, "main.llang.jsonc");
    await writeFile(
      sourcePath,
      `${JSON.stringify(sourceJson(options.source), null, 2)}\n`,
    );
    const program = await loadValueModuleProgram(
        "main.llang.jsonc",
        root,
        "evaluate",
      ),
      generatedTs = join(root, "program.generated.ts");
    await writeFile(generatedTs, emitValueModuleTypeScript(program));
    const typescriptOutcomes = await runGeneratedTypeScript(
      root,
      options.inputs,
    );
    const jsonRoot = join(root, "round-trip");
    for (const [path, text] of emitValueModuleJsonc(program)) {
      const target = join(jsonRoot, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, text);
    }
    const roundTrip = await loadValueModuleProgram(
      "main.llang.jsonc",
      jsonRoot,
      "evaluate",
    );
    if (roundTrip.programHash !== program.programHash)
      throw new Error("value differential JSONC round-trip hash mismatch");
    const emitted = emitValueModuleWasm(program),
      wasm = instantiateValueModule(emitted.contract, emitted.bytes);

    for (const [inputIndex, input] of options.inputs.entries()) {
      const typescriptOutcome = typescriptOutcomes[inputIndex];
      if (!typescriptOutcome)
        throw new Error("generated TypeScript outcome is missing");
      const outcomes = Object.freeze({
        oracle: captureValueDifferentialOutcome(() =>
          options.oracle(input, inputIndex),
        ),
        reference: captureValueDifferentialOutcome(() =>
          evaluateValueProgram(program, input),
        ),
        typescript: typescriptOutcome,
        jsonc: captureValueDifferentialOutcome(() =>
          evaluateValueProgram(roundTrip, input),
        ),
        wasm: captureValueDifferentialOutcome(() => wasm.evaluate(input)),
      });
      options.assertOutcomes(inputIndex, outcomes);
    }
    return Object.freeze({
      programHash: program.programHash,
      inputs: options.inputs.length,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
