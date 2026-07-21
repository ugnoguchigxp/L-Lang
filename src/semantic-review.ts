import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, extname, resolve } from "node:path";

import { validatePredicateContext } from "./context-validator";
import { generatePredicate } from "./generator";
import { renderSemanticTestModule } from "./judgement-renderer";
import {
  parsePredicateDefinition,
  parsePredicateExpression,
  type PredicateExpression,
} from "./ir";
import type { OpenAIResult } from "./openai";
import type { SemanticCommandRunner } from "./semantic-compiler";
import {
  fingerprintFor,
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
  readSemanticLock,
  type SemanticLockEntry,
  type StaticJudgmentLockEntry,
} from "./semantic-lock";
import { promoteSemanticArtifact } from "./semantic-promotion";
import {
  renderPredicateReviewDiff,
  renderStaticJudgmentReviewDiff,
} from "./semantic-review-renderer";
import { scanSemanticSource, type TypeSchema } from "./semantic-source";
import { generateStaticJudgmentConstant } from "./static-judgment-generator";
import { scanStaticJudgmentSource } from "./static-judgment-source";

export type ReviewValidation = {
  candidateTypecheck: "passed";
  projectTypecheck: "passed";
  semanticTest: "passed" | "not-applicable";
};

type ReviewCandidateBase = {
  version: 1;
  id: string;
  status: "ready" | "approved";
  source: string;
  output: string;
  symbol: string;
  conceptId: string;
  provider: string;
  model: string;
  fingerprint: string;
  generatedCodeHash: string;
  validation: ReviewValidation;
  createdAt: string;
  approvedAt: string | null;
  reviewer: string | null;
};

export type PredicateReviewCandidate = ReviewCandidateBase & {
  kind: "predicate";
  hashes: PredicateSemanticHashes;
  resolvedIr: PredicateExpression;
  baselineFingerprint: string | null;
  response: SemanticLockEntry["response"];
};

export type StaticJudgmentReviewCandidate = ReviewCandidateBase & {
  kind: "static-judgment";
  hashes: StaticJudgmentSemanticHashes;
  resolvedValue: boolean;
  baselineFingerprint: string | null;
  response: StaticJudgmentLockEntry["response"];
};

export type ReviewCandidate =
  | PredicateReviewCandidate
  | StaticJudgmentReviewCandidate;

export type ReviewApprovalResult = {
  status: "approved" | "already-approved";
  candidate: ReviewCandidate;
  output: string;
  warning: string | null;
};

export async function createPredicateSemanticReview(input: {
  workspaceRoot: string;
  reviewRoot?: string;
  source: string;
  output: string;
  symbol: string;
  conceptId: string;
  provider: string;
  model: string;
  fingerprint: string;
  hashes: PredicateSemanticHashes;
  resolvedIr: PredicateExpression;
  baseline: SemanticLockEntry | undefined;
  response: SemanticLockEntry["response"];
  generatedCode: string;
  typeSchema: TypeSchema;
}): Promise<{ candidate: PredicateReviewCandidate; candidateDirectory: string }> {
  const id = reviewId();
  const candidate: PredicateReviewCandidate = {
    version: 1,
    id,
    status: "ready",
    kind: "predicate",
    source: input.source,
    output: input.output,
    symbol: input.symbol,
    conceptId: input.conceptId,
    provider: input.provider,
    model: input.model,
    fingerprint: input.fingerprint,
    generatedCodeHash: sha256(input.generatedCode),
    validation: {
      candidateTypecheck: "passed",
      projectTypecheck: "passed",
      semanticTest: "passed",
    },
    hashes: input.hashes,
    resolvedIr: input.resolvedIr,
    baselineFingerprint: input.baseline?.fingerprint ?? null,
    response: input.response,
    createdAt: new Date().toISOString(),
    approvedAt: null,
    reviewer: null,
  };
  return saveReviewCandidate({
    workspaceRoot: input.workspaceRoot,
    ...(input.reviewRoot === undefined ? {} : { reviewRoot: input.reviewRoot }),
    candidate,
    generatedCode: input.generatedCode,
    diff: renderPredicateReviewDiff({
      previous: input.baseline?.resolvedIr ?? null,
      candidate: input.resolvedIr,
      typeSchema: input.typeSchema,
    }),
  });
}

export async function createStaticJudgmentSemanticReview(input: {
  workspaceRoot: string;
  reviewRoot?: string;
  source: string;
  output: string;
  symbol: string;
  conceptId: string;
  provider: string;
  model: string;
  fingerprint: string;
  hashes: StaticJudgmentSemanticHashes;
  resolvedValue: boolean;
  baseline: StaticJudgmentLockEntry | undefined;
  response: StaticJudgmentLockEntry["response"];
  generatedCode: string;
}): Promise<{
  candidate: StaticJudgmentReviewCandidate;
  candidateDirectory: string;
}> {
  const id = reviewId();
  const candidate: StaticJudgmentReviewCandidate = {
    version: 1,
    id,
    status: "ready",
    kind: "static-judgment",
    source: input.source,
    output: input.output,
    symbol: input.symbol,
    conceptId: input.conceptId,
    provider: input.provider,
    model: input.model,
    fingerprint: input.fingerprint,
    generatedCodeHash: sha256(input.generatedCode),
    validation: {
      candidateTypecheck: "passed",
      projectTypecheck: "passed",
      semanticTest: "not-applicable",
    },
    hashes: input.hashes,
    resolvedValue: input.resolvedValue,
    baselineFingerprint: input.baseline?.fingerprint ?? null,
    response: input.response,
    createdAt: new Date().toISOString(),
    approvedAt: null,
    reviewer: null,
  };
  return saveReviewCandidate({
    workspaceRoot: input.workspaceRoot,
    ...(input.reviewRoot === undefined ? {} : { reviewRoot: input.reviewRoot }),
    candidate,
    generatedCode: input.generatedCode,
    diff: renderStaticJudgmentReviewDiff({
      previous: input.baseline?.resolvedValue ?? null,
      candidate: input.resolvedValue,
    }),
  });
}

export async function readSemanticReviewCandidate(
  candidateId: string,
  options: { workspaceRoot?: string; reviewRoot?: string } = {},
): Promise<{ candidate: ReviewCandidate; candidateDirectory: string; diff: string }> {
  if (!/^review-[0-9]{14}-[a-f0-9]{8}$/.test(candidateId)) {
    throw new Error("review candidate id is invalid");
  }
  const workspaceRoot = resolve(options.workspaceRoot ?? process.cwd());
  const reviewRoot = resolve(
    options.reviewRoot ?? resolve(workspaceRoot, ".semantic", "reviews"),
  );
  const candidateDirectory = resolve(reviewRoot, candidateId);
  const candidate = parseReviewCandidate(
    JSON.parse(
      await readFile(resolve(candidateDirectory, "candidate.json"), "utf8"),
    ) as unknown,
  );
  if (candidate.id !== candidateId) {
    throw new Error("review candidate id does not match its directory");
  }
  const expectedTimestamp = candidate.createdAt
    .replaceAll(/[-:TZ]/g, "")
    .slice(0, 14);
  if (!candidate.id.startsWith(`review-${expectedTimestamp}-`)) {
    throw new Error("review candidate id does not match createdAt");
  }
  return {
    candidate,
    candidateDirectory,
    diff: await readFile(resolve(candidateDirectory, "diff.txt"), "utf8"),
  };
}

export async function approveSemanticReview(
  candidateId: string,
  options: {
    reviewer: string;
    workspaceRoot?: string;
    lockPath?: string;
    reviewRoot?: string;
    commandRunner?: SemanticCommandRunner;
  },
): Promise<ReviewApprovalResult> {
  const workspaceRoot = resolve(options.workspaceRoot ?? process.cwd());
  const { candidate, candidateDirectory } = await readSemanticReviewCandidate(
    candidateId,
    {
      workspaceRoot,
      ...(options.reviewRoot === undefined ? {} : { reviewRoot: options.reviewRoot }),
    },
  );
  const reviewer = trimmedString(options.reviewer, "reviewer");
  const candidateCode = await readFile(
    resolve(candidateDirectory, "candidate.ts"),
    "utf8",
  );
  if (sha256(candidateCode) !== candidate.generatedCodeHash) {
    throw new Error("review candidate integrity failed: candidate.ts hash changed");
  }

  const lockPath = resolve(options.lockPath ?? resolve(workspaceRoot, "semantic.lock"));
  const lock = await readSemanticLock(lockPath);
  const executeCommand = options.commandRunner ?? runCommand;

  if (candidate.kind === "predicate") {
    const source = await scanSemanticSource(resolve(workspaceRoot, candidate.source));
    const sourceRelative = workspaceRelativePath(
      workspaceRoot,
      source.absolutePath,
      "semantic source",
    );
    const output = workspaceRelativePath(
      workspaceRoot,
      generatedOutputPath(source.absolutePath, source.predicate.name),
      "generated output",
    );
    const hashes = predicateSemanticHashes(source);
    assertCandidateIdentity(candidate, {
      source: sourceRelative,
      output,
      symbol: source.predicate.name,
      conceptId: source.concept.id,
      fingerprint: fingerprintFor({
        source: sourceRelative,
        predicate: source.predicate.name,
        conceptId: source.concept.id,
        provider: candidate.provider,
        model: candidate.model,
        ...hashes,
      }),
      hashes,
    });
    const generatedCode = generatePredicate(
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
        body: candidate.resolvedIr,
      }),
    );
    if (
      generatedCode !== candidateCode ||
      sha256(generatedCode) !== candidate.generatedCodeHash
    ) {
      throw new Error("review candidate integrity failed: generated code changed");
    }
    validatePredicateContext(candidate.resolvedIr, source);

    const existing = lock.entries[candidate.fingerprint];
    if (
      existing?.promotion?.mode === "reviewed" &&
      existing.promotion.candidateId === candidate.id
    ) {
      return finishIdempotentApproval(candidate, candidateDirectory, existing, output);
    }
    if (candidate.status === "approved") {
      throw new Error("approved review candidate is missing reviewed lock provenance");
    }
    assertReviewBaseline(
      candidate,
      findLatestPredicateEntry(lock, {
        source: candidate.source,
        predicate: candidate.symbol,
      }),
    );
    await validatePredicateCandidate({
      sourcePath: source.absolutePath,
      predicateName: source.predicate.name,
      acceptSource: source.tests.acceptSource,
      rejectSource: source.tests.rejectSource,
      generatedCode,
      workspaceRoot,
      candidateId,
      commandRunner: executeCommand,
    });
    const promotedAt = new Date().toISOString();
    lock.entries[candidate.fingerprint] = {
      fingerprint: candidate.fingerprint,
      source: candidate.source,
      concept: source.concept.name,
      conceptId: source.concept.id,
      conceptSource: workspaceRelativePath(
        workspaceRoot,
        source.concept.definitionPath,
        "concept definition",
      ),
      predicate: candidate.symbol,
      provider: candidate.provider,
      model: candidate.model,
      ...candidate.hashes,
      resolvedIr: candidate.resolvedIr,
      generatedCodeHash: candidate.generatedCodeHash,
      response: candidate.response,
      createdAt: existing?.createdAt ?? promotedAt,
      promotion: reviewedPromotion(candidate.id, reviewer, "passed", promotedAt),
    };
    await promoteSemanticArtifact({
      outputPath: resolve(workspaceRoot, candidate.output),
      generatedCode,
      lockPath,
      nextLock: lock,
      runFullTest: () => executeCommand(["bun", "test"], workspaceRoot, "full-test"),
    });
  } else {
    const source = await scanStaticJudgmentSource(
      resolve(workspaceRoot, candidate.source),
    );
    const sourceRelative = workspaceRelativePath(
      workspaceRoot,
      source.absolutePath,
      "Static Judgment source",
    );
    const output = workspaceRelativePath(
      workspaceRoot,
      generatedOutputPath(source.absolutePath, source.judgment.name),
      "generated output",
    );
    const hashes = staticJudgmentSemanticHashes(source);
    assertCandidateIdentity(candidate, {
      source: sourceRelative,
      output,
      symbol: source.judgment.name,
      conceptId: source.concept.id,
      fingerprint: fingerprintFor({
        source: sourceRelative,
        judgment: source.judgment.name,
        conceptId: source.concept.id,
        provider: candidate.provider,
        model: candidate.model,
        ...hashes,
      }),
      hashes,
    });
    const generatedCode = generateStaticJudgmentConstant(
      source.judgment.name,
      candidate.resolvedValue,
    );
    if (
      generatedCode !== candidateCode ||
      sha256(generatedCode) !== candidate.generatedCodeHash
    ) {
      throw new Error("review candidate integrity failed: generated code changed");
    }

    const existing = lock.judgments?.[candidate.fingerprint];
    if (
      existing?.promotion?.mode === "reviewed" &&
      existing.promotion.candidateId === candidate.id
    ) {
      return finishIdempotentApproval(candidate, candidateDirectory, existing, output);
    }
    if (candidate.status === "approved") {
      throw new Error("approved review candidate is missing reviewed lock provenance");
    }
    assertReviewBaseline(
      candidate,
      findLatestStaticJudgmentEntry(lock, {
        source: candidate.source,
        judgment: candidate.symbol,
      }),
    );
    await validateStaticJudgmentCandidate({
      sourcePath: source.absolutePath,
      generatedCode,
      workspaceRoot,
      candidateId,
      commandRunner: executeCommand,
    });
    const promotedAt = new Date().toISOString();
    lock.judgments ??= {};
    lock.judgments[candidate.fingerprint] = {
      fingerprint: candidate.fingerprint,
      source: candidate.source,
      judgment: candidate.symbol,
      conceptId: source.concept.id,
      ...candidate.hashes,
      provider: candidate.provider,
      model: candidate.model,
      resolvedValue: candidate.resolvedValue,
      generatedCodeHash: candidate.generatedCodeHash,
      response: candidate.response,
      createdAt: existing?.createdAt ?? promotedAt,
      promotion: reviewedPromotion(
        candidate.id,
        reviewer,
        "not-applicable",
        promotedAt,
      ),
    };
    await promoteSemanticArtifact({
      outputPath: resolve(workspaceRoot, candidate.output),
      generatedCode,
      lockPath,
      nextLock: lock,
      runFullTest: () => executeCommand(["bun", "test"], workspaceRoot, "full-test"),
    });
  }

  const approved: ReviewCandidate = {
    ...candidate,
    status: "approved",
    approvedAt: new Date().toISOString(),
    reviewer,
  };
  try {
    await writeJson(resolve(candidateDirectory, "candidate.json"), approved);
    return { status: "approved", candidate: approved, output: candidate.output, warning: null };
  } catch (error) {
    return {
      status: "approved",
      candidate: approved,
      output: candidate.output,
      warning: `promotion succeeded but candidate audit update failed: ${errorMessage(error)}`,
    };
  }
}

function reviewedPromotion(
  candidateId: string,
  reviewer: string,
  semanticTest: "passed" | "not-applicable",
  promotedAt: string,
) {
  return {
    mode: "reviewed" as const,
    promotedAt,
    candidateId,
    reviewer,
    validation: {
      candidateTypecheck: "passed" as const,
      projectTypecheck: "passed" as const,
      semanticTest,
      fullTest: "passed" as const,
    },
  };
}

async function finishIdempotentApproval(
  candidate: ReviewCandidate,
  candidateDirectory: string,
  entry: SemanticLockEntry | StaticJudgmentLockEntry,
  output: string,
): Promise<ReviewApprovalResult> {
  const reviewer = entry.promotion?.mode === "reviewed"
    ? entry.promotion.reviewer
    : candidate.reviewer;
  const approved: ReviewCandidate = {
    ...candidate,
    status: "approved",
    approvedAt: candidate.approvedAt ?? entry.promotion?.promotedAt ?? entry.createdAt,
    reviewer,
  };
  if (candidate.status !== "approved") {
    try {
      await writeJson(resolve(candidateDirectory, "candidate.json"), approved);
    } catch {
      // The reviewed lock provenance is the commit record for idempotent retries.
    }
  }
  return {
    status: "already-approved",
    candidate: approved,
    output,
    warning: null,
  };
}

function assertCandidateIdentity(
  candidate: ReviewCandidate,
  current: {
    source: string;
    output: string;
    symbol: string;
    conceptId: string;
    fingerprint: string;
    hashes: PredicateSemanticHashes | StaticJudgmentSemanticHashes;
  },
): void {
  if (
    candidate.source !== current.source ||
    candidate.output !== current.output ||
    candidate.symbol !== current.symbol ||
    candidate.conceptId !== current.conceptId ||
    candidate.fingerprint !== current.fingerprint ||
    JSON.stringify(candidate.hashes) !== JSON.stringify(current.hashes)
  ) {
    throw new Error("review candidate is stale: semantic source changed after build");
  }
}

function assertReviewBaseline(
  candidate: ReviewCandidate,
  current: SemanticLockEntry | StaticJudgmentLockEntry | undefined,
): void {
  if ((current?.fingerprint ?? null) !== candidate.baselineFingerprint) {
    throw new Error("review candidate baseline is stale");
  }
}

async function validatePredicateCandidate(input: {
  sourcePath: string;
  predicateName: string;
  acceptSource: string;
  rejectSource: string;
  generatedCode: string;
  workspaceRoot: string;
  candidateId: string;
  commandRunner: SemanticCommandRunner;
}): Promise<void> {
  const directory = dirname(input.sourcePath);
  const stem = basename(
    generatedOutputPath(input.sourcePath, input.predicateName),
    ".generated.ts",
  );
  const candidatePath = resolve(directory, `.${stem}.${input.candidateId}.approve.ts`);
  const testPath = resolve(directory, `.${stem}.${input.candidateId}.approve.test.ts`);
  const testModule = renderSemanticTestModule({
    candidateModuleName: basename(candidatePath, ".ts"),
    predicateName: input.predicateName,
    acceptSource: input.acceptSource,
    rejectSource: input.rejectSource,
  });
  await writeFile(candidatePath, input.generatedCode, "utf8");
  await writeFile(testPath, testModule, "utf8");
  try {
    await input.commandRunner(candidateTypecheckCommand(candidatePath, testPath), input.workspaceRoot, "candidate-typecheck");
    await input.commandRunner(["bun", "test", testPath], input.workspaceRoot, "semantic-test");
    await input.commandRunner(["bun", "run", "typecheck"], input.workspaceRoot, "project-typecheck");
  } finally {
    await Promise.all([unlinkIfExists(candidatePath), unlinkIfExists(testPath)]);
  }
}

async function validateStaticJudgmentCandidate(input: {
  sourcePath: string;
  generatedCode: string;
  workspaceRoot: string;
  candidateId: string;
  commandRunner: SemanticCommandRunner;
}): Promise<void> {
  const finalPath = generatedOutputPath(input.sourcePath, "candidate");
  const candidatePath = resolve(
    dirname(input.sourcePath),
    `.${basename(finalPath, ".generated.ts")}.${input.candidateId}.approve.ts`,
  );
  await writeFile(candidatePath, input.generatedCode, "utf8");
  try {
    await input.commandRunner(candidateTypecheckCommand(candidatePath), input.workspaceRoot, "candidate-typecheck");
    await input.commandRunner(["bun", "run", "typecheck"], input.workspaceRoot, "project-typecheck");
  } finally {
    await unlinkIfExists(candidatePath);
  }
}

function candidateTypecheckCommand(...paths: string[]): string[] {
  return [
    "bunx",
    "tsc",
    "--noEmit",
    "--target",
    "ES2022",
    "--module",
    "ESNext",
    "--moduleResolution",
    "Bundler",
    "--strict",
    "--noUncheckedIndexedAccess",
    "--exactOptionalPropertyTypes",
    "--types",
    "bun",
    ...paths,
  ];
}

async function saveReviewCandidate<T extends ReviewCandidate>(input: {
  workspaceRoot: string;
  reviewRoot?: string;
  candidate: T;
  generatedCode: string;
  diff: string;
}): Promise<{ candidate: T; candidateDirectory: string }> {
  const root = resolve(
    input.reviewRoot ?? resolve(input.workspaceRoot, ".semantic", "reviews"),
  );
  const candidateDirectory = resolve(root, input.candidate.id);
  await mkdir(root, { recursive: true });
  await mkdir(candidateDirectory, { recursive: false });
  await Promise.all([
    writeJson(resolve(candidateDirectory, "candidate.json"), input.candidate),
    writeFile(resolve(candidateDirectory, "candidate.ts"), input.generatedCode, "utf8"),
    writeFile(resolve(candidateDirectory, "diff.txt"), input.diff, "utf8"),
  ]);
  return { candidate: input.candidate, candidateDirectory };
}

export function parseReviewCandidate(input: unknown): ReviewCandidate {
  const value = objectValue(input, "review candidate");
  const kind = value.kind;
  if (kind !== "predicate" && kind !== "static-judgment") {
    throw new Error("review candidate.kind must be predicate or static-judgment");
  }
  assertKeys(value, kind === "predicate"
    ? [
        "version", "id", "status", "kind", "source", "output", "symbol",
        "conceptId", "provider", "model", "fingerprint", "generatedCodeHash",
        "validation", "hashes", "resolvedIr", "baselineFingerprint", "response",
        "createdAt", "approvedAt", "reviewer",
      ]
    : [
        "version", "id", "status", "kind", "source", "output", "symbol",
        "conceptId", "provider", "model", "fingerprint", "generatedCodeHash",
        "validation", "hashes", "resolvedValue", "baselineFingerprint", "response",
        "createdAt", "approvedAt", "reviewer",
      ], "review candidate");
  if (value.version !== 1) throw new Error("review candidate.version must be 1");
  const id = stringValue(value.id, "review candidate.id");
  if (!/^review-[0-9]{14}-[a-f0-9]{8}$/.test(id)) {
    throw new Error("review candidate.id is invalid");
  }
  if (value.status !== "ready" && value.status !== "approved") {
    throw new Error("review candidate.status must be ready or approved");
  }
  const status: "ready" | "approved" = value.status;
  const approvedAt = nullableDate(value.approvedAt, "review candidate.approvedAt");
  const reviewer = nullableTrimmedString(value.reviewer, "review candidate.reviewer");
  if (status === "ready" && (approvedAt !== null || reviewer !== null)) {
    throw new Error("ready review candidate must not have approval metadata");
  }
  if (status === "approved" && (approvedAt === null || reviewer === null)) {
    throw new Error("approved review candidate requires approval metadata");
  }
  const base = {
    version: 1 as const,
    id,
    status,
    source: stringValue(value.source, "review candidate.source"),
    output: stringValue(value.output, "review candidate.output"),
    symbol: stringValue(value.symbol, "review candidate.symbol"),
    conceptId: stringValue(value.conceptId, "review candidate.conceptId"),
    provider: stringValue(value.provider, "review candidate.provider"),
    model: stringValue(value.model, "review candidate.model"),
    fingerprint: hashValue(value.fingerprint, "review candidate.fingerprint"),
    generatedCodeHash: hashValue(
      value.generatedCodeHash,
      "review candidate.generatedCodeHash",
    ),
    baselineFingerprint: nullableHash(
      value.baselineFingerprint,
      "review candidate.baselineFingerprint",
    ),
    response: responseValue(value.response, "review candidate.response"),
    createdAt: dateValue(value.createdAt, "review candidate.createdAt"),
    approvedAt,
    reviewer,
  };
  if (kind === "predicate") {
    return {
      ...base,
      kind,
      validation: validationValue(value.validation, "passed"),
      hashes: predicateHashesValue(value.hashes),
      resolvedIr: parsePredicateExpression(value.resolvedIr, "review candidate.resolvedIr"),
    };
  }
  if (typeof value.resolvedValue !== "boolean") {
    throw new Error("review candidate.resolvedValue must be a boolean");
  }
  return {
    ...base,
    kind,
    validation: validationValue(value.validation, "not-applicable"),
    hashes: staticHashesValue(value.hashes),
    resolvedValue: value.resolvedValue,
  };
}

function validationValue(
  input: unknown,
  semanticTest: "passed" | "not-applicable",
): ReviewValidation {
  const value = objectValue(input, "review candidate.validation");
  assertKeys(
    value,
    ["candidateTypecheck", "projectTypecheck", "semanticTest"],
    "review candidate.validation",
  );
  if (
    value.candidateTypecheck !== "passed" ||
    value.projectTypecheck !== "passed" ||
    value.semanticTest !== semanticTest
  ) {
    throw new Error("review candidate.validation is invalid");
  }
  return {
    candidateTypecheck: "passed",
    projectTypecheck: "passed",
    semanticTest,
  };
}

function predicateHashesValue(input: unknown): PredicateSemanticHashes {
  const value = objectValue(input, "review candidate.hashes");
  assertKeys(value, ["conceptHash", "sourceHash", "typeHash", "testHash", "promptHash"], "review candidate.hashes");
  return {
    conceptHash: hashValue(value.conceptHash, "review candidate.hashes.conceptHash"),
    sourceHash: hashValue(value.sourceHash, "review candidate.hashes.sourceHash"),
    typeHash: hashValue(value.typeHash, "review candidate.hashes.typeHash"),
    testHash: hashValue(value.testHash, "review candidate.hashes.testHash"),
    promptHash: hashValue(value.promptHash, "review candidate.hashes.promptHash"),
  };
}

function staticHashesValue(input: unknown): StaticJudgmentSemanticHashes {
  const value = objectValue(input, "review candidate.hashes");
  assertKeys(value, ["conceptHash", "valueHash", "promptHash"], "review candidate.hashes");
  return {
    conceptHash: hashValue(value.conceptHash, "review candidate.hashes.conceptHash"),
    valueHash: hashValue(value.valueHash, "review candidate.hashes.valueHash"),
    promptHash: hashValue(value.promptHash, "review candidate.hashes.promptHash"),
  };
}

function responseValue(input: unknown, path: string): SemanticLockEntry["response"] {
  if (input === null) return null;
  const value = objectValue(input, path);
  assertKeys(value, ["id", "model", "usage"], path);
  let usage: OpenAIResult["usage"] = null;
  if (value.usage !== null) {
    const rawUsage = objectValue(value.usage, `${path}.usage`);
    assertKeys(rawUsage, ["inputTokens", "outputTokens", "totalTokens"], `${path}.usage`);
    usage = {
      inputTokens: nonNegativeInteger(rawUsage.inputTokens, `${path}.usage.inputTokens`),
      outputTokens: nonNegativeInteger(rawUsage.outputTokens, `${path}.usage.outputTokens`),
      totalTokens: nonNegativeInteger(rawUsage.totalTokens, `${path}.usage.totalTokens`),
    };
  }
  return {
    id: stringValue(value.id, `${path}.id`),
    model: stringValue(value.model, `${path}.model`),
    usage,
  };
}

function reviewId(): string {
  const timestamp = new Date().toISOString().replaceAll(/[-:.TZ]/g, "").slice(0, 14);
  return `review-${timestamp}-${randomUUID().slice(0, 8)}`;
}

async function runCommand(command: string[], cwd: string, stage: string): Promise<void> {
  const child = Bun.spawn(command, {
    cwd,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) throw new Error(`${stage} failed with exit code ${exitCode}`);
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function unlinkIfExists(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
}

function objectValue(input: unknown, path: string): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error(`${path} must be an object`);
  }
  return input as Record<string, unknown>;
}

function assertKeys(
  value: Record<string, unknown>,
  expected: string[],
  path: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new Error(`${path} fields are invalid`);
  }
}

function stringValue(input: unknown, path: string): string {
  if (typeof input !== "string" || input.length === 0) {
    throw new Error(`${path} must be a non-empty string`);
  }
  return input;
}

function trimmedString(input: unknown, path: string): string {
  const value = stringValue(input, path);
  if (value.trim() !== value) throw new Error(`${path} must be trimmed`);
  return value;
}

function nullableTrimmedString(input: unknown, path: string): string | null {
  return input === null ? null : trimmedString(input, path);
}

function hashValue(input: unknown, path: string): string {
  const value = stringValue(input, path);
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${path} must be a lowercase SHA-256 hash`);
  }
  return value;
}

function nullableHash(input: unknown, path: string): string | null {
  return input === null ? null : hashValue(input, path);
}

function dateValue(input: unknown, path: string): string {
  const value = stringValue(input, path);
  if (new Date(value).toISOString() !== value) {
    throw new Error(`${path} must be a canonical ISO-8601 UTC timestamp`);
  }
  return value;
}

function nullableDate(input: unknown, path: string): string | null {
  return input === null ? null : dateValue(input, path);
}

function nonNegativeInteger(input: unknown, path: string): number {
  if (typeof input !== "number" || !Number.isInteger(input) || input < 0) {
    throw new Error(`${path} must be a non-negative integer`);
  }
  return input;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  );
}
