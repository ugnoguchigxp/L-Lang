import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { generatePredicate } from "../../src/generator";
import { buildLlangProgram, readLlangArtifact } from "../../src/llang-build";
import { checkLlangProgram } from "../../src/llang-program";
import { importTypeScriptPredicate } from "../../src/typescript-predicate-importer";
import { digest } from "../../src/wasm-contract";
import { loadRelease } from "./consumer";

const oracle = [
  { input: { enabled: false, suspended: false }, expected: false },
  { input: { enabled: false, suspended: true }, expected: false },
  { input: { enabled: true, suspended: false }, expected: true },
  { input: { enabled: true, suspended: true }, expected: false },
];

/** All four routes share one requirement and an independently written truth table. */
export async function runMatrix(outputDirectory: string) {
  const root = resolve(outputDirectory);
  await mkdir(root); // Refuse to overwrite an earlier measurement or release.
  const rows = [];
  for (const sourceKind of ["typescript", "jsonc"] as const) {
    const sourcePath = resolve(
      import.meta.dir,
      sourceKind === "typescript" ? "predicate.ts" : "predicate.llang.jsonc",
    );
    const text = await readFile(sourcePath, "utf8");
    const beforeText = await readFile(
      resolve(
        import.meta.dir,
        sourceKind === "typescript"
          ? "predicate.before.ts"
          : "predicate.before.llang.jsonc",
      ),
      "utf8",
    );
    const change = lineChange(beforeText, text);
    const started = performance.now();
    const imported =
      sourceKind === "typescript"
        ? await importTypeScriptPredicate({
            workspaceRoot: resolve(import.meta.dir, "../.."),
            sourcePath,
            functionName: "evaluate",
          })
        : null;
    const checked =
      sourceKind === "jsonc"
        ? checkLlangProgram(text, sourcePath).checked
        : null;
    if (imported && imported.source.sourceHash !== digest(text))
      throw new Error("TypeScript source changed during import");
    const contract = imported?.contract ?? checked?.program.contract;
    const body = imported?.body ?? checked?.program.body;
    if (!contract || !body) throw new Error("invalid example source");
    const parseMs = performance.now() - started;
    // Normalize both authoring routes into the same validated predicate profile.
    const staging = resolve(root, `${sourceKind}-build`);
    await mkdir(staging);
    const normalized = resolve(staging, "predicate.llang.jsonc");
    await writeFile(
      normalized,
      JSON.stringify({
        language: "l-lang",
        version: 1,
        id: "enabled-user",
        profile: "predicate-i32-v1",
        description: "Enabled and not suspended",
        contract,
        body,
      }),
    );
    for (const target of ["typescript", "wasm"] as const) {
      const buildStart = performance.now();
      const work = resolve(staging, target);
      await mkdir(work);
      let build: unknown = null;
      const filename =
        target === "typescript" ? "predicate.generated.ts" : "predicate.wasm";
      if (target === "typescript") {
        const generated = generatePredicate({
          version: 1,
          name: "evaluate",
          description: "Enabled and not suspended",
          input: { parameter: "user", type: "User", module: "./contract" },
          returns: "boolean",
          body,
        });
        // This example intentionally uses a closed two-boolean contract.
        const standalone = generated.replace(
          'import type { User } from "./contract";',
          "type User = { enabled: boolean; suspended: boolean };",
        );
        await writeFile(resolve(work, filename), standalone);
      } else {
        const built = await buildLlangProgram(
          normalized,
          resolve(work, "build"),
        );
        const artifact = await readLlangArtifact(built.manifest);
        build = artifact.manifest;
        await writeFile(resolve(work, filename), artifact.bytes);
        await rm(resolve(work, "build"), { recursive: true });
      }
      const bytes = await readFile(resolve(work, filename));
      const release = {
        version: 1,
        sourceKind,
        target,
        sourceHash: digest(text),
        contract,
        artifactHash: digest(bytes),
        build,
      };
      await writeFile(
        resolve(work, "release.json"),
        JSON.stringify(release, null, 2),
      );
      const bundled = await Bun.build({
        entrypoints: [resolve(import.meta.dir, "consumer.ts")],
        outdir: work,
        naming: "consumer.js",
        target: "bun",
      });
      if (!bundled.success) throw new Error(bundled.logs.join("\n"));
      const buildMs = performance.now() - buildStart;
      const deployed = resolve(root, `${sourceKind}-to-${target}`);
      await cp(work, deployed, { recursive: true });
      await rm(work, { recursive: true });
      const evaluate = await loadRelease(deployed);
      for (const item of oracle)
        if (evaluate(item.input) !== item.expected)
          throw new Error(`oracle mismatch: ${sourceKind}/${target}`);
      for (const input of [
        {},
        { enabled: "yes", suspended: false },
        { enabled: null, suspended: false },
      ]) {
        let rejected = false;
        try {
          evaluate(input);
        } catch {
          rejected = true;
        }
        if (!rejected) throw new Error("invalid input accepted");
      }
      const runtimeStart = performance.now();
      for (let i = 0; i < 10000; i++)
        evaluate(oracle[i % oracle.length]?.input);
      const runtimeMs = performance.now() - runtimeStart;
      const child = Bun.spawn(
        [
          process.execPath,
          resolve(deployed, "consumer.js"),
          JSON.stringify(oracle[2]?.input),
        ],
        { cwd: deployed, stdout: "pipe", stderr: "pipe" },
      );
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      if (code !== 0 || JSON.parse(stdout).value !== true)
        throw new Error(`portable consumer failed: ${stderr}`);
      rows.push({
        sourceKind,
        target,
        sourceBytes: Buffer.byteLength(text),
        change,
        artifactBytes: bytes.length,
        consumerBytes: (await readFile(resolve(deployed, "consumer.js")))
          .length,
        parseMs,
        buildMs,
        runtimeMs,
        iterations: 10000,
        oracleCases: oracle.length,
        invalidCases: 3,
        portable: true,
        apiCalls: 0,
        sourceHash: digest(text),
        artifactHash: digest(bytes),
      });
    }
    await rm(staging, { recursive: true });
  }
  const report = {
    version: 1,
    bun: Bun.version,
    platform: process.platform,
    architecture: process.arch,
    measuredAt: new Date().toISOString(),
    scope:
      "Single-run local demonstration; timings include warmup and are not a statistical benchmark. Human editing time is not measured.",
    rows,
  };
  await writeFile(
    resolve(root, "comparison.json"),
    JSON.stringify(report, null, 2),
  );
  return report;
}

if (import.meta.main)
  console.log(
    JSON.stringify(
      await runMatrix(process.argv[2] ?? "artifacts/source-output-matrix"),
      null,
      2,
    ),
  );

// LCS counts inserted/deleted lines; formatting is deliberately included in this authoring comparison.
function lineChange(before: string, after: string) {
  const a = before.trimEnd().split("\n"),
    b = after.trimEnd().split("\n");
  const table = Array.from({ length: a.length + 1 }, () =>
    Array<number>(b.length + 1).fill(0),
  );
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) {
      const row = table[i] as number[],
        previous = table[i - 1] as number[];
      row[j] =
        a[i - 1] === b[j - 1]
          ? (previous[j - 1] ?? 0) + 1
          : Math.max(previous[j] ?? 0, row[j - 1] ?? 0);
    }
  const common = table[a.length]?.[b.length] ?? 0;
  return {
    addedLines: b.length - common,
    removedLines: a.length - common,
    beforeBytes: Buffer.byteLength(before),
    afterBytes: Buffer.byteLength(after),
  };
}
