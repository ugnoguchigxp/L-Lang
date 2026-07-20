import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, extname, relative, resolve } from "node:path";

import { validatePredicateContext } from "./context-validator";
import { generatePredicate } from "./generator";
import { renderSemanticTestModule } from "./judgement-renderer";
import { parsePredicateDefinition, type PredicateExpression } from "./ir";
import { PREDICATE_PROMPT_VERSION, type OpenAIResult } from "./openai";
import {
  classifySemanticChange,
  renderSemanticDiff,
  type SemanticDiff,
} from "./semantic-diff";
import type {
  SemanticCommandRunner,
  SemanticResolution,
} from "./semantic-compiler";
import {
  resolveWithSemanticConsensus,
  type SemanticConsensusResult,
} from "./semantic-consensus";
import {
  findReplayEntry,
  readSemanticLock,
  writeSemanticLock,
  type SemanticLockEntry,
} from "./semantic-lock";
import { scanSemanticSource, type SemanticSource } from "./semantic-source";

export type EvolutionHashes = {
  conceptHash: string;
  sourceHash: string;
  typeHash: string;
  testHash: string;
  promptHash: string;
};

export type SemanticEvolutionCandidate = {
  version: 1;
  id: string;
  status: "ready" | "invalid" | "unresolved" | "approved";
  source: string;
  output: string;
  predicate: string;
  concept: string;
  conceptId: string;
  conceptSource: string;
  provider: string;
  model: string;
  baselineFingerprint: string;
  proposedFingerprint: string;
  hashes: EvolutionHashes;
  previousIr: PredicateExpression;
  candidateIr: PredicateExpression | null;
  generatedCodeHash: string | null;
  response: {
    id: string;
    model: string;
    usage: OpenAIResult["usage"];
  } | null;
  consensus: Omit<SemanticConsensusResult, "resolution"> | null;
  validation: {
    passed: boolean;
    error: string | null;
  };
  diff: SemanticDiff;
  createdAt: string;
  approvedAt: string | null;
};

export type CheckSemanticEvolutionOptions = {
  sourcePath: string;
  workspaceRoot?: string;
  provider: string;
  model: string;
  lockPath?: string;
  evolutionRoot?: string;
  countsAsApiCall?: boolean;
  samples?: number;
  quorum?: number;
  commandRunner?: SemanticCommandRunner;
  resolve: (input: {
    specification: string;
    typeScriptSource: string;
    functionName: string;
    parameterName: string;
    typeName: string;
  }) => Promise<SemanticResolution>;
};

export type CheckSemanticEvolutionResult =
  | {
      status: "up-to-date";
      source: string;
      fingerprint: string;
      apiCalls: 0;
    }
  | {
      status: "candidate-created";
      candidate: SemanticEvolutionCandidate;
      candidateDirectory: string;
      apiCalls: number;
    };

export async function checkSemanticEvolution(
  options: CheckSemanticEvolutionOptions,
): Promise<CheckSemanticEvolutionResult> {
  const workspaceRoot = resolve(options.workspaceRoot ?? process.cwd());
  const source = await scanSemanticSource(options.sourcePath);
  const prepared = prepareInput(source, workspaceRoot, options.provider, options.model);
  const lockPath = resolve(options.lockPath ?? resolve(workspaceRoot, "semantic.lock"));
  const lock = await readSemanticLock(lockPath);
  const current = findReplayEntry(lock, {
    source: prepared.source,
    predicate: source.predicate.name,
    conceptId: source.concept.id,
    ...prepared.hashes,
  });
  if (current !== undefined) {
    return {
      status: "up-to-date",
      source: prepared.source,
      fingerprint: current.fingerprint,
      apiCalls: 0,
    };
  }

  const baseline = findEvolutionBaseline(lock.entries, {
    source: prepared.source,
    predicate: source.predicate.name,
    conceptId: source.concept.id,
    conceptHash: source.concept.hash,
  });
  if (baseline === undefined) {
    throw new Error("schema evolution requires an approved baseline; run semantic build first");
  }

  const request = {
    specification: source.concept.specification,
    typeScriptSource: source.concept.typeDeclaration,
    functionName: source.predicate.name,
    parameterName: source.predicate.parameterName,
    typeName: source.concept.typeName,
  };
  const samples = options.samples ?? 1;
  const quorum = options.quorum ?? 1;
  const consensus = await resolveWithSemanticConsensus({
    source,
    samples,
    quorum,
    resolve: () => options.resolve(request),
  });
  const resolution = consensus.resolution;
  const id = `${new Date().toISOString().replaceAll(/[-:.TZ]/g, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`;
  const evolutionRoot = resolve(
    options.evolutionRoot ?? resolve(workspaceRoot, ".semantic", "evolution"),
  );
  const candidateDirectory = resolve(evolutionRoot, id);
  await mkdir(candidateDirectory, { recursive: true });
  await writeJson(resolve(candidateDirectory, "response.output.json"), resolution.rawOutput);

  let candidateIr: PredicateExpression | null = null;
  let generatedCode = "";
  let validationError: string | null = null;
  if (resolution.elaboration.outcome === "resolved") {
    candidateIr = resolution.elaboration.body;
    try {
      validatePredicateContext(candidateIr, source);
      generatedCode = generateCode(source, candidateIr);
      await validateCandidate({
        source,
        workspaceRoot,
        candidateDirectory,
        id,
        code: generatedCode,
        commandRunner: options.commandRunner ?? runCommand,
      });
    } catch (error) {
      validationError = error instanceof Error ? error.message : String(error);
    }
  }
  const validationPassed = candidateIr !== null && validationError === null;
  const diff = classifySemanticChange({
    previous: baseline.resolvedIr,
    candidate: candidateIr,
    diagnostics: resolution.elaboration.diagnostics,
    validationPassed,
    validationError,
    typeSchema: source.concept.typeSchema,
  });
  const status = candidateIr === null
    ? "unresolved"
    : validationPassed
      ? "ready"
      : "invalid";
  const candidate: SemanticEvolutionCandidate = {
    version: 1,
    id,
    status,
    source: prepared.source,
    output: prepared.output,
    predicate: source.predicate.name,
    concept: source.concept.name,
    conceptId: source.concept.id,
    conceptSource: prepared.conceptSource,
    provider: options.provider,
    model: options.model,
    baselineFingerprint: baseline.fingerprint,
    proposedFingerprint: prepared.fingerprint,
    hashes: prepared.hashes,
    previousIr: baseline.resolvedIr,
    candidateIr,
    generatedCodeHash: generatedCode.length === 0 ? null : sha256(generatedCode),
    response: responseMetadata(resolution.response),
    consensus: samples === 1
      ? null
      : {
          samples: consensus.samples,
          quorum: consensus.quorum,
          reached: consensus.reached,
          selectedOutcome: consensus.selectedOutcome,
          selectedSignature: consensus.selectedSignature,
          supportingSamples: consensus.supportingSamples,
          votes: consensus.votes,
        },
    validation: { passed: validationPassed, error: validationError },
    diff,
    createdAt: new Date().toISOString(),
    approvedAt: null,
  };
  if (generatedCode.length > 0) {
    await writeFile(resolve(candidateDirectory, "candidate.ts"), generatedCode, "utf8");
  }
  await writeJson(resolve(candidateDirectory, "candidate.json"), candidate);
  await writeFile(
    resolve(candidateDirectory, "diff.txt"),
    renderSemanticDiff(diff),
    "utf8",
  );
  return {
    status: "candidate-created",
    candidate,
    candidateDirectory,
    apiCalls: options.countsAsApiCall === false ? 0 : samples,
  };
}

export async function readSemanticEvolutionCandidate(
  candidateId: string,
  options: { workspaceRoot?: string; evolutionRoot?: string } = {},
): Promise<{ candidate: SemanticEvolutionCandidate; candidateDirectory: string }> {
  const workspaceRoot = resolve(options.workspaceRoot ?? process.cwd());
  const root = resolve(
    options.evolutionRoot ?? resolve(workspaceRoot, ".semantic", "evolution"),
  );
  if (!/^[0-9]{14}-[a-f0-9]{8}$/.test(candidateId)) {
    throw new Error("candidate id is invalid");
  }
  const candidateDirectory = resolve(root, candidateId);
  const candidate = parseCandidate(
    JSON.parse(await readFile(resolve(candidateDirectory, "candidate.json"), "utf8")) as unknown,
  );
  if (candidate.id !== candidateId) throw new Error("candidate id does not match its directory");
  return { candidate, candidateDirectory };
}

export async function approveSemanticEvolution(
  candidateId: string,
  options: {
    workspaceRoot?: string;
    lockPath?: string;
    evolutionRoot?: string;
    commandRunner?: SemanticCommandRunner;
  } = {},
): Promise<{ candidate: SemanticEvolutionCandidate; output: string }> {
  const workspaceRoot = resolve(options.workspaceRoot ?? process.cwd());
  const { candidate, candidateDirectory } = await readSemanticEvolutionCandidate(
    candidateId,
    { workspaceRoot, ...(options.evolutionRoot ? { evolutionRoot: options.evolutionRoot } : {}) },
  );
  if (candidate.status === "approved") throw new Error("candidate is already approved");
  if (
    candidate.status !== "ready" ||
    !candidate.validation.passed ||
    candidate.candidateIr === null ||
    candidate.generatedCodeHash === null
  ) {
    throw new Error(`candidate is not approvable: ${candidate.status}`);
  }

  const sourcePath = resolve(workspaceRoot, candidate.source);
  const source = await scanSemanticSource(sourcePath);
  const prepared = prepareInput(source, workspaceRoot, candidate.provider, candidate.model);
  if (
    prepared.fingerprint !== candidate.proposedFingerprint ||
    stableJson(prepared.hashes) !== stableJson(candidate.hashes)
  ) {
    throw new Error("candidate is stale: semantic source changed after check");
  }
  const lockPath = resolve(options.lockPath ?? resolve(workspaceRoot, "semantic.lock"));
  const lock = await readSemanticLock(lockPath);
  const baseline = lock.entries[candidate.baselineFingerprint];
  if (baseline === undefined) {
    throw new Error("candidate baseline is no longer present in semantic.lock");
  }
  const latestBaseline = findEvolutionBaseline(lock.entries, {
    source: candidate.source,
    predicate: candidate.predicate,
    conceptId: candidate.conceptId,
    conceptHash: candidate.hashes.conceptHash,
  });
  if (latestBaseline?.fingerprint !== candidate.baselineFingerprint) {
    throw new Error("candidate baseline is stale: a newer semantic version was approved");
  }
  if (stableJson(baseline.resolvedIr) !== stableJson(candidate.previousIr)) {
    throw new Error("candidate baseline integrity failed: previous IR changed");
  }
  if (lock.entries[candidate.proposedFingerprint] !== undefined) {
    throw new Error("candidate fingerprint is already present in semantic.lock");
  }

  validatePredicateContext(candidate.candidateIr, source);
  const generatedCode = generateCode(source, candidate.candidateIr);
  if (sha256(generatedCode) !== candidate.generatedCodeHash) {
    throw new Error("candidate integrity failed: generated code hash changed");
  }
  const executeCommand = options.commandRunner ?? runCommand;
  await validateCandidate({
    source,
    workspaceRoot,
    candidateDirectory,
    id: `${candidate.id}-approve`,
    code: generatedCode,
    commandRunner: executeCommand,
  });

  const finalPath = resolve(workspaceRoot, candidate.output);
  const previousFinal = await readOptional(finalPath);
  await atomicWrite(finalPath, generatedCode);
  try {
    await executeCommand(["bun", "test"], workspaceRoot, "full-test");
    const entry: SemanticLockEntry = {
      fingerprint: candidate.proposedFingerprint,
      source: candidate.source,
      concept: candidate.concept,
      conceptId: candidate.conceptId,
      conceptSource: candidate.conceptSource,
      predicate: candidate.predicate,
      provider: candidate.provider,
      model: candidate.model,
      ...candidate.hashes,
      resolvedIr: candidate.candidateIr,
      generatedCodeHash: candidate.generatedCodeHash,
      response: candidate.response,
      createdAt: new Date().toISOString(),
    };
    lock.entries[candidate.proposedFingerprint] = entry;
    await writeSemanticLock(lockPath, lock);
  } catch (error) {
    await restoreFinal(finalPath, previousFinal);
    throw error;
  }

  const approved: SemanticEvolutionCandidate = {
    ...candidate,
    status: "approved",
    approvedAt: new Date().toISOString(),
  };
  await writeJson(resolve(candidateDirectory, "candidate.json"), approved);
  return { candidate: approved, output: candidate.output };
}

function prepareInput(
  source: SemanticSource,
  workspaceRoot: string,
  provider: string,
  model: string,
) {
  const sourceRelative = insideWorkspace(
    workspaceRoot,
    source.absolutePath,
    "semantic source",
  );
  const conceptSource = insideWorkspace(
    workspaceRoot,
    source.concept.definitionPath,
    "concept definition",
  );
  const requestShape = {
    specification: source.concept.specification,
    typeScriptSource: source.concept.typeDeclaration,
    target: {
      functionName: source.predicate.name,
      parameterName: source.predicate.parameterName,
      typeName: source.concept.typeName,
    },
  };
  const hashes: EvolutionHashes = {
    conceptHash: source.concept.hash,
    sourceHash: sha256(source.sourceText),
    typeHash: sha256(stableJson({
      declaration: source.concept.typeDeclaration,
      schema: source.concept.typeSchema,
    })),
    testHash: sha256(stableJson({
      accept: source.tests.acceptSource,
      reject: source.tests.rejectSource,
    })),
    promptHash: sha256(stableJson({
      version: PREDICATE_PROMPT_VERSION,
      ...requestShape,
    })),
  };
  const fingerprint = sha256(stableJson({
    source: sourceRelative,
    predicate: source.predicate.name,
    conceptId: source.concept.id,
    provider,
    model,
    ...hashes,
  }));
  const outputStem = kebabCase(source.predicate.name);
  return {
    source: sourceRelative,
    conceptSource,
    hashes,
    fingerprint,
    output: normalizePath(relative(
      workspaceRoot,
      resolve(dirname(source.absolutePath), `${outputStem}.generated.ts`),
    )),
  };
}

function findEvolutionBaseline(
  entries: Record<string, SemanticLockEntry>,
  match: {
    source: string;
    predicate: string;
    conceptId: string;
    conceptHash: string;
  },
): SemanticLockEntry | undefined {
  return Object.values(entries)
    .filter((entry) =>
      entry.source === match.source &&
      entry.predicate === match.predicate &&
      entry.conceptId === match.conceptId &&
      entry.conceptHash === match.conceptHash
    )
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
}

function generateCode(
  source: SemanticSource,
  expression: PredicateExpression,
): string {
  const importModule = `./${basename(source.absolutePath, extname(source.absolutePath))}`;
  return generatePredicate(parsePredicateDefinition({
    version: 1,
    name: source.predicate.name,
    description: source.concept.specification,
    input: {
      parameter: source.predicate.parameterName,
      type: source.concept.typeName,
      module: importModule,
    },
    returns: "boolean",
    body: expression,
  }));
}

async function validateCandidate(input: {
  source: SemanticSource;
  workspaceRoot: string;
  candidateDirectory: string;
  id: string;
  code: string;
  commandRunner: SemanticCommandRunner;
}): Promise<void> {
  const sourceDirectory = dirname(input.source.absolutePath);
  const outputStem = kebabCase(input.source.predicate.name);
  const candidatePath = resolve(sourceDirectory, `.${outputStem}.${input.id}.candidate.ts`);
  const testPath = resolve(sourceDirectory, `.${outputStem}.${input.id}.candidate.test.ts`);
  const candidateTest = renderSemanticTestModule({
    candidateModuleName: basename(candidatePath, ".ts"),
    predicateName: input.source.predicate.name,
    acceptSource: input.source.tests.acceptSource,
    rejectSource: input.source.tests.rejectSource,
  });
  await writeFile(resolve(input.candidateDirectory, "candidate.test.ts"), candidateTest, "utf8");
  await writeFile(candidatePath, input.code, "utf8");
  await writeFile(testPath, candidateTest, "utf8");
  try {
    await input.commandRunner(
      [
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
        candidatePath,
        testPath,
      ],
      input.workspaceRoot,
      "candidate-typecheck",
    );
    await input.commandRunner(
      ["bun", "test", testPath],
      input.workspaceRoot,
      "semantic-test",
    );
  } finally {
    await Promise.all([unlinkIfExists(candidatePath), unlinkIfExists(testPath)]);
  }
}

function parseCandidate(input: unknown): SemanticEvolutionCandidate {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("evolution candidate must be an object");
  }
  const value = input as Record<string, unknown>;
  if (
    value.version !== 1 ||
    typeof value.id !== "string" ||
    !["ready", "invalid", "unresolved", "approved"].includes(String(value.status))
  ) {
    throw new Error("evolution candidate is invalid");
  }
  return input as SemanticEvolutionCandidate;
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

async function atomicWrite(path: string, value: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.promote.tmp`;
  await writeFile(temporary, value, "utf8");
  await rename(temporary, path);
}

async function restoreFinal(path: string, previous: string | undefined): Promise<void> {
  if (previous === undefined) await unlinkIfExists(path);
  else await atomicWrite(path, previous);
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

async function unlinkIfExists(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function responseMetadata(response: OpenAIResult | null) {
  return response === null
    ? null
    : {
        id: response.responseId,
        model: response.model,
        usage: response.usage,
      };
}

function insideWorkspace(workspaceRoot: string, path: string, label: string): string {
  const result = normalizePath(relative(workspaceRoot, path));
  if (result.startsWith("../")) throw new Error(`${label} must be inside the workspace root`);
  return result;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function kebabCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replaceAll("_", "-")
    .toLowerCase();
}

function normalizePath(value: string): string {
  return value.replaceAll("\\", "/");
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  );
}
