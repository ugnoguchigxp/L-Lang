import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";

import {
  loadImportedPredicateArtifact,
  verifyImportedPredicateArtifact,
} from "../../src/hybrid-artifact";
import { buildImportedPredicateArtifact } from "../../src/hybrid-artifact-builder";
import { rebuildVerifyImportedPredicateArtifact } from "../../src/hybrid-artifact-rebuild";
import { HYBRID_WASM_SCENARIOS, type HybridWasmScenario } from "./scenarios";

const repo = resolve(import.meta.dir, "../..");

export interface HybridWasmScenarioResult {
  id: string;
  level: number;
  title: string;
  demonstrates: string;
  artifactHash: string;
  semanticHash: string;
  wasmHash: string;
  portableVerification: "passed";
  rebuildVerification: "passed";
  cases: Array<{
    name: string;
    expected: boolean;
    actual: boolean;
    status: "passed";
  }>;
}

export async function runHybridWasmScenarios(
  scenarioId?: string,
): Promise<HybridWasmScenarioResult[]> {
  const scenarios = selectScenarios(scenarioId);
  const temporary = await mkdtemp(resolve(repo, ".tmp-hybrid-wasm-demo-"));
  try {
    const results: HybridWasmScenarioResult[] = [];
    for (const scenario of scenarios) {
      results.push(await runScenario(scenario, temporary));
    }
    return results;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

function selectScenarios(scenarioId?: string): HybridWasmScenario[] {
  if (scenarioId === undefined) return HYBRID_WASM_SCENARIOS;
  const scenario = HYBRID_WASM_SCENARIOS.find(({ id }) => id === scenarioId);
  if (scenario === undefined) {
    throw new Error(
      `unknown scenario ${JSON.stringify(scenarioId)}; expected one of ${HYBRID_WASM_SCENARIOS.map(({ id }) => id).join(", ")}`,
    );
  }
  return [scenario];
}

async function runScenario(
  scenario: HybridWasmScenario,
  temporary: string,
): Promise<HybridWasmScenarioResult> {
  const built = await buildImportedPredicateArtifact({
    workspaceRoot: repo,
    sourcePath: resolve(repo, scenario.source),
    functionName: scenario.functionName,
    outputDirectory: resolve(temporary, scenario.id),
  });
  const portable = await verifyImportedPredicateArtifact(built.manifest);
  const rebuilt = await rebuildVerifyImportedPredicateArtifact(built.manifest);
  const runtime = await loadImportedPredicateArtifact(built.manifest);
  const cases = scenario.cases.map((testCase) => {
    const actual = runtime.evaluate(testCase.input);
    if (actual !== testCase.expected) {
      throw new Error(
        `${scenario.id}/${testCase.name}: expected ${testCase.expected}, received ${actual}`,
      );
    }
    return {
      name: testCase.name,
      expected: testCase.expected,
      actual,
      status: "passed" as const,
    };
  });
  return {
    id: scenario.id,
    level: scenario.level,
    title: scenario.title,
    demonstrates: scenario.demonstrates,
    artifactHash: built.artifactHash,
    semanticHash: built.semanticHash,
    wasmHash: built.wasmHash,
    portableVerification: portable.status,
    rebuildVerification: rebuilt.status,
    cases,
  };
}

if (import.meta.main) {
  try {
    const [scenarioId, ...extra] = process.argv.slice(2);
    if (extra.length > 0) {
      throw new Error("usage: bun run hybrid:demo [scenario-id]");
    }
    const scenarios = await runHybridWasmScenarios(scenarioId);
    console.log(
      JSON.stringify(
        {
          version: 1,
          profile: "predicate-i32-v1",
          status: "passed",
          scenarioCount: scenarios.length,
          caseCount: scenarios.reduce(
            (total, scenario) => total + scenario.cases.length,
            0,
          ),
          apiCalls: 0,
          retainedArtifacts: 0,
          scenarios,
        },
        null,
        2,
      ),
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
