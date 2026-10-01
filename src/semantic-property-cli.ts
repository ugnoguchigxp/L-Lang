import { randomUUID } from "node:crypto";
import { mkdir, open, rm, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { validatePredicateContext } from "./context-validator";
import { generatePredicate } from "./generator";
import { parsePredicateDefinition, parsePredicateExpression } from "./ir";
import { renderSemanticTestModule } from "./judgement-renderer";
import { buildProjectContext } from "./project-context";
import { compileSemanticContract } from "./semantic-contract";
import {
  predicateSemanticHashes,
  workspaceRelativePath,
} from "./semantic-fingerprint";
import {
  assertTextByteLength,
  readBoundedJsonFile,
  SEMANTIC_LIMITS,
} from "./semantic-limits";
import { findReplayEntry, readSemanticLock } from "./semantic-lock";
import {
  parsePropertyTestConfig,
  replayPropertyTest,
  runPropertyTest,
} from "./semantic-property-test";
import { scanSemanticSource } from "./semantic-source";
import { verifySemanticTddSource } from "./semantic-tdd-verify";
import { validateSemanticTestPlan } from "./semantic-test-ir";
import {
  findSemanticTestEntry,
  readSemanticTestLock,
} from "./semantic-test-lock";

async function main(): Promise<void> {
  const [command, target, ...args] = Bun.argv.slice(2);
  if (target === undefined || (command !== "check" && command !== "replay"))
    throw new Error(
      "Usage: bun run semantic:property check <source.ts> --config <property.json> [--candidate <expression.json>] --out <report.json> | replay <report.json>",
    );
  if (command === "replay") {
    if (args.length) throw new Error("property replay accepts no options");
    const report = replayPropertyTest(
      await readBoundedJsonFile(resolve(target), "property report"),
    );
    console.log(
      JSON.stringify(
        {
          status: report.status,
          checked: report.checked,
          counterexample: report.counterexample,
          apiCalls: 0,
          filesWritten: 0,
        },
        null,
        2,
      ),
    );
    process.exitCode = report.status === "passed" ? 0 : 1;
    return;
  }
  const options = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i];
    const value = args[i + 1];
    if (
      name === undefined ||
      !["--config", "--candidate", "--out"].includes(name) ||
      value === undefined ||
      value.startsWith("--") ||
      options.has(name)
    )
      throw new Error("invalid/duplicate property option");
    options.set(name, value);
  }
  const configPath = options.get("--config");
  const outPath = options.get("--out");
  if (configPath === undefined || outPath === undefined)
    throw new Error("property check requires --config and --out");
  const workspaceRoot = process.cwd();
  const source = await scanSemanticSource(resolve(target));
  const contract = compileSemanticContract(source);
  const sourceRelative = workspaceRelativePath(
    workspaceRoot,
    source.absolutePath,
    "source",
  );
  const entry = findSemanticTestEntry(
    await readSemanticTestLock(resolve(workspaceRoot, "semantic-test.lock")),
    {
      source: sourceRelative,
      conceptId: source.concept.id,
      contractHash: contract.contractHash,
    },
  );
  if (entry === undefined)
    throw new Error(
      "property check requires a frozen Test Plan; run tdd-build first",
    );
  validateSemanticTestPlan(
    entry.plan,
    contract.contract,
    contract.contractHash,
  );
  const config = parsePropertyTestConfig(
    await readBoundedJsonFile(resolve(configPath), "property config"),
  );
  validatePredicateContext(config.expected, source);
  const candidatePath = options.get("--candidate");
  let expression: import("./ir").PredicateExpression;
  if (candidatePath !== undefined)
    expression = parsePredicateExpression(
      await readBoundedJsonFile(resolve(candidatePath), "candidate IR"),
    );
  else {
    await verifySemanticTddSource({
      sourcePath: source.absolutePath,
      workspaceRoot,
    });
    const lock = await readSemanticLock(
      resolve(workspaceRoot, "semantic.lock"),
    );
    const context = await buildProjectContext({ source, workspaceRoot, lock });
    const implementation = findReplayEntry(lock, {
      source: sourceRelative,
      predicate: source.predicate.name,
      conceptId: source.concept.id,
      ...predicateSemanticHashes(source, context),
    });
    if (implementation === undefined)
      throw new Error("missing current implementation");
    expression = implementation.resolvedIr;
  }
  validatePredicateContext(expression, source);
  const report = runPropertyTest({
    schema: source.concept.typeSchema,
    config,
    expression,
    plan: entry.plan,
  });
  // Check expected IR against source examples using the same generated test module as build.
  const stem = `.property-expected-${randomUUID()}`;
  const modulePath = resolve(dirname(source.absolutePath), `${stem}.ts`);
  const testPath = resolve(dirname(source.absolutePath), `${stem}.test.ts`);
  try {
    const definition = parsePredicateDefinition({
      version: 1,
      name: source.predicate.name,
      description: source.concept.specification,
      input: {
        parameter: source.predicate.parameterName,
        type: source.concept.typeName,
        module: `./${basename(source.absolutePath, ".ts")}`,
      },
      returns: "boolean",
      body: config.expected,
    });
    await writeFile(modulePath, generatePredicate(definition), { flag: "wx" });
    await writeFile(
      testPath,
      renderSemanticTestModule({
        candidateModuleName: stem,
        predicateName: source.predicate.name,
        acceptSource: source.tests.acceptSource,
        rejectSource: source.tests.rejectSource,
        boundarySource: source.tests.boundarySource,
        counterfactualSource: source.tests.counterfactualSource,
        invarianceSource: source.tests.invarianceSource,
      }),
      { flag: "wx" },
    );
    const child = Bun.spawn([process.execPath, "test", testPath], {
      cwd: workspaceRoot,
      stdout: "ignore",
      stderr: "pipe",
    });
    // Drain while running so a failure cannot deadlock on a full pipe.
    const diagnostics = new Response(child.stderr).text();
    let timedOut = false;
    const timeout = setTimeout(
      () => {
        timedOut = true;
        child.kill("SIGKILL");
      },
      config.version === 2 ? config.timeoutMs : 120000,
    );
    const exitCode = await child.exited;
    clearTimeout(timeout);
    if (timedOut) {
      await diagnostics;
      throw new Error("property source-example timeout exceeded");
    }
    if (exitCode !== 0)
      throw new Error(
        `property expected expression contradicts source examples: ${await diagnostics}`,
      );
    await diagnostics;
  } finally {
    await rm(modulePath, { force: true });
    await rm(testPath, { force: true });
  }
  const text = `${JSON.stringify(report, null, 2)}\n`;
  assertTextByteLength(
    text,
    SEMANTIC_LIMITS.externalJsonBytes,
    "property report",
  );
  const absoluteOutput = resolve(outPath);
  await mkdir(dirname(absoluteOutput), { recursive: true });
  const handle = await open(absoluteOutput, "wx", 0o600);
  try {
    await handle.writeFile(text);
  } finally {
    await handle.close();
  }
  console.log(
    JSON.stringify(
      {
        status: report.status,
        checked: report.checked,
        counterexample: report.counterexample,
        report: absoluteOutput,
        apiCalls: 0,
      },
      null,
      2,
    ),
  );
  process.exitCode = report.status === "passed" ? 0 : 1;
}

if (import.meta.main)
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  });
