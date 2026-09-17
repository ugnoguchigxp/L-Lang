import { resolve } from "node:path";

import { verifyImportedPredicateArtifact } from "./hybrid-artifact";
import { buildImportedPredicateArtifact } from "./hybrid-artifact-builder";
import { rebuildVerifyImportedPredicateArtifact } from "./hybrid-artifact-rebuild";
import { HybridArtifactError } from "./hybrid-artifact-values";
import {
  importTypeScriptPredicate,
  TypeScriptImportError,
} from "./typescript-predicate-importer";
import { resolveContainedFile } from "./contained-path";

export async function runHybridCli(
  args: string[],
  workspaceRoot = process.cwd(),
): Promise<unknown> {
  const command = args[0];
  if (command === "inspect-ts") {
    const [, sourcePath, option, functionName] = args;
    if (
      args.length !== 4 ||
      sourcePath === undefined ||
      option !== "--function" ||
      functionName === undefined
    ) {
      throw usage("hybrid inspect-ts <source.ts> --function <export-name>");
    }
    const result = await importTypeScriptPredicate({
      workspaceRoot,
      sourcePath: resolve(workspaceRoot, sourcePath),
      functionName,
    });
    return { ...result, apiCalls: 0, writes: 0 };
  }
  if (command === "build-ts") {
    const [, sourcePath, functionOption, functionName, outOption, output] =
      args;
    if (
      args.length !== 6 ||
      sourcePath === undefined ||
      functionOption !== "--function" ||
      functionName === undefined ||
      outOption !== "--out" ||
      output === undefined
    ) {
      throw usage(
        "hybrid build-ts <source.ts> --function <export-name> --out <new-directory>",
      );
    }
    return buildImportedPredicateArtifact({
      workspaceRoot,
      sourcePath: resolve(workspaceRoot, sourcePath),
      functionName,
      outputDirectory: resolve(workspaceRoot, output),
    });
  }
  if (command === "verify-artifact") {
    const [, manifest, rebuild] = args;
    if (
      (args.length !== 2 && args.length !== 3) ||
      manifest === undefined ||
      (rebuild !== undefined && rebuild !== "--rebuild")
    ) {
      throw usage("hybrid verify-artifact <artifact.json> [--rebuild]");
    }
    const manifestPath = await resolveContainedFile(
      workspaceRoot,
      resolve(workspaceRoot, manifest),
      "hybrid artifact manifest",
      { rejectSymbolicLinks: true },
    );
    return rebuild === "--rebuild"
      ? rebuildVerifyImportedPredicateArtifact(manifestPath)
      : verifyImportedPredicateArtifact(manifestPath);
  }
  throw usage(
    "hybrid <inspect-ts|build-ts|verify-artifact> (run a command with its required arguments)",
  );
}

function usage(message: string): HybridArtifactError {
  return new HybridArtifactError("INVALID_ARGUMENT", `usage: ${message}`);
}

if (import.meta.main) {
  try {
    console.log(
      JSON.stringify(await runHybridCli(process.argv.slice(2)), null, 2),
    );
  } catch (error) {
    console.error(publicHybridErrorMessage(error));
    process.exitCode = 1;
  }
}

function publicHybridErrorMessage(error: unknown): string {
  if (
    error instanceof HybridArtifactError ||
    error instanceof TypeScriptImportError
  ) {
    return error.message;
  }
  return "HYBRID_OPERATION_FAILED: operation could not be completed";
}
