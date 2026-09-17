import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import ts from "typescript";

import { canonicalJson, HybridArtifactError } from "./hybrid-artifact-values";
import {
  hybridTypeScriptConfig,
  parseHybridTypeScriptProfile,
  type HybridTypeScriptProfile,
} from "./hybrid-typescript-profile";
import {
  importTypeScriptPredicate,
  type ImportedTypeScriptPredicate,
} from "./typescript-predicate-importer";

export function assertClosedHybridSource(sourceText: string): void {
  const source = ts.createSourceFile(
    "source.ts",
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  if (
    source.referencedFiles.length > 0 ||
    source.typeReferenceDirectives.length > 0 ||
    source.libReferenceDirectives.length > 0
  ) {
    unsupported("reference directives are not supported in artifacts");
  }
  let forbidden: string | undefined;
  const visit = (node: ts.Node): void => {
    if (forbidden !== undefined) return;
    if (
      ts.isImportDeclaration(node) ||
      ts.isImportEqualsDeclaration(node) ||
      ts.isExportDeclaration(node) ||
      (ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword)
    ) {
      forbidden = ts.SyntaxKind[node.kind];
      return;
    }
    if (
      ts.isModuleDeclaration(node) &&
      (ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Ambient) !== 0
    ) {
      forbidden = "ambient module";
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (forbidden !== undefined) {
    unsupported(`${forbidden} is not supported in artifact source`);
  }
}

export async function importIsolatedHybridPredicate(input: {
  source: Uint8Array;
  functionName: string;
  profile: HybridTypeScriptProfile;
}): Promise<ImportedTypeScriptPredicate> {
  const profile = parseHybridTypeScriptProfile(input.profile);
  if (profile.typescriptVersion !== ts.version) {
    throw new HybridArtifactError(
      "TOOLCHAIN_MISMATCH",
      "TypeScript version differs from artifact profile",
    );
  }
  let sourceText: string;
  try {
    sourceText = new TextDecoder("utf-8", { fatal: true }).decode(input.source);
  } catch (error) {
    unsupported("artifact source must be valid UTF-8", error);
  }
  assertClosedHybridSource(sourceText);
  const directory = await mkdtemp(join(tmpdir(), "l-lang-hybrid-import-"));
  try {
    await writeFile(resolve(directory, "source.ts"), input.source, {
      flag: "wx",
    });
    await writeFile(
      resolve(directory, "tsconfig.json"),
      canonicalJson(hybridTypeScriptConfig(profile)),
      { flag: "wx" },
    );
    return await importTypeScriptPredicate({
      workspaceRoot: directory,
      sourcePath: resolve(directory, "source.ts"),
      functionName: input.functionName,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function unsupported(message: string, cause?: unknown): never {
  throw new HybridArtifactError("INVALID_ARTIFACT", message, { cause });
}
