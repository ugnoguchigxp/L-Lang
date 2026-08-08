import { basename, extname, resolve } from "node:path";

import { generatePredicate } from "./generator";
import {
  parsePredicateDefinition,
  type PredicateExpression,
} from "./ir";
import { checkSemanticClosure, type SemanticClosureReport } from "./semantic-closure";
import { explainSemanticSource } from "./semantic-explain";
import { resolveWorkspacePath, sha256 } from "./semantic-fingerprint";
import {
  runSemanticTests,
  type SemanticTestCommandResult,
  type SemanticTestCommandRunner,
} from "./semantic-test-runner";
import { scanSemanticSource } from "./semantic-source";
import { generateStaticJudgmentConstant } from "./static-judgment-generator";
import { scanStaticJudgmentSource } from "./static-judgment-source";

export type SemanticVerifyCheckStatus = "passed" | "failed" | "skipped";

export type SemanticVerifyNodeCheck = {
  id: string;
  status: SemanticVerifyCheckStatus;
  diagnostic: string | null;
};

export type SemanticVerifyReport = {
  version: 1;
  status: "passed" | "failed";
  manifest: string;
  closure: SemanticClosureReport;
  checks: {
    closure: {
      status: "passed" | "failed";
      durationMs: number;
    };
    deterministicGeneration: {
      status: SemanticVerifyCheckStatus;
      total: number;
      passed: number;
      failed: number;
      skipped: number;
      nodes: SemanticVerifyNodeCheck[];
      durationMs: number;
    };
    semanticTests: {
      status: SemanticVerifyCheckStatus;
      total: number;
      passed: number;
      failed: number;
      skipped: number;
      nodes: SemanticVerifyNodeCheck[];
      durationMs: number;
    };
    typecheck: {
      status: "passed" | "failed";
      diagnostic: string | null;
      durationMs: number;
    };
  };
  remediation: string[];
  durationMs: number;
  completedAt: string;
};

export async function verifySemanticArtifact(options: {
  manifestPath: string;
  workspaceRoot?: string;
  lockPath?: string;
  commandRunner?: SemanticTestCommandRunner;
}): Promise<SemanticVerifyReport> {
  const startedAt = Date.now();
  const workspaceRoot = resolve(options.workspaceRoot ?? process.cwd());
  const manifestPath = resolveWorkspacePath(
    workspaceRoot,
    options.manifestPath,
    "Semantic Closure manifest",
  );
  const commandRunner = options.commandRunner ?? runCommand;

  const closureStartedAt = Date.now();
  const closure = await checkSemanticClosure({
    manifestPath,
    workspaceRoot,
    ...(options.lockPath === undefined ? {} : { lockPath: options.lockPath }),
  });
  const closureCheck = {
    status: closure.status === "closed" ? "passed" as const : "failed" as const,
    durationMs: Date.now() - closureStartedAt,
  };

  const deterministicStartedAt = Date.now();
  const deterministicNodes: SemanticVerifyNodeCheck[] = [];
  for (const node of closure.nodes) {
    if (
      node.semanticStatus !== "current" ||
      node.generated?.state !== "verified"
    ) {
      deterministicNodes.push({
        id: node.id,
        status: "skipped",
        diagnostic: "current verified lock and generated output are required",
      });
      continue;
    }
    try {
      const sourcePath = resolve(workspaceRoot, node.source);
      const explanation = await explainSemanticSource({
        sourcePath,
        workspaceRoot,
        ...(options.lockPath === undefined ? {} : { lockPath: options.lockPath }),
      });
      const generated =
        explanation.kind === "predicate"
          ? await regeneratePredicate(sourcePath, explanation.resolution?.ir ?? null)
          : await regenerateStaticJudgment(
              sourcePath,
              explanation.resolution?.value ?? null,
            );
      const actualHash = sha256(generated);
      deterministicNodes.push(
        actualHash === node.generated.expectedHash
          ? { id: node.id, status: "passed", diagnostic: null }
          : {
              id: node.id,
              status: "failed",
              diagnostic: `deterministic hash mismatch: expected ${node.generated.expectedHash}, received ${actualHash}`,
            },
      );
    } catch (error) {
      deterministicNodes.push({
        id: node.id,
        status: "failed",
        diagnostic: errorMessage(error),
      });
    }
  }
  const deterministicGeneration = aggregateNodeChecks(
    deterministicNodes,
    Date.now() - deterministicStartedAt,
  );

  const semanticTestsStartedAt = Date.now();
  const semanticTestNodes: SemanticVerifyNodeCheck[] = [];
  for (const node of closure.nodes) {
    if (node.kind === "static-judgment") {
      semanticTestNodes.push({
        id: node.id,
        status: "skipped",
        diagnostic: "Static Judgment has no runtime Semantic Test contract",
      });
      continue;
    }
    if (
      node.semanticStatus !== "current" ||
      node.generated?.state !== "verified"
    ) {
      semanticTestNodes.push({
        id: node.id,
        status: "skipped",
        diagnostic: "current verified generated output is required",
      });
      continue;
    }
    const result = await runSemanticTests({
      sourcePath: resolve(workspaceRoot, node.source),
      workspaceRoot,
      ...(options.lockPath === undefined ? {} : { lockPath: options.lockPath }),
      commandRunner,
    });
    semanticTestNodes.push({
      id: node.id,
      status: result.status,
      diagnostic: result.diagnostic,
    });
  }
  const semanticTests = aggregateNodeChecks(
    semanticTestNodes,
    Date.now() - semanticTestsStartedAt,
  );

  const typecheckStartedAt = Date.now();
  const typecheckResult = await commandRunner(
    ["bun", "run", "typecheck"],
    workspaceRoot,
  );
  const typecheck = {
    status: typecheckResult.exitCode === 0 ? "passed" as const : "failed" as const,
    diagnostic:
      typecheckResult.exitCode === 0
        ? null
        : commandDiagnostic(typecheckResult, "TypeScript typecheck failed"),
    durationMs: Date.now() - typecheckStartedAt,
  };

  const status =
    closureCheck.status === "passed" &&
    deterministicGeneration.failed === 0 &&
    deterministicGeneration.skipped === 0 &&
    semanticTests.failed === 0 &&
    typecheck.status === "passed"
      ? "passed"
      : "failed";
  const remediation = buildRemediation({
    closure: closureCheck.status,
    deterministicGeneration,
    semanticTests,
    typecheck: typecheck.status,
  });
  return {
    version: 1,
    status,
    manifest: closure.manifest,
    closure,
    checks: {
      closure: closureCheck,
      deterministicGeneration,
      semanticTests,
      typecheck,
    },
    remediation,
    durationMs: Date.now() - startedAt,
    completedAt: new Date().toISOString(),
  };
}

function buildRemediation(input: {
  closure: "passed" | "failed";
  deterministicGeneration: SemanticVerifyReport["checks"]["deterministicGeneration"];
  semanticTests: SemanticVerifyReport["checks"]["semanticTests"];
  typecheck: "passed" | "failed";
}): string[] {
  const remediation: string[] = [];
  if (input.closure === "failed") {
    remediation.push(
      "Run semantic closure for the manifest and resolve every open or verification-required node.",
    );
  }
  if (input.deterministicGeneration.failed > 0) {
    remediation.push(
      "Restore the locked generated artifact or rebuild the affected semantic source.",
    );
  }
  if (input.semanticTests.failed > 0) {
    remediation.push(
      "Fix the failing Semantic Test cases or regenerate the affected Predicate.",
    );
  }
  if (input.typecheck === "failed") {
    remediation.push("Run bun run typecheck and fix the reported TypeScript errors.");
  }
  return remediation;
}

async function regeneratePredicate(
  sourcePath: string,
  expression: PredicateExpression | null,
): Promise<string> {
  if (expression === null) {
    throw new Error("locked Predicate IR is unavailable");
  }
  const source = await scanSemanticSource(sourcePath);
  return generatePredicate(
    parsePredicateDefinition({
      version: 1,
      name: source.predicate.name,
      description: source.concept.specification,
      input: {
        parameter: source.predicate.parameterName,
        type: source.concept.typeName,
        module: `./${basename(source.absolutePath, extname(source.absolutePath))}`,
      },
      returns: "boolean",
      body: expression,
    }),
  );
}

async function regenerateStaticJudgment(
  sourcePath: string,
  value: boolean | null,
): Promise<string> {
  if (value === null) {
    throw new Error("locked Static Judgment value is unavailable");
  }
  const source = await scanStaticJudgmentSource(sourcePath);
  return generateStaticJudgmentConstant(source.judgment.name, value);
}

function aggregateNodeChecks(
  nodes: SemanticVerifyNodeCheck[],
  durationMs: number,
): SemanticVerifyReport["checks"]["deterministicGeneration"] {
  const passed = countChecks(nodes, "passed");
  const failed = countChecks(nodes, "failed");
  const skipped = countChecks(nodes, "skipped");
  return {
    status:
      failed > 0
        ? "failed"
        : skipped === nodes.length
          ? "skipped"
          : "passed",
    total: nodes.length,
    passed,
    failed,
    skipped,
    nodes,
    durationMs,
  };
}

function countChecks(
  nodes: SemanticVerifyNodeCheck[],
  status: SemanticVerifyCheckStatus,
): number {
  return nodes.filter((node) => node.status === status).length;
}

async function runCommand(
  command: string[],
  cwd: string,
): Promise<SemanticTestCommandResult> {
  const child = Bun.spawn(command, {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stdout, stderr };
}

function commandDiagnostic(
  result: SemanticTestCommandResult,
  fallback: string,
): string {
  const text = (result.stderr.trim() || result.stdout.trim()).slice(0, 4_000);
  return text.length === 0 ? fallback : text;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
