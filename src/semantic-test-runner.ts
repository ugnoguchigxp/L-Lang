import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { renderSemanticTestModule } from "./judgement-renderer";
import { explainSemanticSource } from "./semantic-explain";
import {
  generatedOutputPath,
  resolveWorkspacePath,
  workspaceRelativePath,
} from "./semantic-fingerprint";
import { scanSemanticSource } from "./semantic-source";
import { detectSemanticSourceKind } from "./semantic-source-kind";

export type SemanticTestCommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type SemanticTestCommandRunner = (
  command: string[],
  cwd: string,
) => Promise<SemanticTestCommandResult>;

export type SemanticTestRunResult = {
  version: 1;
  status: "passed" | "failed";
  source: string;
  predicate: string;
  generated: string;
  diagnostic: string | null;
  durationMs: number;
};

export async function runSemanticTests(options: {
  sourcePath: string;
  workspaceRoot?: string;
  lockPath?: string;
  commandRunner?: SemanticTestCommandRunner;
}): Promise<SemanticTestRunResult> {
  const startedAt = Date.now();
  const workspaceRoot = resolve(options.workspaceRoot ?? process.cwd());
  const sourcePath = resolveWorkspacePath(
    workspaceRoot,
    options.sourcePath,
    "semantic source",
  );
  if ((await detectSemanticSourceKind(sourcePath)) === "static-judgment") {
    throw new Error("Static Judgment has no runtime Semantic Test contract");
  }

  const explanation = await explainSemanticSource({
    sourcePath,
    workspaceRoot,
    ...(options.lockPath === undefined ? {} : { lockPath: options.lockPath }),
  });
  if (
    explanation.kind !== "predicate" ||
    explanation.status !== "current" ||
    explanation.generated?.state !== "verified"
  ) {
    throw new Error(
      `semantic test requires a current verified Predicate; found ${explanation.status}`,
    );
  }

  const source = await scanSemanticSource(sourcePath);
  const generatedPath = generatedOutputPath(
    source.absolutePath,
    source.predicate.name,
  );
  const temporaryDirectory = await mkdtemp(
    resolve(tmpdir(), "l-lang-semantic-test-"),
  );
  const temporaryTestPath = resolve(
    temporaryDirectory,
    `${randomUUID()}.semantic.test.ts`,
  );
  try {
    const testModule = renderSemanticTestModule({
      candidateModuleName: basename(generatedPath, ".ts"),
      candidateModuleSpecifier: pathToFileURL(generatedPath).href,
      predicateName: source.predicate.name,
      acceptSource: source.tests.acceptSource,
      rejectSource: source.tests.rejectSource,
      boundarySource: source.tests.boundarySource,
      counterfactualSource: source.tests.counterfactualSource,
      invarianceSource: source.tests.invarianceSource,
    });
    await writeFile(temporaryTestPath, testModule, "utf8");
    const result = await (options.commandRunner ?? runCommand)(
      ["bun", "test", temporaryTestPath],
      workspaceRoot,
    );
    return {
      version: 1,
      status: result.exitCode === 0 ? "passed" : "failed",
      source: workspaceRelativePath(
        workspaceRoot,
        source.absolutePath,
        "semantic source",
      ),
      predicate: source.predicate.name,
      generated: workspaceRelativePath(
        workspaceRoot,
        generatedPath,
        "generated output",
      ),
      diagnostic:
        result.exitCode === 0
          ? null
          : conciseDiagnostic(result.stderr, result.stdout, result.exitCode),
      durationMs: Date.now() - startedAt,
    };
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
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

function conciseDiagnostic(
  stderr: string,
  stdout: string,
  exitCode: number,
): string {
  const details = [stderr.trim(), stdout.trim()]
    .filter((part) => part.length > 0)
    .join("\n");
  return details.length === 0
    ? `Semantic Test failed with exit code ${exitCode}`
    : `Semantic Test failed with exit code ${exitCode}\n${details}`.slice(
        0,
        4_000,
      );
}
