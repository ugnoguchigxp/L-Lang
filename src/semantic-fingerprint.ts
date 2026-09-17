import { dirname, relative, resolve } from "node:path";

import { PREDICATE_PROMPT_VERSION } from "./openai";
import type { ProjectContext } from "./project-context";
import type { SemanticSource } from "./semantic-source";
import { STATIC_JUDGMENT_PROMPT_VERSION } from "./static-judgment";
import type { StaticJudgmentSource } from "./static-judgment-source";
import { sha256, stableJson } from "./stable-hash";

export { fingerprintFor, sha256, stableJson } from "./stable-hash";

export type PredicateSemanticHashes = {
  conceptHash: string;
  sourceHash: string;
  typeHash: string;
  testHash: string;
  promptHash: string;
  contextVersion: 1;
  contextHash: string;
};

export const TYPE_ONLY_CONTEXT_HASH = sha256("project-context-v1:none");

export type StaticJudgmentSemanticHashes = {
  conceptHash: string;
  valueHash: string;
  promptHash: string;
};

export function predicateRequestShape(source: SemanticSource): {
  specification: string;
  typeScriptSource: string;
  target: {
    functionName: string;
    parameterName: string;
    typeName: string;
  };
} {
  return {
    specification: source.concept.specification,
    typeScriptSource: source.concept.typeDeclaration,
    target: {
      functionName: source.predicate.name,
      parameterName: source.predicate.parameterName,
      typeName: source.concept.typeName,
    },
  };
}

export function predicateSemanticHashes(
  source: SemanticSource,
  projectContext?: {
    context: ProjectContext;
    contextHash: string;
  },
): PredicateSemanticHashes {
  const requestShape = predicateRequestShape(source);
  const contextHash = projectContext?.contextHash ?? TYPE_ONLY_CONTEXT_HASH;
  return {
    conceptHash: source.concept.hash,
    sourceHash: sha256(source.sourceText),
    typeHash: sha256(
      stableJson({
        declaration: source.concept.typeDeclaration,
        schema: source.concept.typeSchema,
      }),
    ),
    testHash: sha256(
      stableJson({
        accept: source.tests.acceptSource,
        reject: source.tests.rejectSource,
        boundary: source.tests.boundarySource,
        counterfactual: source.tests.counterfactualSource,
        invariance: source.tests.invarianceSource,
      }),
    ),
    promptHash: sha256(
      stableJson({
        version: PREDICATE_PROMPT_VERSION,
        ...requestShape,
        projectContext: projectContext?.context ?? null,
      }),
    ),
    contextVersion: 1,
    contextHash,
  };
}

export function staticJudgmentRequestShape(source: StaticJudgmentSource): {
  conceptId: string;
  conceptSpecification: string;
  staticValue: string;
  judgmentName: string;
} {
  return {
    conceptId: source.concept.id,
    conceptSpecification: source.concept.specification,
    staticValue: source.value.text,
    judgmentName: source.judgment.name,
  };
}

export function staticJudgmentSemanticHashes(
  source: StaticJudgmentSource,
): StaticJudgmentSemanticHashes {
  const requestShape = staticJudgmentRequestShape(source);
  return {
    conceptHash: source.concept.hash,
    valueHash: sha256(source.value.text),
    promptHash: sha256(
      stableJson({
        version: STATIC_JUDGMENT_PROMPT_VERSION,
        ...requestShape,
      }),
    ),
  };
}

export function normalizePath(value: string): string {
  return value.replaceAll("\\", "/");
}

export function workspaceRelativePath(
  workspaceRoot: string,
  absolutePath: string,
  subject: string,
): string {
  const result = normalizePath(
    relative(resolve(workspaceRoot), resolve(absolutePath)),
  );
  if (result === ".." || result.startsWith("../")) {
    throw new Error(`${subject} must be inside the workspace root`);
  }
  return result;
}

export function resolveWorkspacePath(
  workspaceRoot: string,
  path: string,
  subject: string,
): string {
  const absolutePath = resolve(workspaceRoot, path);
  workspaceRelativePath(workspaceRoot, absolutePath, subject);
  return absolutePath;
}

export function generatedOutputPath(
  sourcePath: string,
  symbol: string,
): string {
  return resolve(dirname(sourcePath), `${kebabCase(symbol)}.generated.ts`);
}

export function kebabCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replaceAll("_", "-")
    .toLowerCase();
}
