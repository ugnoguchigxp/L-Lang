import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { PredicateExpression } from "./ir";
import { parsePredicateExpression } from "./ir";
import { renderInterpretedExpression } from "./judgement-renderer";
import {
  generatedOutputPath,
  predicateSemanticHashes,
  sha256,
  staticJudgmentSemanticHashes,
  workspaceRelativePath,
  type PredicateSemanticHashes,
  type StaticJudgmentSemanticHashes,
} from "./semantic-fingerprint";
import {
  findLatestPredicateEntry,
  findLatestStaticJudgmentEntry,
  findReplayEntry,
  findStaticJudgmentReplayEntry,
  readSemanticLock,
  type SemanticLockEntry,
  type StaticJudgmentLockEntry,
} from "./semantic-lock";
import { detectSemanticSourceKind } from "./semantic-source-kind";
import { scanSemanticSource, type TypeSchema } from "./semantic-source";
import { scanStaticJudgmentSource } from "./static-judgment-source";

export type SemanticExplanationStatus =
  | "current"
  | "stale"
  | "unlocked"
  | "integrity-error";

export type PredicateExplainInput = {
  parameterName: string;
  typeName: string;
  typeSchema: TypeSchema;
  hashes: PredicateSemanticHashes;
};

export type StaticJudgmentExplainInput = {
  hashes: StaticJudgmentSemanticHashes;
};

export type PredicateExplainResolution = {
  ir: PredicateExpression;
  interpreted: string;
};

export type StaticJudgmentExplainResolution = {
  value: boolean;
};

export type LockProvenance = {
  fingerprint: string;
  provider: string;
  model: string;
  response: SemanticLockEntry["response"];
  createdAt: string;
};

export type GeneratedIntegrity = {
  path: string;
  expectedHash: string;
  actualHash: string | null;
  state: "verified" | "missing" | "mismatch";
};

export type PredicateStaleReason =
  | "conceptHash changed"
  | "sourceHash changed"
  | "typeHash changed"
  | "testHash changed"
  | "promptHash changed";

export type StaticJudgmentStaleReason =
  | "conceptHash changed"
  | "valueHash changed"
  | "promptHash changed";

export type StaleReason = PredicateStaleReason | StaticJudgmentStaleReason;

type ExplanationBase = {
  version: 1;
  status: SemanticExplanationStatus;
  source: string;
  symbol: string;
  concept: {
    id: string;
    name: string;
    source: string;
    hash: string;
  };
  lock: LockProvenance | null;
  generated: GeneratedIntegrity | null;
  staleReasons: StaleReason[];
  limitations: string[];
};

export type PredicateSemanticExplanation = ExplanationBase & {
  kind: "predicate";
  input: PredicateExplainInput;
  resolution: PredicateExplainResolution | null;
};

export type StaticJudgmentSemanticExplanation = ExplanationBase & {
  kind: "static-judgment";
  input: StaticJudgmentExplainInput;
  resolution: StaticJudgmentExplainResolution | null;
};

export type SemanticExplanation =
  | PredicateSemanticExplanation
  | StaticJudgmentSemanticExplanation;

export type ExplainSemanticSourceOptions = {
  sourcePath: string;
  workspaceRoot?: string;
  lockPath?: string;
};

const commonLimitations = [
  "This explanation only reports information present in the current source, semantic.lock, and generated output.",
  "It does not perform a new semantic judgment or infer human approval.",
  "A null response does not identify whether the entry came from a fixture, replay, or manual process.",
];

export async function explainSemanticSource(
  options: ExplainSemanticSourceOptions,
): Promise<SemanticExplanation> {
  const workspaceRoot = resolve(options.workspaceRoot ?? process.cwd());
  const sourcePath = resolve(options.sourcePath);
  const sourceKind = await detectSemanticSourceKind(sourcePath);
  const lock = await readSemanticLock(
    resolve(options.lockPath ?? resolve(workspaceRoot, "semantic.lock")),
  );

  if (sourceKind === "static-judgment") {
    const source = await scanStaticJudgmentSource(sourcePath);
    const sourceRelative = workspaceRelativePath(
      workspaceRoot,
      source.absolutePath,
      "Static Judgment source",
    );
    const conceptSource = workspaceRelativePath(
      workspaceRoot,
      source.concept.definitionPath,
      "Static Judgment Concept",
    );
    const hashes = staticJudgmentSemanticHashes(source);
    const currentEntry = findStaticJudgmentReplayEntry(lock, {
      source: sourceRelative,
      judgment: source.judgment.name,
      conceptId: source.concept.id,
      ...hashes,
    });
    const latestEntry =
      currentEntry ??
      findLatestStaticJudgmentEntry(lock, {
        source: sourceRelative,
        judgment: source.judgment.name,
      });
    const generated = currentEntry
      ? await inspectGenerated(
          workspaceRoot,
          generatedOutputPath(source.absolutePath, source.judgment.name),
          currentEntry.generatedCodeHash,
        )
      : null;

    return {
      version: 1,
      kind: "static-judgment",
      status: statusFor(currentEntry, latestEntry, generated),
      source: sourceRelative,
      symbol: source.judgment.name,
      concept: {
        id: source.concept.id,
        name: source.concept.name,
        source: conceptSource,
        hash: source.concept.hash,
      },
      input: { hashes },
      resolution:
        latestEntry === undefined ? null : { value: latestEntry.resolvedValue },
      lock: latestEntry === undefined ? null : lockProvenance(latestEntry),
      generated,
      staleReasons:
        currentEntry !== undefined || latestEntry === undefined
          ? []
          : staticJudgmentStaleReasons(hashes, latestEntry),
      limitations: [...commonLimitations],
    };
  }

  const source = await scanSemanticSource(sourcePath);
  const sourceRelative = workspaceRelativePath(
    workspaceRoot,
    source.absolutePath,
    "semantic source",
  );
  const conceptSource = workspaceRelativePath(
    workspaceRoot,
    source.concept.definitionPath,
    "concept definition",
  );
  const hashes = predicateSemanticHashes(source);
  const currentEntry = findReplayEntry(lock, {
    source: sourceRelative,
    predicate: source.predicate.name,
    conceptId: source.concept.id,
    ...hashes,
  });
  const latestEntry =
    currentEntry ??
    findLatestPredicateEntry(lock, {
      source: sourceRelative,
      predicate: source.predicate.name,
    });
  const resolvedIr =
    latestEntry === undefined
      ? null
      : parsePredicateExpression(
          latestEntry.resolvedIr,
          "semantic.lock.resolvedIr",
        );
  const generated = currentEntry
    ? await inspectGenerated(
        workspaceRoot,
        generatedOutputPath(source.absolutePath, source.predicate.name),
        currentEntry.generatedCodeHash,
      )
    : null;

  return {
    version: 1,
    kind: "predicate",
    status: statusFor(currentEntry, latestEntry, generated),
    source: sourceRelative,
    symbol: source.predicate.name,
    concept: {
      id: source.concept.id,
      name: source.concept.name,
      source: conceptSource,
      hash: source.concept.hash,
    },
    input: {
      parameterName: source.predicate.parameterName,
      typeName: source.concept.typeName,
      typeSchema: source.concept.typeSchema,
      hashes,
    },
    resolution:
      resolvedIr === null
        ? null
        : {
            ir: resolvedIr,
            interpreted: renderInterpretedExpression({
              expression: resolvedIr,
              parameterName: source.predicate.parameterName,
            }),
          },
    lock: latestEntry === undefined ? null : lockProvenance(latestEntry),
    generated,
    staleReasons:
      currentEntry !== undefined || latestEntry === undefined
        ? []
        : predicateStaleReasons(hashes, latestEntry),
    limitations: [...commonLimitations],
  };
}

function statusFor(
  currentEntry: SemanticLockEntry | StaticJudgmentLockEntry | undefined,
  latestEntry: SemanticLockEntry | StaticJudgmentLockEntry | undefined,
  generated: GeneratedIntegrity | null,
): SemanticExplanationStatus {
  if (currentEntry !== undefined) {
    return generated?.state === "verified" ? "current" : "integrity-error";
  }
  return latestEntry === undefined ? "unlocked" : "stale";
}

function lockProvenance(
  entry: SemanticLockEntry | StaticJudgmentLockEntry,
): LockProvenance {
  return {
    fingerprint: entry.fingerprint,
    provider: entry.provider,
    model: entry.model,
    response: entry.response,
    createdAt: entry.createdAt,
  };
}

async function inspectGenerated(
  workspaceRoot: string,
  path: string,
  expectedHash: string,
): Promise<GeneratedIntegrity> {
  const workspacePath = workspaceRelativePath(
    workspaceRoot,
    path,
    "generated output",
  );
  try {
    const actualHash = sha256(await readFile(path));
    return {
      path: workspacePath,
      expectedHash,
      actualHash,
      state: actualHash === expectedHash ? "verified" : "mismatch",
    };
  } catch (error) {
    if (!isNotFound(error)) throw error;
    return {
      path: workspacePath,
      expectedHash,
      actualHash: null,
      state: "missing",
    };
  }
}

function predicateStaleReasons(
  current: PredicateSemanticHashes,
  entry: SemanticLockEntry,
): PredicateStaleReason[] {
  const reasons: PredicateStaleReason[] = [];
  if (entry.conceptHash !== current.conceptHash) reasons.push("conceptHash changed");
  if (entry.sourceHash !== current.sourceHash) reasons.push("sourceHash changed");
  if (entry.typeHash !== current.typeHash) reasons.push("typeHash changed");
  if (entry.testHash !== current.testHash) reasons.push("testHash changed");
  if (entry.promptHash !== current.promptHash) reasons.push("promptHash changed");
  return reasons;
}

function staticJudgmentStaleReasons(
  current: StaticJudgmentSemanticHashes,
  entry: StaticJudgmentLockEntry,
): StaticJudgmentStaleReason[] {
  const reasons: StaticJudgmentStaleReason[] = [];
  if (entry.conceptHash !== current.conceptHash) reasons.push("conceptHash changed");
  if (entry.valueHash !== current.valueHash) reasons.push("valueHash changed");
  if (entry.promptHash !== current.promptHash) reasons.push("promptHash changed");
  return reasons;
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  );
}
