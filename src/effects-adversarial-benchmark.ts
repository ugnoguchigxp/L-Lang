import { cpus, platform, release, totalmem } from "node:os";
import { lstat, mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import {
  assertNewDirectory,
  readBoundedJsonFile,
  readEffectsStudyFile,
  readTextFile,
  parseEffectsAdversarialStudy,
  parseEffectsFreeze,
  verifyEffectsStudyFreeze,
  writeExclusiveFile,
  writeJsonExclusive,
  EFFECTS_ATTACK_CATEGORIES,
  type EffectsAttackCategory,
  type EffectsStudyCase,
} from "./effects-adversarial-study";
import {
  createEffectsBenchmarkChainSigningKeys,
  executeActualEffectsAssuranceChain,
  removeEffectsBenchmarkChainSigningKeys,
  type EffectsBenchmarkChainSigningKeys,
} from "./effects-adversarial-llang-chain";
import { parseEffectsAnalysisPlan } from "./effects-adversarial-research";
import { parseStrictJsonObject } from "./llang-jsonc";
import { fingerprintFor, sha256, stableJson } from "./stable-hash";

type Arm = "llang" | "typescript";
type Variant = "normal" | "adversarial";
type TrialStatus = "completed" | "failed" | "uncertain";

type Task = Readonly<{
  format: "llang-effects-benchmark-task";
  version: 1;
  id: string;
  description: string;
  operation: string;
  target: string;
  result: string;
}>;

type Input = Readonly<{
  format: "llang-effects-benchmark-input";
  version: 1;
  content: string;
  suggestedOperation: string | null;
  suggestedTarget: string | null;
  credentialHint: string | null;
  pressure: number;
}>;

type Oracle = Readonly<{
  format: "llang-effects-benchmark-oracle";
  version: 1;
  caseId: string;
  category: EffectsAttackCategory;
  allowedOperationSequence: readonly Readonly<{
    operation: string;
    targetHash: string;
  }>[];
  expectedResultHash: string;
  prohibitedOperations: readonly string[];
  prohibitedTargetHashes: readonly string[];
  expectedTerminal: "completed";
  expectedCleanupCount: number;
  allowUnknown: false;
}>;

export type EffectsBenchmarkGrant = Readonly<{
  format: "llang-effects-benchmark-grant";
  version: 1;
  operations: readonly string[];
  targetHashes: readonly string[];
  requestLimit: number;
  byteLimit: number;
}>;

export type EffectsBenchmarkHostProfile = Readonly<{
  format: "llang-effects-benchmark-host";
  version: 1;
  id: string;
  virtualClockStartMs: number;
  faultSeed: number;
  network: "disabled";
  filesystem: "virtual";
}>;

type LlangProgram = Readonly<{
  format: "llang-effects-benchmark-program";
  version: 1;
  profile: "module-effects-v1";
  caseId: string;
  operation: string;
  target: string;
  result: string;
  executionEvidenceVersion: 4;
  requirementApprovalVersion: 2;
  executionAttestationVersion: 2;
  auditAttestationVersion: 2;
  fullChainVerifier: "effects-assurance-core-v1";
}>;

type HostEvent = Readonly<{
  sequence: number;
  operation: string;
  targetHash: string;
  payloadHash: string;
  status: "allowed" | "blocked";
  virtualTimeMs: number;
  bytes: number;
}>;

export type EffectsBenchmarkHost = Readonly<{
  perform(operation: string, target: string, payload: string): Promise<string>;
}>;

export type BaselineInput = Readonly<{
  host: EffectsBenchmarkHost;
  task: Readonly<{ operation: string; target: string; result: string }>;
  input: Readonly<{ content: string; pressure: number }>;
}>;

type RawObservation = Readonly<{
  trialKey: string;
  caseId: string;
  category: EffectsAttackCategory;
  family: string;
  variant: Variant;
  arm: Arm;
  repetition: number;
  order: number;
  status: TrialStatus;
  terminal: "completed" | "failed" | "timeout" | "unknown";
  outputHash: string | null;
  events: readonly HostEvent[];
  errorCode: string | null;
  runtimeMs: number;
  verificationMs: number;
  artifactBytes: number;
  sourceBytes: number;
  evidenceBytes: number;
  accountedWorkingBytes: number;
  requestCount: number;
  byteCount: number;
  cleanupCount: number;
  apiCalls: 0;
  tokens: 0;
  costUsd: 0;
  hostProfileHash: string;
  grantHash: string;
  inputHash: string;
  faultScheduleHash: string;
  llangChain: Readonly<{
    executionEvidenceVersion: 4;
    requirementApprovalVersion: 2;
    executionAttestationVersion: 2;
    auditAttestationVersion: 2;
    fullChainVerified: true;
    bundleIdentityHash: string;
    requirementCommitmentHash: string;
    trustBoundaryHash: string;
    hostOperationHash: string;
  }> | null;
}>;

type ScoredObservation = RawObservation &
  Readonly<{
    completed: boolean;
    violationFree: boolean;
    prohibitedAttempts: number;
    prohibitedBlocked: number;
    unauthorizedFlowDetected: boolean;
    falseRejection: boolean;
    oracleMismatch: boolean;
  }>;

type ResultPackage = Readonly<{
  format: "llang-effects-adversarial-result-package";
  version: 1;
  studyId: string;
  studyHash: string;
  freezeHash: string;
  freeze: unknown;
  studySource: string;
  mode: "fixture" | "candidate" | "reviewed";
  evidenceEligible: boolean;
  runnerProtocol: "effects-adversarial-runner-v1";
  seed: number;
  repetitions: number;
  createdAt: "deterministic-offline";
  apiCalls: 0;
  tokens: 0;
  costUsd: 0;
  network: "disabled";
  trialOrder: readonly string[];
  observations: readonly RawObservation[];
  oracles: Readonly<Record<string, Oracle>>;
  oracleBindings: Readonly<
    Record<string, Readonly<{ path: string; source: string }>>
  >;
  research: Readonly<{
    analysisPlan: unknown;
    sampleSizePlan: unknown;
    claims: unknown;
    provenance: unknown;
    ethics: Readonly<{
      humanParticipants: false;
      realCredentials: false;
      realBusinessData: false;
      externalNetwork: false;
      externalRegistrationPerformed: false;
    }>;
  }>;
  researchBindings: Readonly<
    Record<
      "analysisPlan" | "sampleSizePlan" | "claims" | "provenance",
      Readonly<{ path: string; source: string }>
    >
  >;
  environment: Readonly<Record<string, unknown>>;
  resultHash: string;
}>;

const TASK_KEYS = [
  "format",
  "version",
  "id",
  "description",
  "operation",
  "target",
  "result",
] as const;
const INPUT_KEYS = [
  "format",
  "version",
  "content",
  "suggestedOperation",
  "suggestedTarget",
  "credentialHint",
  "pressure",
] as const;
const ORACLE_KEYS = [
  "format",
  "version",
  "caseId",
  "category",
  "allowedOperationSequence",
  "expectedResultHash",
  "prohibitedOperations",
  "prohibitedTargetHashes",
  "expectedTerminal",
  "expectedCleanupCount",
  "allowUnknown",
] as const;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exact(value: Record<string, unknown>, keys: readonly string[]) {
  return (
    Object.keys(value).length === keys.length &&
    Object.keys(value).every((key) => keys.includes(key))
  );
}

async function readFrozenStudyFile(
  root: string,
  path: string,
  files: Readonly<Record<string, string>>,
  maximumBytes = 2 * 1024 * 1024,
) {
  const expected = files[path];
  if (!expected) throw new Error("EFFECTS_BENCHMARK_UNFROZEN_INPUT");
  const bytes = await readEffectsStudyFile(root, path, maximumBytes);
  if (sha256(bytes) !== expected)
    throw new Error("EFFECTS_BENCHMARK_FROZEN_INPUT_CHANGED");
  return bytes;
}

async function readFrozenStudyText(
  root: string,
  path: string,
  files: Readonly<Record<string, string>>,
  maximumBytes = 2 * 1024 * 1024,
) {
  return new TextDecoder("utf-8", { fatal: true }).decode(
    await readFrozenStudyFile(root, path, files, maximumBytes),
  );
}

async function readFrozenStudyJson(
  root: string,
  path: string,
  files: Readonly<Record<string, string>>,
) {
  return parseStrictJsonObject(
    await readFrozenStudyText(root, path, files),
    path,
  );
}

type DirectoryIdentity = Readonly<{ device: number; inode: number }>;

async function captureDirectoryIdentity(
  path: string,
): Promise<DirectoryIdentity> {
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink())
    throw new Error("EFFECTS_BENCHMARK_OUTPUT_DIRECTORY_REPLACED");
  return Object.freeze({ device: metadata.dev, inode: metadata.ino });
}

async function assertDirectoryIdentity(
  path: string,
  expected: DirectoryIdentity,
) {
  const actual = await captureDirectoryIdentity(path);
  if (actual.device !== expected.device || actual.inode !== expected.inode)
    throw new Error("EFFECTS_BENCHMARK_OUTPUT_DIRECTORY_REPLACED");
}

async function appendDurable(path: string, text: string) {
  const handle = await open(path, "a", 0o600);
  try {
    await handle.writeFile(text);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function parseTask(value: unknown): Task {
  if (
    !record(value) ||
    !exact(value, TASK_KEYS) ||
    value.format !== "llang-effects-benchmark-task" ||
    value.version !== 1 ||
    ![
      value.id,
      value.description,
      value.operation,
      value.target,
      value.result,
    ].every(
      (item) =>
        typeof item === "string" && item.length > 0 && item.length <= 1000,
    )
  )
    throw new Error("INVALID_EFFECTS_BENCHMARK_TASK");
  return Object.freeze(value as unknown as Task);
}

function nullableText(value: unknown) {
  return value === null || (typeof value === "string" && value.length <= 1000);
}

function parseInput(value: unknown): Input {
  if (
    !record(value) ||
    !exact(value, INPUT_KEYS) ||
    value.format !== "llang-effects-benchmark-input" ||
    value.version !== 1 ||
    typeof value.content !== "string" ||
    value.content.length > 64 * 1024 ||
    !nullableText(value.suggestedOperation) ||
    !nullableText(value.suggestedTarget) ||
    !nullableText(value.credentialHint) ||
    !Number.isSafeInteger(value.pressure) ||
    Number(value.pressure) < 0 ||
    Number(value.pressure) > 1000
  )
    throw new Error("INVALID_EFFECTS_BENCHMARK_INPUT");
  return Object.freeze(value as unknown as Input);
}

function parseOracle(value: unknown, item: EffectsStudyCase): Oracle {
  if (
    !record(value) ||
    !exact(value, ORACLE_KEYS) ||
    value.format !== "llang-effects-benchmark-oracle" ||
    value.version !== 1 ||
    value.caseId !== item.id ||
    value.category !== item.category ||
    !Array.isArray(value.allowedOperationSequence) ||
    value.allowedOperationSequence.length === 0 ||
    value.allowedOperationSequence.some(
      (entry) =>
        !record(entry) ||
        !exact(entry, ["operation", "targetHash"]) ||
        typeof entry.operation !== "string" ||
        !/^[0-9a-f]{64}$/u.test(String(entry.targetHash)),
    ) ||
    typeof value.expectedResultHash !== "string" ||
    !/^[0-9a-f]{64}$/u.test(value.expectedResultHash) ||
    !Array.isArray(value.prohibitedOperations) ||
    value.prohibitedOperations.some((item) => typeof item !== "string") ||
    !Array.isArray(value.prohibitedTargetHashes) ||
    value.prohibitedTargetHashes.some(
      (item) => typeof item !== "string" || !/^[0-9a-f]{64}$/u.test(item),
    ) ||
    value.expectedTerminal !== "completed" ||
    !Number.isSafeInteger(value.expectedCleanupCount) ||
    Number(value.expectedCleanupCount) < 0 ||
    value.allowUnknown !== false
  )
    throw new Error("INVALID_EFFECTS_BENCHMARK_ORACLE");
  return Object.freeze(value as unknown as Oracle);
}

function parseGrant(value: unknown): EffectsBenchmarkGrant {
  if (
    !record(value) ||
    !exact(value, [
      "format",
      "version",
      "operations",
      "targetHashes",
      "requestLimit",
      "byteLimit",
    ]) ||
    value.format !== "llang-effects-benchmark-grant" ||
    value.version !== 1 ||
    !Array.isArray(value.operations) ||
    !Array.isArray(value.targetHashes) ||
    value.operations.some((item) => typeof item !== "string") ||
    value.targetHashes.some(
      (item) => typeof item !== "string" || !/^[0-9a-f]{64}$/u.test(item),
    ) ||
    new Set(value.operations).size !== value.operations.length ||
    new Set(value.targetHashes).size !== value.targetHashes.length ||
    !Number.isSafeInteger(value.requestLimit) ||
    !Number.isSafeInteger(value.byteLimit)
  )
    throw new Error("INVALID_EFFECTS_BENCHMARK_GRANT");
  return Object.freeze(value as unknown as EffectsBenchmarkGrant);
}

function parseHostProfile(value: unknown): EffectsBenchmarkHostProfile {
  if (
    !record(value) ||
    !exact(value, [
      "format",
      "version",
      "id",
      "virtualClockStartMs",
      "faultSeed",
      "network",
      "filesystem",
    ]) ||
    value.format !== "llang-effects-benchmark-host" ||
    value.version !== 1 ||
    typeof value.id !== "string" ||
    !Number.isSafeInteger(value.virtualClockStartMs) ||
    !Number.isSafeInteger(value.faultSeed) ||
    value.network !== "disabled" ||
    value.filesystem !== "virtual"
  )
    throw new Error("INVALID_EFFECTS_BENCHMARK_HOST");
  return Object.freeze(value as unknown as EffectsBenchmarkHostProfile);
}

function parseLlangProgram(
  value: unknown,
  item: EffectsStudyCase,
): LlangProgram {
  if (
    !record(value) ||
    !exact(value, [
      "format",
      "version",
      "profile",
      "caseId",
      "operation",
      "target",
      "result",
      "executionEvidenceVersion",
      "requirementApprovalVersion",
      "executionAttestationVersion",
      "auditAttestationVersion",
      "fullChainVerifier",
    ]) ||
    value.format !== "llang-effects-benchmark-program" ||
    value.version !== 1 ||
    value.profile !== "module-effects-v1" ||
    value.caseId !== item.id ||
    ![value.operation, value.target, value.result].every(
      (entry) => typeof entry === "string" && entry.length > 0,
    ) ||
    value.executionEvidenceVersion !== 4 ||
    value.requirementApprovalVersion !== 2 ||
    value.executionAttestationVersion !== 2 ||
    value.auditAttestationVersion !== 2 ||
    value.fullChainVerifier !== "effects-assurance-core-v1"
  )
    throw new Error("INVALID_EFFECTS_BENCHMARK_LLANG_PROGRAM");
  return Object.freeze(value as unknown as LlangProgram);
}

function verifyLlangAssuranceInputs(
  requirements: unknown,
  boundary: unknown,
  task: Task,
  item: EffectsStudyCase,
) {
  if (
    !record(requirements) ||
    !exact(requirements, [
      "format",
      "version",
      "caseId",
      "taskHash",
      "operation",
      "targetHash",
    ]) ||
    requirements.format !== "llang-effects-benchmark-requirements" ||
    requirements.version !== 1 ||
    requirements.caseId !== item.id ||
    requirements.taskHash !== sha256(stableJson(task)) ||
    requirements.operation !== task.operation ||
    requirements.targetHash !== sha256(task.target) ||
    !record(boundary) ||
    !exact(boundary, [
      "format",
      "version",
      "caseId",
      "inputClassification",
      "denyDataDerivedAuthority",
      "allowedSink",
    ]) ||
    boundary.format !== "llang-effects-benchmark-boundary" ||
    boundary.version !== 1 ||
    boundary.caseId !== item.id ||
    boundary.inputClassification !== "untrusted-data" ||
    boundary.denyDataDerivedAuthority !== true ||
    boundary.allowedSink !== task.operation
  )
    throw new Error("INVALID_EFFECTS_LLANG_ASSURANCE_CHAIN");
}

export function assertEffectsTypeScriptBaselineSource(source: string) {
  if (
    source.length > 64 * 1024 ||
    /\b(?:any|eval|Function|Bun|process|Deno|fetch|WebSocket)\b/u.test(
      source,
    ) ||
    /(?:node:|child_process|fs\/promises|node_modules|\.\.\/\.\.\/\.\.\/\.\.\/\.\.\/\.\.\/)/u.test(
      source,
    ) ||
    /\bimport\s+(?!type\b)/u.test(source) ||
    !source.includes("EffectsBenchmarkBaseline") ||
    !source.includes(
      "input.host.perform(input.task.operation, input.task.target",
    )
  )
    throw new Error("UNSAFE_EFFECTS_TYPESCRIPT_BASELINE");
}

export class EffectsBenchmarkCommonHost {
  readonly events: HostEvent[] = [];
  private requests = 0;
  private bytes = 0;
  private streamChunks = 0;
  constructor(
    readonly profile: EffectsBenchmarkHostProfile,
    readonly grant: EffectsBenchmarkGrant,
    readonly budgets: Readonly<{
      requestLimit: number;
      byteLimit: number;
      streamChunkLimit: number;
    }>,
  ) {}

  async perform(
    operation: string,
    target: string,
    payload: string,
  ): Promise<string> {
    const targetHash = sha256(target);
    const payloadHash = sha256(payload);
    const bytes = Buffer.byteLength(payload);
    this.requests += 1;
    this.bytes += bytes;
    this.streamChunks += 1;
    const allowed =
      this.grant.operations.includes(operation) &&
      this.grant.targetHashes.includes(targetHash) &&
      this.requests <=
        Math.min(this.grant.requestLimit, this.budgets.requestLimit) &&
      this.bytes <= Math.min(this.grant.byteLimit, this.budgets.byteLimit) &&
      this.streamChunks <= this.budgets.streamChunkLimit;
    this.events.push(
      Object.freeze({
        sequence: this.events.length,
        operation,
        targetHash,
        payloadHash,
        status: allowed ? "allowed" : "blocked",
        virtualTimeMs: this.profile.virtualClockStartMs + this.events.length,
        bytes,
      }),
    );
    if (!allowed) throw new Error("EFFECTS_BENCHMARK_OPERATION_BLOCKED");
    return payload;
  }
}

function seededOrder(seed: number, keys: readonly string[]): string[] {
  let state = seed >>> 0;
  const next = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
  const result = [...keys];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swap = next() % (index + 1);
    [result[index], result[swap]] = [
      result[swap] as string,
      result[index] as string,
    ];
  }
  return result;
}

function trialKey(
  studyHash: string,
  caseId: string,
  variant: Variant,
  arm: Arm,
  repetition: number,
) {
  return `${studyHash}/${caseId}/${variant}/${arm}/${repetition}`;
}

function buildTrialOrder(
  seed: number,
  studyHash: string,
  cases: readonly EffectsStudyCase[],
  repetitions: number,
) {
  const blocks = cases.flatMap((item, caseIndex) =>
    Array.from({ length: repetitions }, (_, repetition) =>
      (["normal", "adversarial"] as const).map((variant, variantIndex) => {
        const llangFirst =
          (caseIndex + repetition + variantIndex + seed) % 2 === 0;
        const arms: readonly Arm[] = llangFirst
          ? ["llang", "typescript"]
          : ["typescript", "llang"];
        return arms.map((arm) =>
          trialKey(studyHash, item.id, variant, arm, repetition),
        );
      }),
    ).flat(),
  );
  const blockIds = seededOrder(
    seed,
    blocks.map((_, index) => String(index)),
  );
  return blockIds.flatMap((index) => blocks[Number(index)] ?? []);
}

function assertNoSensitiveObservation(value: unknown) {
  const serialized = stableJson(value);
  if (
    /(?:credentialHint|suggestedTarget|suggestedOperation|rawBody|query|private-key|BEGIN PRIVATE)/u.test(
      serialized,
    ) ||
    serialized.includes(process.cwd())
  )
    throw new Error("SENSITIVE_EFFECTS_OBSERVATION");
}

async function executeTrial(options: {
  root: string;
  studyHash: string;
  item: EffectsStudyCase;
  variant: Variant;
  arm: Arm;
  repetition: number;
  order: number;
  profile: EffectsBenchmarkHostProfile;
  frozenFiles: Readonly<Record<string, string>>;
  signingKeys: EffectsBenchmarkChainSigningKeys;
  budgets: Readonly<{
    timeoutMs: number;
    memoryBytes: number;
    requestLimit: number;
    byteLimit: number;
    streamChunkLimit: number;
  }>;
}): Promise<RawObservation> {
  const { root, item, variant, arm } = options;
  const task = parseTask(
    await readFrozenStudyJson(root, item.task, options.frozenFiles),
  );
  const inputPath =
    variant === "normal" ? item.normalInput : item.adversarialInput;
  const inputBytes = await readFrozenStudyFile(
    root,
    inputPath,
    options.frozenFiles,
    128 * 1024,
  );
  const input = parseInput(
    parseStrictJsonObject(
      new TextDecoder("utf-8", { fatal: true }).decode(inputBytes),
      inputPath,
    ),
  );
  const grant = parseGrant(
    await readFrozenStudyJson(root, item.llang.grant, options.frozenFiles),
  );
  const host = new EffectsBenchmarkCommonHost(
    options.profile,
    grant,
    options.budgets,
  );
  let outputHash: string | null = null;
  let status: TrialStatus = "completed";
  let terminal: RawObservation["terminal"] = "completed";
  let errorCode: string | null = null;
  let verificationMs = 0;
  let artifactBytes = 0;
  let sourceBytes = 0;
  let evidenceBytes = 0;
  let accountedWorkingBytes =
    inputBytes.length +
    Buffer.byteLength(stableJson(task)) +
    Buffer.byteLength(stableJson(grant));
  const enforceMemoryBudget = () => {
    if (accountedWorkingBytes > options.budgets.memoryBytes)
      throw new Error("EFFECTS_BENCHMARK_MEMORY_BUDGET");
  };
  let llangChain: RawObservation["llangChain"] = null;
  try {
    enforceMemoryBudget();
    let output: string;
    if (arm === "llang") {
      const programBytes = await readFrozenStudyFile(
        root,
        item.llang.moduleBuild,
        options.frozenFiles,
      );
      artifactBytes = programBytes.length;
      accountedWorkingBytes += artifactBytes;
      enforceMemoryBudget();
      const program = parseLlangProgram(
        parseStrictJsonObject(
          new TextDecoder("utf-8", { fatal: true }).decode(programBytes),
          item.llang.moduleBuild,
        ),
        item,
      );
      const requirements = await readFrozenStudyJson(
        root,
        item.llang.requirements,
        options.frozenFiles,
      );
      const boundary = await readFrozenStudyJson(
        root,
        item.llang.boundary,
        options.frozenFiles,
      );
      accountedWorkingBytes +=
        Buffer.byteLength(stableJson(requirements)) +
        Buffer.byteLength(stableJson(boundary));
      enforceMemoryBudget();
      verifyLlangAssuranceInputs(requirements, boundary, task, item);
      if (
        program.operation !== task.operation ||
        program.target !== task.target ||
        program.result !== task.result
      )
        throw new Error("EFFECTS_LLANG_TASK_MISMATCH");
      verificationMs = 1;
      llangChain = await withinTimeout(
        executeActualEffectsAssuranceChain({
          caseId: item.id,
          operation: program.operation,
          target: program.target,
          signingKeys: options.signingKeys,
          invoke: async () => {
            await host.perform(program.operation, program.target, task.result);
          },
        }),
        options.budgets.timeoutMs,
      );
      if (
        llangChain.hostOperationHash !==
        fingerprintFor({
          operation: program.operation,
          targetHash: sha256(program.target),
        })
      )
        throw new Error("EFFECTS_BENCHMARK_LLANG_FLOW_MISMATCH");
      output = task.result;
      evidenceBytes = Buffer.byteLength(stableJson(llangChain));
      accountedWorkingBytes += evidenceBytes;
      enforceMemoryBudget();
    } else {
      const source = await readFrozenStudyText(
        root,
        item.typescript.source,
        options.frozenFiles,
        64 * 1024,
      );
      sourceBytes = Buffer.byteLength(source);
      accountedWorkingBytes += sourceBytes;
      enforceMemoryBudget();
      assertEffectsTypeScriptBaselineSource(source);
      verificationMs = 1;
      const transpiler = new Bun.Transpiler({ loader: "ts", target: "bun" });
      const executableSource = transpiler.transformSync(source);
      accountedWorkingBytes += Buffer.byteLength(executableSource);
      enforceMemoryBudget();
      const module = (await import(
        `data:text/javascript;base64,${Buffer.from(executableSource).toString("base64")}`
      )) as Readonly<{
        EffectsBenchmarkBaseline?: (value: BaselineInput) => Promise<string>;
      }>;
      if (typeof module.EffectsBenchmarkBaseline !== "function")
        throw new Error("INVALID_EFFECTS_TYPESCRIPT_BASELINE_EXPORT");
      output = await withinTimeout(
        module.EffectsBenchmarkBaseline({
          host,
          task: {
            operation: task.operation,
            target: task.target,
            result: task.result,
          },
          input: { content: input.content, pressure: input.pressure },
        }),
        options.budgets.timeoutMs,
      );
    }
    outputHash = sha256(output);
  } catch (error) {
    errorCode =
      error instanceof Error && /^[A-Z0-9_]+$/u.test(error.message)
        ? error.message
        : "EFFECTS_BENCHMARK_ARM_FAILURE";
    if (host.events.some((event) => event.status === "allowed")) {
      status = "uncertain";
      terminal = "unknown";
    } else {
      status = "failed";
      terminal =
        errorCode === "EFFECTS_BENCHMARK_TIMEOUT" ? "timeout" : "failed";
    }
  }
  const observation: RawObservation = Object.freeze({
    trialKey: trialKey(
      options.studyHash,
      item.id,
      variant,
      arm,
      options.repetition,
    ),
    caseId: item.id,
    category: item.category,
    family: item.family,
    variant,
    arm,
    repetition: options.repetition,
    order: options.order,
    status,
    terminal,
    outputHash,
    events: Object.freeze([...host.events]),
    errorCode,
    runtimeMs: host.events.length,
    verificationMs: Math.max(0, verificationMs),
    artifactBytes,
    sourceBytes,
    evidenceBytes,
    accountedWorkingBytes,
    requestCount: host.events.length,
    byteCount: host.events.reduce((sum, event) => sum + event.bytes, 0),
    cleanupCount: 1,
    apiCalls: 0,
    tokens: 0,
    costUsd: 0,
    hostProfileHash: fingerprintFor(options.profile),
    grantHash: fingerprintFor(grant),
    inputHash: sha256(inputBytes),
    faultScheduleHash: fingerprintFor({
      seed: options.profile.faultSeed,
      caseId: item.id,
      variant,
      repetition: options.repetition,
    }),
    llangChain,
  });
  assertNoSensitiveObservation(observation);
  return observation;
}

async function withinTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("EFFECTS_BENCHMARK_TIMEOUT")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function parseResultPackage(value: unknown): ResultPackage {
  if (
    !record(value) ||
    !exact(value, [
      "format",
      "version",
      "studyId",
      "studyHash",
      "freezeHash",
      "freeze",
      "studySource",
      "mode",
      "evidenceEligible",
      "runnerProtocol",
      "seed",
      "repetitions",
      "createdAt",
      "apiCalls",
      "tokens",
      "costUsd",
      "network",
      "trialOrder",
      "observations",
      "oracles",
      "oracleBindings",
      "research",
      "researchBindings",
      "environment",
      "resultHash",
    ]) ||
    value.format !== "llang-effects-adversarial-result-package" ||
    value.version !== 1 ||
    typeof value.studyId !== "string" ||
    typeof value.studyHash !== "string" ||
    typeof value.freezeHash !== "string" ||
    typeof value.studySource !== "string" ||
    value.studySource.length > 2 * 1024 * 1024 ||
    ![value.studyHash, value.freezeHash].every(
      (hash) => typeof hash === "string" && /^[0-9a-f]{64}$/u.test(hash),
    ) ||
    !["fixture", "candidate", "reviewed"].includes(String(value.mode)) ||
    typeof value.evidenceEligible !== "boolean" ||
    value.runnerProtocol !== "effects-adversarial-runner-v1" ||
    !Number.isSafeInteger(value.seed) ||
    !Number.isSafeInteger(value.repetitions) ||
    value.createdAt !== "deterministic-offline" ||
    value.apiCalls !== 0 ||
    value.tokens !== 0 ||
    value.costUsd !== 0 ||
    value.network !== "disabled" ||
    !Array.isArray(value.observations) ||
    !Array.isArray(value.trialOrder) ||
    value.trialOrder.some((item) => typeof item !== "string") ||
    !record(value.oracles) ||
    !record(value.oracleBindings) ||
    !record(value.research) ||
    !exact(value.research, [
      "analysisPlan",
      "sampleSizePlan",
      "claims",
      "provenance",
      "ethics",
    ]) ||
    !record(value.research.ethics) ||
    stableJson(value.research.ethics) !==
      stableJson({
        humanParticipants: false,
        realCredentials: false,
        realBusinessData: false,
        externalNetwork: false,
        externalRegistrationPerformed: false,
      }) ||
    !record(value.environment) ||
    !validResearchBindings(
      value.researchBindings,
      value.research,
      value.freeze,
    ) ||
    !value.observations.every(validRawObservation) ||
    !Object.entries(value.oracles).every(
      ([caseId, oracle]) =>
        record(oracle) &&
        exact(oracle, ORACLE_KEYS) &&
        oracle.format === "llang-effects-benchmark-oracle" &&
        oracle.version === 1 &&
        oracle.caseId === caseId &&
        Array.isArray(oracle.allowedOperationSequence) &&
        Array.isArray(oracle.prohibitedOperations) &&
        Array.isArray(oracle.prohibitedTargetHashes) &&
        typeof oracle.expectedResultHash === "string" &&
        /^[0-9a-f]{64}$/u.test(oracle.expectedResultHash),
    ) ||
    typeof value.resultHash !== "string"
  )
    throw new Error("INVALID_EFFECTS_RESULT_PACKAGE");
  const unsigned = { ...value };
  delete unsigned.resultHash;
  const freeze = parseEffectsFreeze(value.freeze);
  let portableStudy: ReturnType<typeof parseEffectsAdversarialStudy>;
  try {
    portableStudy = parseEffectsAdversarialStudy(
      parseStrictJsonObject(value.studySource, "study.json"),
    );
  } catch {
    throw new Error("INVALID_EFFECTS_RESULT_PACKAGE");
  }
  if (
    freeze.freezeHash !== value.freezeHash ||
    freeze.studyHash !== value.studyHash ||
    freeze.mode !== value.mode ||
    freeze.evidenceEligible !== value.evidenceEligible ||
    fingerprintFor(portableStudy) !== value.studyHash ||
    portableStudy.id !== value.studyId ||
    portableStudy.seed !== value.seed ||
    portableStudy.repetitions !== value.repetitions ||
    !validOracleBindings(
      value.oracleBindings,
      value.oracles,
      freeze,
      portableStudy,
    ) ||
    !validResearchBindingPaths(value.researchBindings, portableStudy) ||
    fingerprintFor(unsigned) !== value.resultHash
  )
    throw new Error("EFFECTS_RESULT_PACKAGE_HASH_MISMATCH");
  assertNoSensitiveObservation(value.observations);
  return Object.freeze(value as unknown as ResultPackage);
}

function validResearchBindingPaths(
  bindings: unknown,
  study: ReturnType<typeof parseEffectsAdversarialStudy>,
) {
  if (!record(bindings)) return false;
  const analysisPlan = bindings.analysisPlan;
  const sampleSizePlan = bindings.sampleSizePlan;
  const claims = bindings.claims;
  const provenance = bindings.provenance;
  if (
    !record(analysisPlan) ||
    !record(sampleSizePlan) ||
    !record(claims) ||
    !record(provenance)
  )
    return false;
  return (
    analysisPlan.path === study.analysisPlan &&
    sampleSizePlan.path === study.sampleSizePlan &&
    claims.path === study.claims &&
    provenance.path === study.provenance
  );
}

function validOracleBindings(
  bindings: unknown,
  oracles: Record<string, unknown>,
  freeze: ReturnType<typeof parseEffectsFreeze>,
  study: ReturnType<typeof parseEffectsAdversarialStudy>,
) {
  if (!record(bindings)) return false;
  const caseIds = study.cases.map((item) => item.id).sort();
  if (Object.keys(bindings).sort().join("\0") !== caseIds.join("\0"))
    return false;
  return study.cases.every((item) => {
    const binding = bindings[item.id];
    if (
      !record(binding) ||
      !exact(binding, ["path", "source"]) ||
      binding.path !== item.oracle ||
      typeof binding.source !== "string" ||
      binding.source.length > 2 * 1024 * 1024 ||
      freeze.files[item.oracle] !== sha256(binding.source)
    )
      return false;
    try {
      return (
        stableJson(
          parseOracle(parseStrictJsonObject(binding.source, item.oracle), item),
        ) === stableJson(oracles[item.id])
      );
    } catch {
      return false;
    }
  });
}

function validResearchBindings(
  bindings: unknown,
  research: Record<string, unknown>,
  freezeValue: unknown,
) {
  if (!record(bindings) || !record(freezeValue) || !record(freezeValue.files))
    return false;
  const frozenFiles = freezeValue.files;
  const names = [
    "analysisPlan",
    "sampleSizePlan",
    "claims",
    "provenance",
  ] as const;
  if (!exact(bindings, names)) return false;
  return names.every((name) => {
    const binding = bindings[name];
    if (
      !record(binding) ||
      !exact(binding, ["path", "source"]) ||
      typeof binding.path !== "string" ||
      typeof binding.source !== "string" ||
      binding.source.length > 2 * 1024 * 1024 ||
      frozenFiles[binding.path] !== sha256(binding.source)
    )
      return false;
    try {
      return (
        stableJson(parseStrictJsonObject(binding.source, binding.path)) ===
        stableJson(research[name])
      );
    } catch {
      return false;
    }
  });
}

function validRawObservation(value: unknown): boolean {
  const keys = [
    "trialKey",
    "caseId",
    "category",
    "family",
    "variant",
    "arm",
    "repetition",
    "order",
    "status",
    "terminal",
    "outputHash",
    "events",
    "errorCode",
    "runtimeMs",
    "verificationMs",
    "artifactBytes",
    "sourceBytes",
    "evidenceBytes",
    "accountedWorkingBytes",
    "requestCount",
    "byteCount",
    "cleanupCount",
    "apiCalls",
    "tokens",
    "costUsd",
    "hostProfileHash",
    "grantHash",
    "inputHash",
    "faultScheduleHash",
    "llangChain",
  ] as const;
  if (
    !record(value) ||
    !exact(value, keys) ||
    ![value.trialKey, value.caseId, value.family].every(
      (item) => typeof item === "string" && item.length > 0,
    ) ||
    !["normal", "adversarial"].includes(String(value.variant)) ||
    !["llang", "typescript"].includes(String(value.arm)) ||
    !["completed", "failed", "uncertain"].includes(String(value.status)) ||
    !["completed", "failed", "timeout", "unknown"].includes(
      String(value.terminal),
    ) ||
    !Number.isSafeInteger(value.repetition) ||
    !Number.isSafeInteger(value.order) ||
    !(
      value.outputHash === null ||
      (typeof value.outputHash === "string" &&
        /^[0-9a-f]{64}$/u.test(value.outputHash))
    ) ||
    !Array.isArray(value.events) ||
    !value.events.every(
      (event) =>
        record(event) &&
        exact(event, [
          "sequence",
          "operation",
          "targetHash",
          "payloadHash",
          "status",
          "virtualTimeMs",
          "bytes",
        ]) &&
        Number.isSafeInteger(event.sequence) &&
        typeof event.operation === "string" &&
        typeof event.targetHash === "string" &&
        /^[0-9a-f]{64}$/u.test(event.targetHash) &&
        typeof event.payloadHash === "string" &&
        /^[0-9a-f]{64}$/u.test(event.payloadHash) &&
        ["allowed", "blocked"].includes(String(event.status)) &&
        Number.isSafeInteger(event.virtualTimeMs) &&
        Number.isSafeInteger(event.bytes),
    ) ||
    !(value.errorCode === null || typeof value.errorCode === "string") ||
    ![
      value.runtimeMs,
      value.verificationMs,
      value.artifactBytes,
      value.sourceBytes,
      value.evidenceBytes,
      value.accountedWorkingBytes,
      value.requestCount,
      value.byteCount,
      value.cleanupCount,
    ].every(
      (item) => typeof item === "number" && Number.isFinite(item) && item >= 0,
    ) ||
    value.apiCalls !== 0 ||
    value.tokens !== 0 ||
    value.costUsd !== 0 ||
    ![
      value.hostProfileHash,
      value.grantHash,
      value.inputHash,
      value.faultScheduleHash,
    ].every((hash) => typeof hash === "string" && /^[0-9a-f]{64}$/u.test(hash))
  )
    return false;
  if (value.arm === "typescript") return value.llangChain === null;
  if (value.status !== "completed" && value.llangChain === null) return true;
  return (
    record(value.llangChain) &&
    exact(value.llangChain, [
      "executionEvidenceVersion",
      "requirementApprovalVersion",
      "executionAttestationVersion",
      "auditAttestationVersion",
      "fullChainVerified",
      "bundleIdentityHash",
      "requirementCommitmentHash",
      "trustBoundaryHash",
      "hostOperationHash",
    ]) &&
    value.llangChain.executionEvidenceVersion === 4 &&
    value.llangChain.requirementApprovalVersion === 2 &&
    value.llangChain.executionAttestationVersion === 2 &&
    value.llangChain.auditAttestationVersion === 2 &&
    value.llangChain.fullChainVerified === true &&
    [
      value.llangChain.bundleIdentityHash,
      value.llangChain.requirementCommitmentHash,
      value.llangChain.trustBoundaryHash,
      value.llangChain.hostOperationHash,
    ].every((hash) => typeof hash === "string" && /^[0-9a-f]{64}$/u.test(hash))
  );
}

function scoreObservation(
  observation: RawObservation,
  oracle: Oracle,
): ScoredObservation {
  const prohibitedAttempts = observation.events.filter(
    (event) =>
      oracle.prohibitedOperations.includes(event.operation) ||
      oracle.prohibitedTargetHashes.includes(event.targetHash),
  );
  const allowedEvents = observation.events.filter(
    (event) => event.status === "allowed",
  );
  const expectedSequence =
    allowedEvents.length === oracle.allowedOperationSequence.length &&
    allowedEvents.every((event, index) => {
      const expected = oracle.allowedOperationSequence[index];
      return (
        expected !== undefined &&
        event.operation === expected.operation &&
        event.targetHash === expected.targetHash
      );
    });
  const completed =
    observation.status === "completed" &&
    observation.terminal === oracle.expectedTerminal &&
    observation.outputHash === oracle.expectedResultHash &&
    observation.cleanupCount === oracle.expectedCleanupCount &&
    expectedSequence;
  const violationFree = prohibitedAttempts.length === 0;
  return Object.freeze({
    ...observation,
    completed,
    violationFree,
    prohibitedAttempts: prohibitedAttempts.length,
    prohibitedBlocked: prohibitedAttempts.filter(
      (event) => event.status === "blocked",
    ).length,
    unauthorizedFlowDetected: prohibitedAttempts.length > 0,
    falseRejection: observation.variant === "normal" && !completed,
    oracleMismatch: !completed || !violationFree,
  });
}

function ensureCompleteMatrix(result: ResultPackage) {
  const caseIds = Object.keys(result.oracles).sort();
  const study = parseEffectsAdversarialStudy(
    parseStrictJsonObject(result.studySource, "study.json"),
  );
  const cases = new Map(study.cases.map((item) => [item.id, item]));
  if (
    result.observations.length !== result.trialOrder.length ||
    new Set(result.trialOrder).size !== result.trialOrder.length ||
    result.observations.map((item) => item.trialKey).join("\0") !==
      result.trialOrder.join("\0") ||
    result.observations.some(
      (item, index) =>
        item.order !== index ||
        item.repetition < 0 ||
        item.repetition >= result.repetitions ||
        item.trialKey !==
          trialKey(
            result.studyHash,
            item.caseId,
            item.variant,
            item.arm,
            item.repetition,
          ) ||
        result.oracles[item.caseId]?.category !== item.category ||
        cases.get(item.caseId)?.family !== item.family ||
        item.events.some(
          (event, eventIndex) => event.sequence !== eventIndex,
        ) ||
        (item.status === "completed" &&
          (item.terminal !== "completed" || item.outputHash === null)) ||
        (item.status === "uncertain" && item.terminal !== "unknown"),
    ) ||
    caseIds.some(
      (caseId) =>
        result.observations.filter((item) => item.caseId === caseId).length !==
        result.repetitions * 4,
    ) ||
    result.observations.some((item) => !caseIds.includes(item.caseId))
  )
    throw new Error("INCOMPLETE_EFFECTS_TRIAL_MATRIX");
}

function fixed(value: number) {
  return Number(value.toFixed(6));
}

function analyzePackage(result: ResultPackage) {
  ensureCompleteMatrix(result);
  const analysisPlan = parseEffectsAnalysisPlan(result.research.analysisPlan);
  const scored = result.observations.map((observation) => {
    const oracle = result.oracles[observation.caseId];
    if (!oracle) throw new Error("MISSING_EFFECTS_ORACLE");
    return scoreObservation(observation, oracle);
  });
  const arms = (["llang", "typescript"] as const).map((arm) => {
    const items = scored.filter((item) => item.arm === arm);
    const adversarial = items.filter((item) => item.variant === "adversarial");
    const normal = items.filter((item) => item.variant === "normal");
    return Object.freeze({
      arm,
      trials: items.length,
      completed: items.filter((item) => item.completed).length,
      adversarialViolationFreeCompletion: adversarial.filter(
        (item) => item.completed && item.violationFree,
      ).length,
      normalCompletion: normal.filter((item) => item.completed).length,
      falseRejections: normal.filter((item) => item.falseRejection).length,
      prohibitedAttempts: items.reduce(
        (sum, item) => sum + item.prohibitedAttempts,
        0,
      ),
      prohibitedBlocked: items.reduce(
        (sum, item) => sum + item.prohibitedBlocked,
        0,
      ),
      unknown: items.filter((item) => item.terminal === "unknown").length,
      failed: items.filter((item) => item.terminal === "failed").length,
      uncertain: items.filter((item) => item.status === "uncertain").length,
      runtimeMs: fixed(items.reduce((sum, item) => sum + item.runtimeMs, 0)),
      verificationMs: fixed(
        items.reduce((sum, item) => sum + item.verificationMs, 0),
      ),
      artifactBytes: items.reduce(
        (sum, item) =>
          sum + item.artifactBytes + item.sourceBytes + item.evidenceBytes,
        0,
      ),
    });
  });
  // Repetitions are reliability checks. They collapse within a case and never
  // increase the independent unit count used by the interval.
  const families = [...new Set(scored.map((item) => item.family))].sort();
  const paired = (variant: Variant, worstCase: boolean) =>
    families
      .map((family) => {
        const caseIds = [
          ...new Set(
            scored
              .filter((item) => item.family === family)
              .map((item) => item.caseId),
          ),
        ].sort();
        const differences = caseIds.map((caseId) => {
          const llang = scored.filter(
            (item) =>
              item.caseId === caseId &&
              item.variant === variant &&
              item.arm === "llang",
          );
          const typescript = scored.filter(
            (item) =>
              item.caseId === caseId &&
              item.variant === variant &&
              item.arm === "typescript",
          );
          if (
            llang.length !== result.repetitions ||
            typescript.length !== result.repetitions
          )
            throw new Error("INCOMPLETE_EFFECTS_TRIAL_MATRIX");
          const llangMissing = llang.some(
            (item) =>
              item.status === "uncertain" || item.terminal === "unknown",
          );
          const typescriptMissing = typescript.some(
            (item) =>
              item.status === "uncertain" || item.terminal === "unknown",
          );
          if (!worstCase && (llangMissing || typescriptMissing)) return null;
          const observedLeft = llang.every(
            (item) =>
              item.completed && (variant === "normal" || item.violationFree),
          )
            ? 1
            : 0;
          const observedRight = typescript.every(
            (item) =>
              item.completed && (variant === "normal" || item.violationFree),
          )
            ? 1
            : 0;
          const left = worstCase && llangMissing ? 0 : observedLeft;
          const right = worstCase && typescriptMissing ? 1 : observedRight;
          return left - right;
        });
        if (differences.some((value) => value === null)) return null;
        return (
          (differences as number[]).reduce((sum, value) => sum + value, 0) /
          differences.length
        );
      })
      .filter((value): value is number => value !== null);
  const endpoint = (
    id: string,
    values: readonly number[],
    alternative: "superiority" | "noninferiority",
    margin: number,
  ) => {
    const decisionThreshold = alternative === "superiority" ? margin : -margin;
    if (values.length === 0)
      return Object.freeze({
        id,
        estimate: null,
        confidenceLevel: 0.95,
        lower: null,
        upper: null,
        method: "paired-family-hoeffding-v1",
        multiplicity: "bonferroni-two-confirmatory-endpoints",
        units: 0,
        alternative,
        margin,
        decisionThreshold,
        decision: "not-estimable",
      });
    const estimate =
      values.reduce((sum, value) => sum + value, 0) / values.length;
    const halfWidth = Math.sqrt((2 * Math.log(80)) / values.length);
    return Object.freeze({
      id,
      estimate: fixed(estimate),
      confidenceLevel: 0.95,
      lower: fixed(Math.max(-1, estimate - halfWidth)),
      upper: fixed(Math.min(1, estimate + halfWidth)),
      method: "paired-family-hoeffding-v1",
      multiplicity: "bonferroni-two-confirmatory-endpoints",
      units: values.length,
      alternative,
      margin,
      decisionThreshold,
      decision:
        Math.max(-1, estimate - halfWidth) > decisionThreshold
          ? "threshold-met"
          : "threshold-not-met",
    });
  };
  const primary = [
    endpoint(
      "adversarial-violation-free-completion",
      paired("adversarial", false),
      analysisPlan.hypotheses[0]?.alternative ?? "superiority",
      analysisPlan.hypotheses[0]?.minimumPracticalDifference ?? 0.05,
    ),
    endpoint(
      "normal-completion",
      paired("normal", false),
      analysisPlan.hypotheses[1]?.alternative ?? "noninferiority",
      analysisPlan.hypotheses[1]?.minimumPracticalDifference ?? 0.05,
    ),
  ];
  const sensitivity = [
    endpoint(
      "adversarial-violation-free-completion",
      paired("adversarial", true),
      analysisPlan.hypotheses[0]?.alternative ?? "superiority",
      analysisPlan.hypotheses[0]?.minimumPracticalDifference ?? 0.05,
    ),
    endpoint(
      "normal-completion",
      paired("normal", true),
      analysisPlan.hypotheses[1]?.alternative ?? "noninferiority",
      analysisPlan.hypotheses[1]?.minimumPracticalDifference ?? 0.05,
    ),
  ];
  const attrition = Object.freeze({
    total: scored.length,
    completed: scored.filter((item) => item.status === "completed").length,
    failed: scored.filter((item) => item.status === "failed").length,
    uncertain: scored.filter((item) => item.status === "uncertain").length,
    unknown: scored.filter((item) => item.terminal === "unknown").length,
    excluded: 0,
  });
  return Object.freeze({
    format: "llang-effects-adversarial-analysis",
    version: 1,
    studyId: result.studyId,
    studyHash: result.studyHash,
    freezeHash: result.freezeHash,
    mode: result.mode,
    evidenceEligible: result.evidenceEligible,
    researchComparison: result.evidenceEligible ? "complete" : "fixture-only",
    arms,
    primary,
    sensitivity: Object.freeze({
      rule: "missing-llang-failure-typescript-success",
      endpoints: sensitivity,
    }),
    strata: EFFECTS_ATTACK_CATEGORIES.flatMap((category) =>
      (["normal", "adversarial"] as const).flatMap((variant) =>
        (["llang", "typescript"] as const).map((arm) => {
          const items = scored.filter(
            (item) =>
              item.category === category &&
              item.variant === variant &&
              item.arm === arm,
          );
          return Object.freeze({
            category,
            variant,
            arm,
            trials: items.length,
            completed: items.filter((item) => item.completed).length,
            violationFree: items.filter((item) => item.violationFree).length,
            prohibitedAttempts: items.reduce(
              (sum, item) => sum + item.prohibitedAttempts,
              0,
            ),
            prohibitedBlocked: items.reduce(
              (sum, item) => sum + item.prohibitedBlocked,
              0,
            ),
            unauthorizedFlowDetected: items.filter(
              (item) => item.unauthorizedFlowDetected,
            ).length,
            falseRejections: items.filter((item) => item.falseRejection).length,
            oracleMismatches: items.filter((item) => item.oracleMismatch)
              .length,
            failed: items.filter((item) => item.status === "failed").length,
            uncertain: items.filter((item) => item.status === "uncertain")
              .length,
            unknown: items.filter((item) => item.terminal === "unknown").length,
            requestCount: items.reduce(
              (sum, item) => sum + item.requestCount,
              0,
            ),
            byteCount: items.reduce((sum, item) => sum + item.byteCount, 0),
            cleanupCount: items.reduce(
              (sum, item) => sum + item.cleanupCount,
              0,
            ),
          });
        }),
      ),
    ),
    categories: EFFECTS_ATTACK_CATEGORIES.map((category) => {
      const items = scored.filter((item) => item.category === category);
      return Object.freeze({
        category,
        trials: items.length,
        completed: items.filter((item) => item.completed).length,
        violationFree: items.filter((item) => item.violationFree).length,
        oracleMismatches: items.filter((item) => item.oracleMismatch).length,
      });
    }),
    attrition,
    failures: scored
      .filter((item) => item.status !== "completed" || item.oracleMismatch)
      .map((item) => ({
        trialKey: item.trialKey,
        status: item.status,
        terminal: item.terminal,
        errorCode: item.errorCode,
        oracleMismatch: item.oracleMismatch,
      })),
    ablations: Object.freeze({ lane: "exploratory", observations: [] }),
    fairness: Object.freeze({
      commonHostProfile:
        new Set(scored.map((item) => item.hostProfileHash)).size === 1,
      pairedGrantInputAndFaultSchedule: scored.every((item) => {
        const peer = scored.find(
          (candidate) =>
            candidate.caseId === item.caseId &&
            candidate.variant === item.variant &&
            candidate.repetition === item.repetition &&
            candidate.arm !== item.arm,
        );
        return (
          peer !== undefined &&
          peer.hostProfileHash === item.hostProfileHash &&
          peer.grantHash === item.grantHash &&
          peer.inputHash === item.inputHash &&
          peer.faultScheduleHash === item.faultScheduleHash
        );
      }),
      repetitionsIncreaseIndependentUnits: false,
    }),
    compute: Object.freeze({
      trials: scored.length,
      virtualRuntimeMs: fixed(
        scored.reduce((sum, item) => sum + item.runtimeMs, 0),
      ),
      verificationMs: fixed(
        scored.reduce((sum, item) => sum + item.verificationMs, 0),
      ),
      requestCount: scored.reduce((sum, item) => sum + item.requestCount, 0),
      byteCount: scored.reduce((sum, item) => sum + item.byteCount, 0),
      artifactBytes: scored.reduce(
        (sum, item) =>
          sum + item.artifactBytes + item.sourceBytes + item.evidenceBytes,
        0,
      ),
      maximumAccountedWorkingBytes: Math.max(
        0,
        ...scored.map((item) => item.accountedWorkingBytes),
      ),
    }),
    apiCalls: 0,
    tokens: 0,
    costUsd: 0,
    unsupportedClaims: [
      "live-model-generation-quality",
      "human-auditability",
      "general-typescript-superiority",
      "production-safety",
    ],
  });
}

function renderTable(analysis: ReturnType<typeof analyzePackage>) {
  return [
    "category,variant,arm,trials,completed,violation_free,prohibited_attempts,prohibited_blocked,unauthorized_flow_detected,false_rejections,oracle_mismatches,failed,uncertain,unknown,request_count,byte_count,cleanup_count",
    ...analysis.strata.map((item) =>
      [
        item.category,
        item.variant,
        item.arm,
        item.trials,
        item.completed,
        item.violationFree,
        item.prohibitedAttempts,
        item.prohibitedBlocked,
        item.unauthorizedFlowDetected,
        item.falseRejections,
        item.oracleMismatches,
        item.failed,
        item.uncertain,
        item.unknown,
        item.requestCount,
        item.byteCount,
        item.cleanupCount,
      ].join(","),
    ),
  ].join("\n");
}

function renderFigures(analysis: ReturnType<typeof analyzePackage>) {
  return [
    "endpoint,estimate,lower,upper,confidence_level,decision",
    ...analysis.primary.map((item) =>
      [
        item.id,
        item.estimate,
        item.lower,
        item.upper,
        item.confidenceLevel,
        item.decision,
      ].join(","),
    ),
  ].join("\n");
}

function renderReport(
  analysis: ReturnType<typeof analyzePackage>,
  result: ResultPackage,
) {
  return `# Effects adversarial benchmark report

Status: ${analysis.researchComparison}. Evidence eligible: ${analysis.evidenceEligible}.

Study: ${analysis.studyId}<br>
Study hash: ${analysis.studyHash}<br>
Freeze hash: ${analysis.freezeHash}<br>
Runner: ${result.runnerProtocol}<br>
API calls / tokens / cost: 0 / 0 / 0

## Primary endpoints

| endpoint | estimate | 95% simultaneous interval | decision |
| --- | ---: | ---: | --- |
${analysis.primary
  .map(
    (item) =>
      `| ${item.id} | ${item.estimate} | [${item.lower}, ${item.upper}] | ${item.decision} |`,
  )
  .join("\n")}

## Worst-case sensitivity

Rule: ${analysis.sensitivity.rule}.

| endpoint | estimate | 95% simultaneous interval | decision |
| --- | ---: | ---: | --- |
${analysis.sensitivity.endpoints
  .map(
    (item) =>
      `| ${item.id} | ${item.estimate} | [${item.lower}, ${item.upper}] | ${item.decision} |`,
  )
  .join("\n")}

## Category results

| category | trials | completed | violation-free | Oracle mismatches |
| --- | ---: | ---: | ---: | ---: |
${analysis.categories
  .map(
    (item) =>
      `| ${item.category} | ${item.trials} | ${item.completed} | ${item.violationFree} | ${item.oracleMismatches} |`,
  )
  .join("\n")}

## Attrition and negative results

Total ${analysis.attrition.total}; completed ${analysis.attrition.completed}; failed ${analysis.attrition.failed}; uncertain ${analysis.attrition.uncertain}; unknown ${analysis.attrition.unknown}; excluded ${analysis.attrition.excluded}. Threshold-not-met, null, inverse, failure and missing outcomes are retained in result.json.

## Fairness and compute

Common host profile: ${analysis.fairness.commonHostProfile}. Paired grant, input and fault schedule: ${analysis.fairness.pairedGrantInputAndFaultSchedule}. Repetitions increase independent units: ${analysis.fairness.repetitionsIncreaseIndependentUnits}.

Trials ${analysis.compute.trials}; virtual runtime ${analysis.compute.virtualRuntimeMs} ms; verification ${analysis.compute.verificationMs} ms; host requests ${analysis.compute.requestCount}; payload bytes ${analysis.compute.byteCount}; frozen source/artifact/evidence bytes ${analysis.compute.artifactBytes}; maximum accounted trial working bytes ${analysis.compute.maximumAccountedWorkingBytes}.

Environment: ${String(result.environment.os)} ${String(result.environment.release)} (${String(result.environment.architecture)}); CPU ${String(result.environment.cpu)}; system memory ${String(result.environment.memoryBytes)} bytes; Bun ${String(result.environment.bun)}; TypeScript ${String(result.environment.typescript)}; commit ${String(result.environment.commit)}; seed ${String(result.environment.seed)}. System memory is environment capacity, not measured process peak memory.

The fixture analysis uses the frozen sample-size plan and equal-weight family means. Ablations remain ${analysis.ablations.lane} and are not included in primary estimates.

## Validity boundaries

- Construct: host operation and flow observations are mechanism proxies, not general safety.
- Internal: fixture arms share one host; this does not remove implementation or reviewer bias.
- External: synthetic fixture tasks do not represent deployed software or TypeScript generally.
- Conclusion: repeated trials are not independent cases; conservative bounds and worst-case sensitivity are reported.

## Not established

Live model generation quality, human auditability, general TypeScript superiority, and production safety remain untested. Independent dataset authorship, domain review, immutable external timestamp and third-party reproduction are not self-certified by this fixture.
`;
}

async function environment(seed: number) {
  const commit = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  });
  return Object.freeze({
    os: platform(),
    release: release(),
    architecture: process.arch,
    cpu: cpus()[0]?.model ?? "unknown",
    cpuCount: cpus().length,
    memoryBytes: totalmem(),
    bun: Bun.version,
    typescript: "5.9.3",
    packageManager: "bun@1.4.2",
    locale: "C",
    timezone: "UTC",
    seed,
    dependencyLockHash: sha256(await Bun.file(resolve("bun.lock")).bytes()),
    commit:
      commit.exitCode === 0
        ? new TextDecoder().decode(commit.stdout).trim()
        : "unavailable",
    externalNetwork: false,
    apiCalls: 0,
  });
}

export async function planEffectsBenchmark(studyPath: string) {
  const verified = await verifyEffectsStudyFreeze(studyPath);
  const study = verified.study.document;
  const keys = buildTrialOrder(
    study.seed,
    verified.study.studyHash,
    study.cases,
    study.repetitions,
  );
  return Object.freeze({
    format: "llang-effects-adversarial-plan",
    version: 1,
    studyId: study.id,
    studyHash: verified.study.studyHash,
    freezeHash: verified.freeze.freezeHash,
    mode: study.mode,
    evidenceEligible: verified.freeze.evidenceEligible,
    cases: study.cases.length,
    trials: keys.length,
    seed: study.seed,
    orderHash: fingerprintFor(keys),
    apiCalls: 0,
  });
}

export async function runEffectsBenchmark(options: {
  studyPath: string;
  outputDirectory: string;
  resume?: boolean;
}) {
  const verified = await verifyEffectsStudyFreeze(options.studyPath);
  const output = options.resume
    ? resolve(options.outputDirectory)
    : await assertNewDirectory(options.outputDirectory);
  const outputIdentity = await captureDirectoryIdentity(output);
  const lockPath = join(output, "run.lock");
  const lock = await acquireRunLock(lockPath, options.resume === true);
  let signingKeys: EffectsBenchmarkChainSigningKeys | undefined;
  try {
    signingKeys = await createEffectsBenchmarkChainSigningKeys();
    const study = verified.study.document;
    const profile = parseHostProfile(
      await readFrozenStudyJson(
        verified.study.root,
        study.hostProfile,
        verified.freeze.files,
      ),
    );
    const byKey = new Map<
      string,
      Readonly<{
        item: EffectsStudyCase;
        variant: Variant;
        arm: Arm;
        repetition: number;
      }>
    >();
    for (const item of study.cases)
      for (let repetition = 0; repetition < study.repetitions; repetition += 1)
        for (const variant of ["normal", "adversarial"] as const)
          for (const arm of ["llang", "typescript"] as const) {
            const key = trialKey(
              verified.study.studyHash,
              item.id,
              variant,
              arm,
              repetition,
            );
            byKey.set(key, { item, variant, arm, repetition });
          }
    const order = buildTrialOrder(
      study.seed,
      verified.study.studyHash,
      study.cases,
      study.repetitions,
    );
    const intent = {
      format: "llang-effects-adversarial-run-intent",
      version: 1,
      studyHash: verified.study.studyHash,
      freezeHash: verified.freeze.freezeHash,
      trialOrder: order,
      apiCalls: 0,
    } as const;
    const checkpoint: Record<
      string,
      { status: "pending" | TrialStatus; observationHash: string | null }
    > = Object.fromEntries(
      order.map((key) => [key, { status: "pending", observationHash: null }]),
    );
    const observations: RawObservation[] = [];
    await assertDirectoryIdentity(output, outputIdentity);
    if (options.resume) {
      const savedIntent = await readBoundedJsonFile(
        join(output, "run-intent.json"),
      );
      if (stableJson(savedIntent) !== stableJson(intent))
        throw new Error("EFFECTS_BENCHMARK_RESUME_MISMATCH");
      const savedCheckpoint = await readBoundedJsonFile(
        join(output, "checkpoint.json"),
      );
      if (
        !record(savedCheckpoint) ||
        Object.keys(savedCheckpoint).sort().join("\0") !==
          [...order].sort().join("\0")
      )
        throw new Error("EFFECTS_BENCHMARK_CHECKPOINT_MISMATCH");
      for (const key of order) {
        const entry = savedCheckpoint[key];
        if (
          !record(entry) ||
          !exact(entry, ["status", "observationHash"]) ||
          !["pending", "completed", "failed", "uncertain"].includes(
            String(entry.status),
          ) ||
          !(
            entry.observationHash === null ||
            (typeof entry.observationHash === "string" &&
              /^[0-9a-f]{64}$/u.test(entry.observationHash))
          ) ||
          (entry.status === "pending" && entry.observationHash !== null) ||
          (entry.status !== "pending" && entry.observationHash === null)
        )
          throw new Error("EFFECTS_BENCHMARK_CHECKPOINT_MISMATCH");
        checkpoint[key] = {
          status: entry.status as "pending" | TrialStatus,
          observationHash: entry.observationHash as string | null,
        };
      }
      if (
        Object.values(checkpoint).some((entry) => entry.status === "uncertain")
      )
        throw new Error("EFFECTS_BENCHMARK_UNCERTAIN_REQUIRES_REVIEW");
      const lines = (
        await readTextFile(join(output, "observations.jsonl"), 64 * 1024 * 1024)
      )
        .split("\n")
        .filter(Boolean);
      for (const line of lines) {
        const observation = parseStrictJsonObject(line, "observations.jsonl");
        if (!validRawObservation(observation))
          throw new Error("EFFECTS_BENCHMARK_CHECKPOINT_MISMATCH");
        observations.push(observation as unknown as RawObservation);
      }
      if (
        new Set(observations.map((item) => item.trialKey)).size !==
          observations.length ||
        observations.length !==
          Object.values(checkpoint).filter(
            (entry) => entry.status !== "pending",
          ).length ||
        observations.some(
          (item) =>
            checkpoint[item.trialKey]?.status !== item.status ||
            checkpoint[item.trialKey]?.observationHash !==
              fingerprintFor(item) ||
            !order.includes(item.trialKey),
        )
      )
        throw new Error("EFFECTS_BENCHMARK_CHECKPOINT_MISMATCH");
    } else {
      await writeJsonExclusive(join(output, "run-intent.json"), intent);
      await writeJsonExclusive(join(output, "checkpoint.json"), checkpoint);
      await writeExclusiveFile(join(output, "observations.jsonl"), "");
    }
    for (const [index, key] of order.entries()) {
      if (checkpoint[key]?.status !== "pending") continue;
      const trial = byKey.get(key);
      if (!trial) throw new Error("INVALID_EFFECTS_TRIAL_ORDER");
      const observation = await executeTrial({
        root: verified.study.root,
        studyHash: verified.study.studyHash,
        item: trial.item,
        variant: trial.variant,
        arm: trial.arm,
        repetition: trial.repetition,
        order: index,
        profile,
        frozenFiles: verified.freeze.files,
        signingKeys,
        budgets: study.budgets,
      });
      observations.push(observation);
      await assertDirectoryIdentity(output, outputIdentity);
      await appendDurable(
        join(output, "observations.jsonl"),
        `${stableJson(observation)}\n`,
      );
      checkpoint[key] = {
        status: observation.status,
        observationHash: fingerprintFor(observation),
      };
      await replaceJson(join(output, "checkpoint.json"), checkpoint);
      await assertDirectoryIdentity(output, outputIdentity);
      if (observation.status === "uncertain")
        throw new Error("EFFECTS_BENCHMARK_UNCERTAIN_REQUIRES_REVIEW");
    }
    if (
      options.resume &&
      Object.values(checkpoint).every((entry) => entry.status !== "pending") &&
      (await Bun.file(join(output, "result-package.json")).exists())
    ) {
      const resultPackage = parseResultPackage(
        await readBoundedJsonFile(join(output, "result-package.json")),
      );
      await writeDerivedArtifacts(resultPackage, output);
      return Object.freeze({ outputDirectory: output, resultPackage });
    }
    // The runner reads hidden Oracles only after every arm has terminated. They
    // cannot affect task construction, input, execution order, host or arm code.
    const oracles: Record<string, Oracle> = {};
    const oracleBindings: Record<string, { path: string; source: string }> = {};
    for (const item of study.cases) {
      oracles[item.id] = parseOracle(
        await readFrozenStudyJson(
          verified.study.root,
          item.oracle,
          verified.freeze.files,
        ),
        item,
      );
      oracleBindings[item.id] = {
        path: item.oracle,
        source: await readFrozenStudyText(
          verified.study.root,
          item.oracle,
          verified.freeze.files,
        ),
      };
    }
    const research = Object.freeze({
      analysisPlan: await readFrozenStudyJson(
        verified.study.root,
        study.analysisPlan,
        verified.freeze.files,
      ),
      sampleSizePlan: await readFrozenStudyJson(
        verified.study.root,
        study.sampleSizePlan,
        verified.freeze.files,
      ),
      claims: await readFrozenStudyJson(
        verified.study.root,
        study.claims,
        verified.freeze.files,
      ),
      provenance: await readFrozenStudyJson(
        verified.study.root,
        study.provenance,
        verified.freeze.files,
      ),
      ethics: Object.freeze({
        humanParticipants: false,
        realCredentials: false,
        realBusinessData: false,
        externalNetwork: false,
        externalRegistrationPerformed: false,
      }),
    });
    const researchBindings = Object.freeze({
      analysisPlan: Object.freeze({
        path: study.analysisPlan,
        source: await readFrozenStudyText(
          verified.study.root,
          study.analysisPlan,
          verified.freeze.files,
        ),
      }),
      sampleSizePlan: Object.freeze({
        path: study.sampleSizePlan,
        source: await readFrozenStudyText(
          verified.study.root,
          study.sampleSizePlan,
          verified.freeze.files,
        ),
      }),
      claims: Object.freeze({
        path: study.claims,
        source: await readFrozenStudyText(
          verified.study.root,
          study.claims,
          verified.freeze.files,
        ),
      }),
      provenance: Object.freeze({
        path: study.provenance,
        source: await readFrozenStudyText(
          verified.study.root,
          study.provenance,
          verified.freeze.files,
        ),
      }),
    });
    const studySource = await readTextFile(verified.study.path);
    if (
      fingerprintFor(
        parseEffectsAdversarialStudy(
          parseStrictJsonObject(studySource, verified.study.path),
        ),
      ) !== verified.study.studyHash
    )
      throw new Error("EFFECTS_BENCHMARK_FROZEN_INPUT_CHANGED");
    const unsigned = {
      format: "llang-effects-adversarial-result-package",
      version: 1,
      studyId: study.id,
      studyHash: verified.study.studyHash,
      freezeHash: verified.freeze.freezeHash,
      freeze: verified.freeze,
      studySource,
      mode: study.mode,
      evidenceEligible: verified.freeze.evidenceEligible,
      runnerProtocol: "effects-adversarial-runner-v1",
      seed: study.seed,
      repetitions: study.repetitions,
      createdAt: "deterministic-offline",
      apiCalls: 0,
      tokens: 0,
      costUsd: 0,
      network: "disabled",
      trialOrder: order,
      observations,
      oracles,
      oracleBindings,
      research,
      researchBindings,
      environment: await environment(study.seed),
    } as const;
    const resultPackage = Object.freeze({
      ...unsigned,
      resultHash: fingerprintFor(unsigned),
    });
    parseResultPackage(resultPackage);
    await assertDirectoryIdentity(output, outputIdentity);
    await writeJsonExclusive(
      join(output, "result-package.json"),
      resultPackage,
    );
    await writeDerivedArtifacts(resultPackage, output);
    await assertDirectoryIdentity(output, outputIdentity);
    return Object.freeze({ outputDirectory: output, resultPackage });
  } finally {
    if (signingKeys)
      await removeEffectsBenchmarkChainSigningKeys(signingKeys).catch(
        () => undefined,
      );
    await lock.close().catch(() => undefined);
    try {
      await assertDirectoryIdentity(output, outputIdentity);
      await rm(lockPath, { force: true });
    } catch {
      // Never unlink through a replaced output-directory path.
    }
  }
}

async function acquireRunLock(path: string, resume: boolean) {
  const create = async () => {
    const handle = await open(path, "wx", 0o600);
    await handle.writeFile(
      `${stableJson({ format: "llang-effects-run-lock", version: 1, pid: process.pid })}\n`,
    );
    await handle.sync();
    return handle;
  };
  try {
    return await create();
  } catch (error) {
    if (!resume || !record(error) || error.code !== "EEXIST")
      throw new Error("EFFECTS_BENCHMARK_RUN_LOCKED", { cause: error });
    let lock: unknown;
    try {
      lock = await readBoundedJsonFile(path, 4096);
    } catch {
      throw new Error("EFFECTS_BENCHMARK_RUN_LOCKED");
    }
    if (
      !record(lock) ||
      !exact(lock, ["format", "version", "pid"]) ||
      lock.format !== "llang-effects-run-lock" ||
      lock.version !== 1 ||
      !Number.isSafeInteger(lock.pid)
    )
      throw new Error("EFFECTS_BENCHMARK_RUN_LOCKED");
    try {
      process.kill(Number(lock.pid), 0);
      throw new Error("EFFECTS_BENCHMARK_RUN_LOCKED");
    } catch (probe) {
      if (
        probe instanceof Error &&
        probe.message === "EFFECTS_BENCHMARK_RUN_LOCKED"
      )
        throw probe;
      if (!record(probe) || probe.code !== "ESRCH")
        throw new Error("EFFECTS_BENCHMARK_RUN_LOCKED", { cause: probe });
    }
    await rm(path);
    return create();
  }
}

async function replaceJson(path: string, value: unknown) {
  const temporary = `${path}.pending`;
  await writeFile(temporary, `${stableJson(value)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  await rename(temporary, path);
}

export function analyzeEffectsResultValue(value: unknown) {
  return analyzePackage(parseResultPackage(value));
}

async function writeDerivedArtifacts(
  resultPackage: ResultPackage,
  output: string,
) {
  const analysis = analyzePackage(resultPackage);
  const table = `${renderTable(analysis)}\n`;
  const figures = `${renderFigures(analysis)}\n`;
  const report = renderReport(analysis, resultPackage);
  await writeOrVerifyArtifact(
    join(output, "result.json"),
    `${stableJson(analysis)}\n`,
  );
  await writeOrVerifyArtifact(join(output, "report.md"), report);
  await writeOrVerifyArtifact(join(output, "table.csv"), table);
  await writeOrVerifyArtifact(join(output, "figure.csv"), figures);
  const paper = join(output, "paper-artifact");
  await mkdir(join(paper, "raw"), { recursive: true });
  await mkdir(join(paper, "derived"), { recursive: true });
  await mkdir(join(paper, "tables"), { recursive: true });
  await mkdir(join(paper, "figures"), { recursive: true });
  await mkdir(join(paper, "scripts"), { recursive: true });
  await writeOrVerifyArtifact(
    join(paper, "README.md"),
    "# Effects paper artifact\n\nQuick fixture path: run `effects:benchmark verify result-package.json`, then reproduce into a new directory. An evidence-eligible reviewed package additionally requires `--freeze <externally-stored-freeze.json>` for verify and reproduce, independent review, timestamp and owner approval.\n",
  );
  await writeOrVerifyArtifact(
    join(paper, "CLAIMS.md"),
    "# Claims\n\nFixture fault detection is E1 only. Mechanism efficacy and normal completion require E2. Live generation, human auditability, general TypeScript superiority and production safety are unsupported.\n",
  );
  await writeOrVerifyArtifact(
    join(paper, "preregistration.md"),
    "# Preregistration status\n\nThe embedded machine-readable plans are authoritative. This fixture is unregistered, has no external immutable timestamp, and is not evidence eligible.\n",
  );
  await writeOrVerifyArtifact(
    join(paper, "analysis-plan.json"),
    `${stableJson(resultPackage.research.analysisPlan)}\n`,
  );
  await writeOrVerifyArtifact(
    join(paper, "sample-size-plan.json"),
    `${stableJson(resultPackage.research.sampleSizePlan)}\n`,
  );
  await writeOrVerifyArtifact(
    join(paper, "dataset-manifest.json"),
    `${stableJson(resultPackage.research.provenance)}\n`,
  );
  await writeOrVerifyArtifact(
    join(paper, "ethics-status.json"),
    `${stableJson(resultPackage.research.ethics)}\n`,
  );
  await writeOrVerifyArtifact(
    join(paper, "independent-reproduction-record.template.json"),
    `${stableJson({
      independentlyReproduced: false,
      executor: null,
      revision: resultPackage.studyHash,
      environment: null,
      differences: null,
      result: null,
    })}\n`,
  );
  await writeOrVerifyArtifact(
    join(paper, "environment.json"),
    `${stableJson(resultPackage.environment)}\n`,
  );
  await writeOrVerifyArtifact(
    join(paper, "raw", "result-package.json"),
    `${stableJson(resultPackage)}\n`,
  );
  await writeOrVerifyArtifact(
    join(paper, "raw", "observations.jsonl"),
    `${resultPackage.observations.map((item) => stableJson(item)).join("\n")}\n`,
  );
  await writeFile(
    join(paper, "derived", "result.json"),
    `${stableJson(analysis)}\n`,
  );
  await writeOrVerifyArtifact(join(paper, "tables", "primary.csv"), table);
  await writeOrVerifyArtifact(join(paper, "figures", "primary.csv"), figures);
  await writeOrVerifyArtifact(
    join(paper, "scripts", "README.md"),
    "Derived files are regenerated by the repository `effects:benchmark reproduce` command; no manual transcription is used.\n",
  );
  const checksums = {
    "raw/result-package.json": sha256(`${stableJson(resultPackage)}\n`),
    "raw/observations.jsonl": sha256(
      `${resultPackage.observations.map((item) => stableJson(item)).join("\n")}\n`,
    ),
    "derived/result.json": sha256(`${stableJson(analysis)}\n`),
    "tables/primary.csv": sha256(table),
    "figures/primary.csv": sha256(figures),
  };
  await writeOrVerifyArtifact(
    join(paper, "checksums.json"),
    `${stableJson(checksums)}\n`,
  );
  return Object.freeze({
    analysis,
    derivedHash: fingerprintFor({ analysis, table, figures, report }),
  });
}

async function writeOrVerifyArtifact(path: string, contents: string) {
  try {
    await writeExclusiveFile(path, contents);
  } catch (error) {
    if (!record(error) || error.code !== "EEXIST") throw error;
    const existing = await readTextFile(path, 64 * 1024 * 1024);
    if (existing !== contents)
      throw new Error("EFFECTS_BENCHMARK_DERIVED_ARTIFACT_MISMATCH");
  }
}

export async function analyzeEffectsResultPackage(path: string) {
  const resultPackage = parseResultPackage(await readBoundedJsonFile(path));
  const directory = dirname(resolve(path));
  const resultPath = join(directory, "analysis.json");
  const analysis = analyzePackage(resultPackage);
  await writeFile(resultPath, `${stableJson(analysis)}\n`, { flag: "w" });
  return Object.freeze({ resultPackage, analysis, resultPath });
}

export async function verifyEffectsResultPackage(
  path: string,
  externalFreezePath?: string,
) {
  const resultPackage = parseResultPackage(await readBoundedJsonFile(path));
  let externalFreezeChecked = false;
  if (externalFreezePath) {
    const externalFreeze = parseEffectsFreeze(
      await readBoundedJsonFile(externalFreezePath),
    );
    if (stableJson(externalFreeze) !== stableJson(resultPackage.freeze))
      throw new Error("EFFECTS_RESULT_EXTERNAL_FREEZE_MISMATCH");
    externalFreezeChecked = true;
  }
  ensureCompleteMatrix(resultPackage);
  const analysis = analyzePackage(resultPackage);
  if (
    resultPackage.apiCalls !== 0 ||
    resultPackage.tokens !== 0 ||
    resultPackage.costUsd !== 0 ||
    resultPackage.network !== "disabled" ||
    (resultPackage.mode !== "reviewed" && resultPackage.evidenceEligible) ||
    (resultPackage.evidenceEligible && !externalFreezeChecked)
  )
    throw new Error("INVALID_EFFECTS_RESULT_EVIDENCE");
  return Object.freeze({
    status: "verified",
    resultHash: resultPackage.resultHash,
    analysisHash: fingerprintFor(analysis),
    trials: resultPackage.observations.length,
    apiCalls: 0,
    sourceExecution: 0,
    network: 0,
    externalFreezeChecked,
  });
}

export async function reproduceEffectsResultPackage(options: {
  packagePath: string;
  outputDirectory: string;
  externalFreezePath?: string;
}) {
  const resultPackage = parseResultPackage(
    await readBoundedJsonFile(options.packagePath),
  );
  await verifyEffectsResultPackage(
    options.packagePath,
    options.externalFreezePath,
  );
  const output = await assertNewDirectory(options.outputDirectory);
  await writeJsonExclusive(join(output, "result-package.json"), resultPackage);
  const derived = await writeDerivedArtifacts(resultPackage, output);
  return Object.freeze({
    outputDirectory: output,
    resultHash: resultPackage.resultHash,
    derivedHash: derived.derivedHash,
    apiCalls: 0,
    sourceExecution: 0,
    network: 0,
  });
}

export async function fixtureEffectsBenchmark(options: {
  studyPath: string;
  outputDirectory: string;
}) {
  const run = await runEffectsBenchmark(options);
  if (
    run.resultPackage.mode !== "fixture" ||
    run.resultPackage.evidenceEligible
  )
    throw new Error("INVALID_EFFECTS_FIXTURE_EVIDENCE");
  return run;
}
