import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { parseStrictJsonObject } from "./llang-jsonc";
import { evaluateValueProgram } from "./llang-module-value-evaluator";
import { loadValueModuleProgram } from "./llang-module-value-loader";
import {
  emitValueModuleJsonc,
  emitValueModuleTypeScript,
} from "./llang-module-value-source-emitter";
import { emitValueModuleWasm } from "./llang-module-value-wasm";
import { instantiateValueModule } from "./llang-module-value-runtime";
import { readValueModuleBuildManifest } from "./llang-module-value-build";

const HASH = /^[0-9a-f]{64}$/;
const compareAscii = (a: string, b: string): number =>
  a < b ? -1 : a > b ? 1 : 0;
export type ValueExpected =
  | { kind: "value"; value: unknown }
  | { kind: "invalid-input" }
  | {
      kind: "fault";
      code: "ARITHMETIC_OVERFLOW" | "DIVISION_BY_ZERO" | "RESOURCE_LIMIT";
    };
export type ValueModuleSuite = {
  format: "llang-module-suite";
  version: 2;
  profile: "module-value-v1";
  interfaceHash: string;
  cases: { id: string; input: unknown; expected: ValueExpected }[];
};
export function parseValueModuleSuite(value: unknown): ValueModuleSuite {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid value module suite");
  const suite = value as ValueModuleSuite;
  if (
    Object.keys(suite).some(
      (x) =>
        !["format", "version", "profile", "interfaceHash", "cases"].includes(x),
    ) ||
    suite.format !== "llang-module-suite" ||
    suite.version !== 2 ||
    suite.profile !== "module-value-v1" ||
    !HASH.test(suite.interfaceHash) ||
    !Array.isArray(suite.cases) ||
    !suite.cases.length ||
    suite.cases.length > 1024
  )
    throw new Error("invalid value module suite");
  const ids = new Set<string>();
  for (const item of suite.cases) {
    if (
      !item ||
      typeof item !== "object" ||
      Array.isArray(item) ||
      Object.keys(item).some((x) => !["id", "input", "expected"].includes(x)) ||
      typeof item.id !== "string" ||
      !item.id ||
      ids.has(item.id) ||
      !Object.hasOwn(item, "input") ||
      !item.expected ||
      typeof item.expected !== "object"
    )
      throw new Error("invalid value module suite case");
    ids.add(item.id);
    const expected = item.expected as ValueExpected;
    if (expected.kind === "value") {
      if (
        Object.keys(expected).some((x) => !["kind", "value"].includes(x)) ||
        !Object.hasOwn(expected, "value")
      )
        throw new Error("invalid value expected result");
    } else if (expected.kind === "invalid-input") {
      if (Object.keys(expected).length !== 1)
        throw new Error("invalid value expected result");
    } else if (expected.kind === "fault") {
      if (
        Object.keys(expected).some((x) => !["kind", "code"].includes(x)) ||
        !["ARITHMETIC_OVERFLOW", "DIVISION_BY_ZERO", "RESOURCE_LIMIT"].includes(
          expected.code,
        )
      )
        throw new Error("invalid value expected fault");
    } else throw new Error("invalid value expected result");
  }
  return suite;
}
export async function readValueModuleSuite(
  path: string,
): Promise<ValueModuleSuite> {
  const absolute = resolve(path),
    info = await lstat(absolute);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024)
    throw new Error("value suite must be a bounded regular file");
  return parseValueModuleSuite(
    parseStrictJsonObject(
      new TextDecoder("utf-8", { fatal: true }).decode(
        await readFile(absolute),
      ),
      absolute,
    ),
  );
}
function canonical(value: unknown): string {
  if (value && typeof value === "object" && !Array.isArray(value))
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => compareAscii(a, b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return JSON.stringify(value);
}
function runCases(
  suite: ValueModuleSuite,
  evaluate: (input: unknown) => unknown,
) {
  return suite.cases.map((test) => {
    try {
      const actual = evaluate(test.input),
        pass =
          test.expected.kind === "value" &&
          canonical(actual) === canonical(test.expected.value);
      return {
        id: test.id,
        status: pass ? "pass" : "fail",
        expected: test.expected,
        actual,
      };
    } catch (error) {
      const code =
          error && typeof error === "object" && "code" in error
            ? String(error.code)
            : "EXECUTION_ERROR",
        pass =
          test.expected.kind === "invalid-input"
            ? code === "INVALID_INPUT"
            : test.expected.kind === "fault"
              ? code === test.expected.code
              : false;
      return {
        id: test.id,
        status: pass ? "pass" : "fail",
        expected: test.expected,
        error: error instanceof Error ? error.message : String(error),
        code,
      };
    }
  });
}
async function runGeneratedTypeScript(
  text: string,
  suite: ValueModuleSuite,
  temporary: string,
) {
  const generated = join(temporary, "program.generated.ts"),
    cases = join(temporary, "cases.json"),
    runner = join(temporary, "runner.ts");
  await writeFile(generated, text);
  await writeFile(cases, JSON.stringify(suite.cases));
  await writeFile(
    runner,
    `import { evaluate } from "./program.generated"; const cases = await Bun.file(process.argv[2]!).json() as any[]; const canonical=(v:any):string=>v&&typeof v==="object"&&!Array.isArray(v)?"{"+Object.entries(v).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,x])=>JSON.stringify(k)+":"+canonical(x)).join(",")+"}":JSON.stringify(v); console.log(JSON.stringify(cases.map(t=>{try{const actual=evaluate(t.input),pass=t.expected.kind==="value"&&canonical(actual)===canonical(t.expected.value);return{id:t.id,status:pass?"pass":"fail",expected:t.expected,actual}}catch(error){const code=error&&typeof error==="object"&&"code" in error?String((error as any).code):"EXECUTION_ERROR",pass=t.expected.kind==="invalid-input"?code==="INVALID_INPUT":t.expected.kind==="fault"?code===t.expected.code:false;return{id:t.id,status:pass?"pass":"fail",expected:t.expected,error:String(error),code}}})));`,
  );
  const child = Bun.spawn([process.execPath, runner, cases], {
      cwd: temporary,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: {},
    }),
    timeout = setTimeout(() => child.kill(), 5000);
  try {
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (exit !== 0)
      throw new Error(
        `generated TypeScript execution failed: ${stderr.slice(0, 2000)}`,
      );
    return JSON.parse(stdout) as ReturnType<typeof runCases>;
  } finally {
    clearTimeout(timeout);
  }
}
async function runPortableValueWasm(
  contract: Parameters<typeof instantiateValueModule>[0],
  bytes: Uint8Array,
  suite: ValueModuleSuite,
) {
  const child = Bun.spawn(
      [
        process.execPath,
        resolve(import.meta.dir, "llang-module-value-runtime-worker.ts"),
      ],
      {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env: {},
      },
    ),
    payload = JSON.stringify({
      wasm: Buffer.from(bytes).toString("base64"),
      contract,
      cases: suite.cases,
    });
  child.stdin.write(payload);
  child.stdin.end();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, 2_000);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (timedOut) throw new Error("portable value Wasm execution timed out");
    if (exitCode !== 0)
      throw new Error(
        `portable value Wasm execution failed: ${stderr.slice(0, 2_000)}`,
      );
    return JSON.parse(stdout) as ReturnType<typeof runCases>;
  } finally {
    clearTimeout(timeout);
  }
}
export async function testValueModuleProgram(options: {
  entry: string;
  root: string;
  entryName: string;
  suite: string;
}) {
  const [program, suite] = await Promise.all([
    loadValueModuleProgram(options.entry, options.root, options.entryName),
    readValueModuleSuite(options.suite),
  ]);
  if (suite.interfaceHash !== program.interfaceHash)
    throw new Error("suite interfaceHash does not match program");
  const reference = runCases(suite, (x) => evaluateValueProgram(program, x)),
    emitted = emitValueModuleWasm(program),
    wasmRuntime = instantiateValueModule(emitted.contract, emitted.bytes),
    wasm = runCases(suite, wasmRuntime.evaluate),
    temporary = await mkdtemp(join(tmpdir(), "llang-value-test-"));
  try {
    const typescript = await runGeneratedTypeScript(
        emitValueModuleTypeScript(program),
        suite,
        temporary,
      ),
      jsonRoot = join(temporary, "jsonc");
    for (const [path, text] of emitValueModuleJsonc(program)) {
      const target = join(jsonRoot, path);
      await mkdir(resolve(target, ".."), { recursive: true });
      await writeFile(target, text);
    }
    const entryId = program.entry.slice(0, program.entry.lastIndexOf("#")),
      roundTrip = await loadValueModuleProgram(
        `${entryId}.llang.jsonc`,
        jsonRoot,
        options.entryName,
      );
    if (roundTrip.programHash !== program.programHash)
      throw new Error("JSONC round-trip programHash mismatch");
    const jsonc = runCases(suite, (x) => evaluateValueProgram(roundTrip, x)),
      targets = { reference, typescript, jsonc, wasm };
    return {
      ok: Object.values(targets)
        .flat()
        .every((x) => x.status === "pass"),
      programHash: program.programHash,
      interfaceHash: program.interfaceHash,
      layoutHash: program.layoutHash,
      targets,
      results: reference,
    };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
export async function verifyValueModuleBundle(
  manifestPath: string,
  suitePath: string,
) {
  const [{ manifest, artifactBytes }, suite] = await Promise.all([
    readValueModuleBuildManifest(manifestPath),
    readValueModuleSuite(suitePath),
  ]);
  if (suite.interfaceHash !== manifest.interfaceHash)
    throw new Error("suite interfaceHash does not match bundle");
  if (!manifest.wasm)
    throw new Error("INVALID_ARTIFACT: bundle has no Wasm target");
  const bytes = artifactBytes.get(manifest.wasm.path);
  if (!bytes) throw new Error("ARTIFACT_MISMATCH: missing Wasm bytes");
  const results = await runPortableValueWasm(
    manifest.wasm.contract,
    bytes,
    suite,
  );
  return {
    ok: results.every((x) => x.status === "pass"),
    programHash: manifest.programHash,
    interfaceHash: manifest.interfaceHash,
    layoutHash: manifest.layoutHash,
    results,
  };
}
