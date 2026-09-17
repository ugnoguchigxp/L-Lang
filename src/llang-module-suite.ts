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
import { instantiateWasmPredicate } from "./wasm-runtime";
import { digest, WasmError } from "./wasm-contract";
import { evaluateModuleProgram } from "./llang-module-evaluator";
import { loadModuleProgram } from "./llang-module-loader";
import {
  readModuleBuildManifest,
  type ModuleBuildManifest,
} from "./llang-module-build";
import { emitModuleWasm } from "./llang-module-wasm";
import {
  emitModuleJsonc,
  emitModuleTypeScript,
} from "./llang-module-source-emitter";
import { parseStrictJsonObject } from "./llang-jsonc";

const HASH = /^[0-9a-f]{64}$/;

export type ModuleSuite = {
  format: "llang-module-suite";
  version: 1;
  interfaceHash: string;
  cases: { id: string; input: unknown; expected: boolean | "INVALID_INPUT" }[];
};
export function parseModuleSuite(value: unknown): ModuleSuite {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid module suite");
  const suite = value as ModuleSuite;
  if (
    Object.keys(suite).some(
      (key) => !["format", "version", "interfaceHash", "cases"].includes(key),
    )
  )
    throw new Error("invalid module suite field");
  if (
    suite.format !== "llang-module-suite" ||
    suite.version !== 1 ||
    !HASH.test(suite.interfaceHash) ||
    !Array.isArray(suite.cases) ||
    !suite.cases.length ||
    suite.cases.length > 1024
  )
    throw new Error("invalid module suite");
  if (
    new Set(suite.cases.map((x) => x.id)).size !== suite.cases.length ||
    suite.cases.some(
      (x) =>
        !x ||
        typeof x !== "object" ||
        Array.isArray(x) ||
        Object.keys(x).some(
          (key) => !["id", "input", "expected"].includes(key),
        ) ||
        typeof x.id !== "string" ||
        !x.id ||
        [...x.id].length > 128 ||
        !Object.hasOwn(x, "input") ||
        (typeof x.expected !== "boolean" && x.expected !== "INVALID_INPUT"),
    )
  )
    throw new Error("invalid module suite cases");
  return suite;
}
export async function readModuleSuite(path: string): Promise<ModuleSuite> {
  const absolute = resolve(path),
    info = await lstat(absolute);
  if (!info.isFile() || info.isSymbolicLink())
    throw new Error("module suite must be a regular non-symlink file");
  const bytes = await readFile(absolute);
  if (bytes.byteLength > 1024 * 1024)
    throw new Error("module suite exceeds byte limit");
  return parseModuleSuite(
    parseStrictJsonObject(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      absolute,
    ),
  );
}
function runCases(suite: ModuleSuite, evaluate: (input: unknown) => boolean) {
  return suite.cases.map((test) => {
    try {
      const actual = evaluate(test.input);
      return {
        id: test.id,
        status: actual === test.expected ? "pass" : "fail",
        expected: test.expected,
        actual,
      };
    } catch (error) {
      const invalid =
        (error instanceof WasmError && error.code === "INVALID_INPUT") ||
        (typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "INVALID_INPUT");
      return {
        id: test.id,
        status: invalid && test.expected === "INVALID_INPUT" ? "pass" : "fail",
        expected: test.expected,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });
}

async function runGeneratedTypeScript(
  generatedPath: string,
  suite: ModuleSuite,
  temporary: string,
) {
  const casesPath = join(temporary, "typescript-cases.json"),
    runnerPath = join(temporary, "typescript-runner.ts");
  await writeFile(casesPath, JSON.stringify(suite.cases));
  await writeFile(
    runnerPath,
    `import { evaluate } from ${JSON.stringify(`./${generatedPath.slice(generatedPath.lastIndexOf("/") + 1)}`)};
const cases = await Bun.file(process.argv[2] as string).json() as { id: string; input: unknown; expected: boolean | "INVALID_INPUT" }[];
const results = cases.map((test) => {
  try {
    const actual = evaluate(test.input as never);
    return { id: test.id, status: actual === test.expected ? "pass" : "fail", expected: test.expected, actual };
  } catch (error) {
    const invalid = typeof error === "object" && error !== null && "code" in error && error.code === "INVALID_INPUT";
    return { id: test.id, status: invalid && test.expected === "INVALID_INPUT" ? "pass" : "fail", expected: test.expected, error: error instanceof Error ? error.message : String(error) };
  }
});
console.log(JSON.stringify(results));
`,
  );
  const child = Bun.spawn([process.execPath, runnerPath, casesPath], {
    cwd: temporary,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: {},
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
    if (timedOut) throw new Error("generated TypeScript execution timed out");
    if (exitCode !== 0)
      throw new Error(
        `generated TypeScript execution failed: ${stderr.slice(0, 2_000)}`,
      );
    return JSON.parse(stdout) as ReturnType<typeof runCases>;
  } finally {
    clearTimeout(timeout);
  }
}

async function runPortableWasm(
  wasm: NonNullable<ModuleBuildManifest["wasm"]>,
  bytes: Uint8Array,
  suite: ModuleSuite,
) {
  const child = Bun.spawn(
    [
      process.execPath,
      resolve(import.meta.dir, "llang-module-runtime-worker.ts"),
    ],
    {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: {},
    },
  );
  child.stdin.write(
    JSON.stringify({
      wasm: Buffer.from(bytes).toString("base64"),
      wasmHash: wasm.wasmHash,
      export: wasm.export,
      contract: wasm.contract,
      cases: suite.cases,
    }),
  );
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
    if (timedOut) throw new Error("portable Wasm execution timed out");
    if (exitCode !== 0)
      throw new Error(
        `portable Wasm execution failed: ${stderr.slice(0, 2_000)}`,
      );
    return JSON.parse(stdout) as ReturnType<typeof runCases>;
  } finally {
    clearTimeout(timeout);
  }
}
export async function testModuleProgram(options: {
  entry: string;
  root: string;
  entryName: string;
  suite: string;
}) {
  const [program, suite] = await Promise.all([
    loadModuleProgram(options.entry, options.root, options.entryName),
    readModuleSuite(options.suite),
  ]);
  if (suite.interfaceHash !== program.interfaceHash)
    throw new Error("suite interfaceHash does not match program");
  const reference = runCases(suite, (input) =>
    evaluateModuleProgram(program, input),
  );
  const emitted = emitModuleWasm(program),
    runtime = await instantiateWasmPredicate(
      {
        export: "evaluate",
        contract: emitted.contract,
        wasmHash: digest(emitted.bytes),
      },
      emitted.bytes,
    ),
    wasm = runCases(suite, runtime.evaluate);
  const temporary = await mkdtemp(join(tmpdir(), "llang-module-test-"));
  try {
    const generatedTs = join(temporary, "program.generated.ts");
    await writeFile(generatedTs, emitModuleTypeScript(program));
    const typescript = await runGeneratedTypeScript(
      generatedTs,
      suite,
      temporary,
    );
    const jsonRoot = join(temporary, "jsonc");
    for (const [path, text] of emitModuleJsonc(program)) {
      const target = join(jsonRoot, path);
      await mkdir(resolve(target, ".."), { recursive: true });
      await writeFile(target, text);
    }
    const entryModule = program.entry.slice(0, program.entry.lastIndexOf("#")),
      roundTrip = await loadModuleProgram(
        `${entryModule}.llang.jsonc`,
        jsonRoot,
        options.entryName,
      );
    if (roundTrip.programHash !== program.programHash)
      throw new Error("JSONC round-trip programHash mismatch");
    const jsonc = runCases(suite, (input) =>
      evaluateModuleProgram(roundTrip, input),
    );
    const targets = { reference, typescript, jsonc, wasm },
      ok = Object.values(targets)
        .flat()
        .every((x) => x.status === "pass");
    return {
      ok,
      programHash: program.programHash,
      interfaceHash: program.interfaceHash,
      targets,
      results: reference,
    };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
export async function verifyModuleBundle(
  manifestPath: string,
  suitePath: string,
) {
  const [{ manifest, artifactBytes }, suite] = await Promise.all([
    readModuleBuildManifest(manifestPath),
    readModuleSuite(suitePath),
  ]);
  if (suite.interfaceHash !== manifest.interfaceHash)
    throw new Error("suite interfaceHash does not match bundle");
  if (!manifest.wasm)
    throw new Error("INVALID_ARTIFACT: bundle has no Wasm target");
  const bytes = artifactBytes.get(manifest.wasm.path);
  if (!bytes) throw new Error("ARTIFACT_MISMATCH: missing Wasm bytes");
  const results = await runPortableWasm(manifest.wasm, bytes, suite);
  return {
    ok: results.every((x) => x.status === "pass"),
    programHash: manifest.programHash,
    interfaceHash: manifest.interfaceHash,
    results,
  };
}
