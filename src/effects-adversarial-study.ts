import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, stat } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";

import { decodeUtf8, parseStrictJsonObject } from "./llang-jsonc";
import { readStableRegularFileSnapshot } from "./llang-effects-stable-file";
import { fingerprintFor, sha256, stableJson } from "./stable-hash";

export const EFFECTS_ATTACK_CATEGORIES = [
  "instruction-in-data",
  "path-escalation",
  "endpoint-escalation",
  "credential-steering",
  "unauthorized-exfiltration",
  "write-escalation",
  "resource-pressure",
  "malformed-data",
  "generated-defect",
] as const;

export type EffectsAttackCategory = (typeof EFFECTS_ATTACK_CATEGORIES)[number];
export type EffectsBenchmarkMode = "fixture" | "candidate" | "reviewed";

export type EffectsStudyCase = Readonly<{
  id: string;
  category: EffectsAttackCategory;
  family: string;
  partition: "fixture" | "pilot" | "confirmatory";
  task: string;
  normalInput: string;
  adversarialInput: string;
  llang: Readonly<{
    moduleBuild: string;
    requirements: string;
    boundary: string;
    grant: string;
  }>;
  typescript: Readonly<{ source: string }>;
  oracle: string;
}>;

export type EffectsAdversarialStudy = Readonly<{
  format: "llang-effects-adversarial-study";
  version: 1;
  id: string;
  revision: number;
  mode: EffectsBenchmarkMode;
  evidenceEligible: boolean;
  runnerProtocol: "effects-adversarial-runner-v1";
  seed: number;
  repetitions: number;
  hostProfile: string;
  analysisPlan: string;
  sampleSizePlan: string;
  claims: string;
  provenance: string;
  review: string;
  freeze: string;
  budgets: Readonly<{
    timeoutMs: number;
    memoryBytes: number;
    requestLimit: number;
    byteLimit: number;
    streamChunkLimit: number;
    apiCallLimit: 0;
  }>;
  cases: readonly EffectsStudyCase[];
  expectedFiles: readonly string[];
}>;

export type EffectsFreeze = Readonly<{
  format: "llang-effects-adversarial-freeze";
  version: 1;
  studyId: string;
  revision: number;
  lifecycle: "frozen";
  mode: EffectsBenchmarkMode;
  studyHash: string;
  analysisHash: string;
  sampleSizeHash: string;
  reviewHash: string;
  externalTimestamp: string | null;
  ownerRunApproval: boolean;
  evidenceEligible: boolean;
  files: Readonly<Record<string, string>>;
  freezeHash: string;
}>;

export type EffectsReview = Readonly<{
  format: "llang-effects-adversarial-review";
  version: 1;
  mode: EffectsBenchmarkMode;
  author: string | null;
  reviewer: string | null;
  targetHash: string | null;
  decision: "fixture" | "approved" | "rejected";
  findings: readonly string[];
  resolutionHash: string | null;
  externalIdentityVerification: "not-performed";
}>;

const HASH = /^[0-9a-f]{64}$/u;
const ID = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u;
const SAFE_PATH = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/u;
const MAX_STUDY_BYTES = 1024 * 1024;
const MAX_FILES = 512;

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exact(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return (
    Object.keys(value).length === keys.length &&
    Object.keys(value).every((key) => keys.includes(key))
  );
}

function integer(
  value: unknown,
  minimum: number,
  maximum: number,
): value is number {
  return (
    Number.isSafeInteger(value) &&
    Number(value) >= minimum &&
    Number(value) <= maximum
  );
}

export function assertSafeEffectsRelativePath(
  path: unknown,
): asserts path is string {
  if (
    typeof path !== "string" ||
    path.length > 240 ||
    !SAFE_PATH.test(path) ||
    isAbsolute(path) ||
    path.includes("\\") ||
    path.split("/").some((part) => part === "" || part === "." || part === "..")
  )
    throw new Error("INVALID_EFFECTS_BENCHMARK_PATH");
}

function parseCase(value: unknown): EffectsStudyCase {
  if (
    !object(value) ||
    !exact(value, [
      "id",
      "category",
      "family",
      "partition",
      "task",
      "normalInput",
      "adversarialInput",
      "llang",
      "typescript",
      "oracle",
    ]) ||
    typeof value.id !== "string" ||
    !ID.test(value.id) ||
    !EFFECTS_ATTACK_CATEGORIES.includes(
      value.category as EffectsAttackCategory,
    ) ||
    typeof value.family !== "string" ||
    !ID.test(value.family) ||
    !["fixture", "pilot", "confirmatory"].includes(String(value.partition)) ||
    !object(value.llang) ||
    !exact(value.llang, ["moduleBuild", "requirements", "boundary", "grant"]) ||
    !object(value.typescript) ||
    !exact(value.typescript, ["source"])
  )
    throw new Error("INVALID_EFFECTS_ADVERSARIAL_CASE");
  const paths = [
    value.task,
    value.normalInput,
    value.adversarialInput,
    value.llang.moduleBuild,
    value.llang.requirements,
    value.llang.boundary,
    value.llang.grant,
    value.typescript.source,
    value.oracle,
  ];
  for (const path of paths) assertSafeEffectsRelativePath(path);
  return Object.freeze({
    id: value.id,
    category: value.category as EffectsAttackCategory,
    family: value.family,
    partition: value.partition as EffectsStudyCase["partition"],
    task: value.task as string,
    normalInput: value.normalInput as string,
    adversarialInput: value.adversarialInput as string,
    llang: Object.freeze({
      moduleBuild: value.llang.moduleBuild as string,
      requirements: value.llang.requirements as string,
      boundary: value.llang.boundary as string,
      grant: value.llang.grant as string,
    }),
    typescript: Object.freeze({ source: value.typescript.source as string }),
    oracle: value.oracle as string,
  });
}

export function parseEffectsAdversarialStudy(
  value: unknown,
): EffectsAdversarialStudy {
  if (
    !object(value) ||
    !exact(value, [
      "format",
      "version",
      "id",
      "revision",
      "mode",
      "evidenceEligible",
      "runnerProtocol",
      "seed",
      "repetitions",
      "hostProfile",
      "analysisPlan",
      "sampleSizePlan",
      "claims",
      "provenance",
      "review",
      "freeze",
      "budgets",
      "cases",
      "expectedFiles",
    ]) ||
    value.format !== "llang-effects-adversarial-study" ||
    value.version !== 1 ||
    typeof value.id !== "string" ||
    !ID.test(value.id) ||
    !integer(value.revision, 1, 1_000_000) ||
    !["fixture", "candidate", "reviewed"].includes(String(value.mode)) ||
    typeof value.evidenceEligible !== "boolean" ||
    value.runnerProtocol !== "effects-adversarial-runner-v1" ||
    !integer(value.seed, 0, 0xffff_ffff) ||
    !integer(value.repetitions, 1, 100) ||
    !object(value.budgets) ||
    !exact(value.budgets, [
      "timeoutMs",
      "memoryBytes",
      "requestLimit",
      "byteLimit",
      "streamChunkLimit",
      "apiCallLimit",
    ]) ||
    !integer(value.budgets.timeoutMs, 1, 600_000) ||
    !integer(value.budgets.memoryBytes, 1024, 1024 * 1024 * 1024) ||
    !integer(value.budgets.requestLimit, 1, 10_000) ||
    !integer(value.budgets.byteLimit, 1, 1024 * 1024 * 1024) ||
    !integer(value.budgets.streamChunkLimit, 1, 1_000_000) ||
    value.budgets.apiCallLimit !== 0 ||
    !Array.isArray(value.cases) ||
    value.cases.length < EFFECTS_ATTACK_CATEGORIES.length ||
    value.cases.length > 128 ||
    !Array.isArray(value.expectedFiles) ||
    value.expectedFiles.length < 1 ||
    value.expectedFiles.length > MAX_FILES
  )
    throw new Error("INVALID_EFFECTS_ADVERSARIAL_STUDY");
  const topPaths = [
    value.hostProfile,
    value.analysisPlan,
    value.sampleSizePlan,
    value.claims,
    value.provenance,
    value.review,
    value.freeze,
  ];
  for (const path of topPaths) assertSafeEffectsRelativePath(path);
  const cases = value.cases.map(parseCase);
  const expectedFiles = value.expectedFiles.map((path) => {
    assertSafeEffectsRelativePath(path);
    return path;
  });
  const ids = cases.map((item) => item.id);
  const allReferenced = [
    value.hostProfile as string,
    value.analysisPlan as string,
    value.sampleSizePlan as string,
    value.claims as string,
    value.provenance as string,
    value.review as string,
    ...cases.flatMap((item) => [
      item.task,
      item.normalInput,
      item.adversarialInput,
      item.llang.moduleBuild,
      item.llang.requirements,
      item.llang.boundary,
      item.llang.grant,
      item.typescript.source,
      item.oracle,
    ]),
  ].sort();
  if (
    (value.mode !== "reviewed" && value.evidenceEligible) ||
    ids.join("\0") !== [...new Set(ids)].sort().join("\0") ||
    !EFFECTS_ATTACK_CATEGORIES.every((category) =>
      cases.some((item) => item.category === category),
    ) ||
    (value.mode === "fixture" &&
      cases.some((item) => item.partition !== "fixture")) ||
    (value.mode !== "fixture" &&
      cases.some((item) => item.partition === "fixture")) ||
    expectedFiles.join("\0") !==
      [...new Set(expectedFiles)].sort().join("\0") ||
    !allReferenced.every((path) => expectedFiles.includes(path))
  )
    throw new Error("INCONSISTENT_EFFECTS_ADVERSARIAL_STUDY");
  return Object.freeze({
    format: "llang-effects-adversarial-study",
    version: 1,
    id: value.id,
    revision: Number(value.revision),
    mode: value.mode as EffectsBenchmarkMode,
    evidenceEligible: value.evidenceEligible,
    runnerProtocol: "effects-adversarial-runner-v1",
    seed: Number(value.seed),
    repetitions: Number(value.repetitions),
    hostProfile: value.hostProfile as string,
    analysisPlan: value.analysisPlan as string,
    sampleSizePlan: value.sampleSizePlan as string,
    claims: value.claims as string,
    provenance: value.provenance as string,
    review: value.review as string,
    freeze: value.freeze as string,
    budgets: Object.freeze({
      timeoutMs: Number(value.budgets.timeoutMs),
      memoryBytes: Number(value.budgets.memoryBytes),
      requestLimit: Number(value.budgets.requestLimit),
      byteLimit: Number(value.budgets.byteLimit),
      streamChunkLimit: Number(value.budgets.streamChunkLimit),
      apiCallLimit: 0,
    }),
    cases: Object.freeze(cases),
    expectedFiles: Object.freeze(expectedFiles),
  });
}

export async function readEffectsAdversarialStudy(path: string) {
  const absolute = resolve(path);
  const bytes = (
    await readStableRegularFileSnapshot(
      absolute,
      MAX_STUDY_BYTES,
      "INVALID_EFFECTS_ADVERSARIAL_STUDY_FILE",
    )
  ).bytes;
  const document = parseEffectsAdversarialStudy(
    parseStrictJsonObject(decodeUtf8(bytes, absolute), absolute),
  );
  return Object.freeze({
    path: absolute,
    root: dirname(absolute),
    sourceHash: sha256(bytes),
    studyHash: fingerprintFor(document),
    document,
  });
}

export async function readEffectsStudyFile(
  root: string,
  relativePath: string,
  maximumBytes = MAX_STUDY_BYTES,
): Promise<Uint8Array> {
  assertSafeEffectsRelativePath(relativePath);
  const path = resolve(root, relativePath);
  if (relative(root, path).startsWith("..") || relative(root, path) === "")
    throw new Error("INVALID_EFFECTS_BENCHMARK_PATH");
  return (
    await readStableRegularFileSnapshot(
      path,
      maximumBytes,
      "INVALID_EFFECTS_BENCHMARK_FILE",
    )
  ).bytes;
}

export async function readEffectsStudyJson(
  root: string,
  relativePath: string,
): Promise<unknown> {
  const bytes = await readEffectsStudyFile(root, relativePath);
  return parseStrictJsonObject(decodeUtf8(bytes, relativePath), relativePath);
}

async function listFiles(root: string, prefix = ""): Promise<string[]> {
  const directory = resolve(root, prefix || ".");
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (relativePath === "study.json" || relativePath === "freeze.json")
      continue;
    if (entry.isSymbolicLink())
      throw new Error("INVALID_EFFECTS_BENCHMARK_LINK");
    if (entry.isDirectory())
      files.push(...(await listFiles(root, relativePath)));
    else if (entry.isFile()) files.push(relativePath);
    else throw new Error("INVALID_EFFECTS_BENCHMARK_FILE_TYPE");
  }
  return files.sort();
}

export async function hashEffectsStudyFiles(
  root: string,
  expectedFiles: readonly string[],
): Promise<Readonly<Record<string, string>>> {
  const actual = await listFiles(root);
  if (actual.join("\0") !== expectedFiles.join("\0"))
    throw new Error("EFFECTS_BENCHMARK_EXACT_FILE_SET_MISMATCH");
  const result: Record<string, string> = {};
  const identities = new Set<string>();
  for (const path of expectedFiles) {
    const absolute = resolve(root, path);
    const info = await lstat(absolute);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)
      throw new Error("INVALID_EFFECTS_BENCHMARK_LINK");
    const identity = `${info.dev}:${info.ino}`;
    if (identities.has(identity))
      throw new Error("INVALID_EFFECTS_BENCHMARK_HARD_LINK");
    identities.add(identity);
    result[path] = sha256(await readEffectsStudyFile(root, path));
  }
  return Object.freeze(result);
}

export function parseEffectsReview(value: unknown): EffectsReview {
  if (
    !object(value) ||
    !exact(value, [
      "format",
      "version",
      "mode",
      "author",
      "reviewer",
      "targetHash",
      "decision",
      "findings",
      "resolutionHash",
      "externalIdentityVerification",
    ]) ||
    value.format !== "llang-effects-adversarial-review" ||
    value.version !== 1 ||
    !["fixture", "candidate", "reviewed"].includes(String(value.mode)) ||
    !(
      value.author === null ||
      (typeof value.author === "string" && ID.test(value.author))
    ) ||
    !(
      value.reviewer === null ||
      (typeof value.reviewer === "string" && ID.test(value.reviewer))
    ) ||
    !(
      value.targetHash === null ||
      (typeof value.targetHash === "string" && HASH.test(value.targetHash))
    ) ||
    !["fixture", "approved", "rejected"].includes(String(value.decision)) ||
    !Array.isArray(value.findings) ||
    value.findings.some(
      (item) => typeof item !== "string" || item.length > 1000,
    ) ||
    !(
      value.resolutionHash === null ||
      (typeof value.resolutionHash === "string" &&
        HASH.test(value.resolutionHash))
    ) ||
    value.externalIdentityVerification !== "not-performed"
  )
    throw new Error("INVALID_EFFECTS_ADVERSARIAL_REVIEW");
  if (
    (value.mode === "fixture" &&
      (value.author !== null ||
        value.reviewer !== null ||
        value.decision !== "fixture")) ||
    (value.mode !== "fixture" && (!value.author || !value.reviewer)) ||
    (value.author !== null && value.author === value.reviewer) ||
    (value.decision === "approved" &&
      (!value.targetHash || value.findings.length !== 0))
  )
    throw new Error("INCONSISTENT_EFFECTS_ADVERSARIAL_REVIEW");
  return Object.freeze(value as unknown as EffectsReview);
}

export function parseEffectsFreeze(value: unknown): EffectsFreeze {
  if (
    !object(value) ||
    !exact(value, [
      "format",
      "version",
      "studyId",
      "revision",
      "lifecycle",
      "mode",
      "studyHash",
      "analysisHash",
      "sampleSizeHash",
      "reviewHash",
      "externalTimestamp",
      "ownerRunApproval",
      "evidenceEligible",
      "files",
      "freezeHash",
    ]) ||
    value.format !== "llang-effects-adversarial-freeze" ||
    value.version !== 1 ||
    typeof value.studyId !== "string" ||
    !ID.test(value.studyId) ||
    !integer(value.revision, 1, 1_000_000) ||
    value.lifecycle !== "frozen" ||
    !["fixture", "candidate", "reviewed"].includes(String(value.mode)) ||
    ![
      value.studyHash,
      value.analysisHash,
      value.sampleSizeHash,
      value.reviewHash,
    ].every((hash) => typeof hash === "string" && HASH.test(hash)) ||
    !(
      value.externalTimestamp === null ||
      typeof value.externalTimestamp === "string"
    ) ||
    typeof value.ownerRunApproval !== "boolean" ||
    typeof value.evidenceEligible !== "boolean" ||
    !object(value.files) ||
    Object.keys(value.files).length > MAX_FILES ||
    !Object.entries(value.files).every(([path, hash]) => {
      try {
        assertSafeEffectsRelativePath(path);
        return typeof hash === "string" && HASH.test(hash);
      } catch {
        return false;
      }
    }) ||
    typeof value.freezeHash !== "string" ||
    !HASH.test(value.freezeHash)
  )
    throw new Error("INVALID_EFFECTS_ADVERSARIAL_FREEZE");
  const unsigned = { ...value };
  delete unsigned.freezeHash;
  if (
    value.freezeHash !== fingerprintFor(unsigned) ||
    (value.mode !== "reviewed" && value.evidenceEligible) ||
    (value.evidenceEligible &&
      (!value.externalTimestamp || !value.ownerRunApproval))
  )
    throw new Error("INCONSISTENT_EFFECTS_ADVERSARIAL_FREEZE");
  return Object.freeze(value as unknown as EffectsFreeze);
}

export async function verifyEffectsStudyFreeze(studyPath: string) {
  const study = await readEffectsAdversarialStudy(studyPath);
  const review = parseEffectsReview(
    await readEffectsStudyJson(study.root, study.document.review),
  );
  const freeze = parseEffectsFreeze(
    await readEffectsStudyJson(study.root, study.document.freeze),
  );
  const files = await hashEffectsStudyFiles(
    study.root,
    study.document.expectedFiles,
  );
  if (
    freeze.studyId !== study.document.id ||
    freeze.revision !== study.document.revision ||
    freeze.mode !== study.document.mode ||
    freeze.studyHash !== study.studyHash ||
    freeze.reviewHash !== fingerprintFor(review) ||
    freeze.analysisHash !== files[study.document.analysisPlan] ||
    freeze.sampleSizeHash !== files[study.document.sampleSizePlan] ||
    stableJson(freeze.files) !== stableJson(files) ||
    review.mode !== study.document.mode ||
    (review.targetHash !== null && review.targetHash !== study.studyHash) ||
    freeze.evidenceEligible !== study.document.evidenceEligible
  )
    throw new Error("EFFECTS_ADVERSARIAL_FREEZE_MISMATCH");
  return Object.freeze({ study, review, freeze, files });
}

export async function writeEffectsStudyFreeze(
  studyPath: string,
  outputPath?: string,
  options: Readonly<{
    reviewPath?: string;
    externalTimestamp?: string;
    ownerRunApproval?: boolean;
  }> = {},
) {
  const study = await readEffectsAdversarialStudy(studyPath);
  const review = parseEffectsReview(
    options.reviewPath
      ? await readBoundedJsonFile(options.reviewPath, MAX_STUDY_BYTES)
      : await readEffectsStudyJson(study.root, study.document.review),
  );
  const checkedInReview = parseEffectsReview(
    await readEffectsStudyJson(study.root, study.document.review),
  );
  if (stableJson(review) !== stableJson(checkedInReview))
    throw new Error("EFFECTS_ADVERSARIAL_REVIEW_MISMATCH");
  if (review.mode !== study.document.mode)
    throw new Error("EFFECTS_ADVERSARIAL_REVIEW_MISMATCH");
  const files = await hashEffectsStudyFiles(
    study.root,
    study.document.expectedFiles,
  );
  const analysisHash = files[study.document.analysisPlan];
  const sampleSizeHash = files[study.document.sampleSizePlan];
  if (!analysisHash || !sampleSizeHash)
    throw new Error("EFFECTS_RESEARCH_FILES_MISSING");
  const eligible =
    study.document.mode === "reviewed" &&
    review.decision === "approved" &&
    review.targetHash === study.studyHash &&
    study.document.evidenceEligible &&
    typeof options.externalTimestamp === "string" &&
    options.externalTimestamp.length > 0 &&
    options.ownerRunApproval === true;
  if (study.document.mode === "reviewed" && !eligible)
    throw new Error(
      "REVIEWED_FREEZE_REQUIRES_EXTERNAL_TIMESTAMP_AND_OWNER_APPROVAL",
    );
  const unsigned = {
    format: "llang-effects-adversarial-freeze",
    version: 1,
    studyId: study.document.id,
    revision: study.document.revision,
    lifecycle: "frozen",
    mode: study.document.mode,
    studyHash: study.studyHash,
    analysisHash,
    sampleSizeHash,
    reviewHash: fingerprintFor(review),
    externalTimestamp: eligible ? (options.externalTimestamp as string) : null,
    ownerRunApproval: eligible,
    evidenceEligible: eligible,
    files,
  } as const;
  const document = { ...unsigned, freezeHash: fingerprintFor(unsigned) };
  const path = resolve(outputPath ?? join(study.root, study.document.freeze));
  await writeExclusiveFile(path, `${stableJson(document)}\n`);
  return parseEffectsFreeze(document);
}

export async function writeExclusiveFile(
  path: string,
  contents: string | Uint8Array,
) {
  await mkdir(dirname(path), { recursive: true });
  const handle = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    0o600,
  );
  try {
    await handle.writeFile(contents);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function assertNewDirectory(path: string): Promise<string> {
  const absolute = resolve(path);
  if (basename(absolute) === "" || absolute === resolve("/"))
    throw new Error("INVALID_EFFECTS_OUTPUT_DIRECTORY");
  await mkdir(absolute, { recursive: false });
  const info = await stat(absolute);
  if (!info.isDirectory()) throw new Error("INVALID_EFFECTS_OUTPUT_DIRECTORY");
  return absolute;
}

export async function writeJsonExclusive(path: string, value: unknown) {
  await writeExclusiveFile(path, `${stableJson(value)}\n`);
}

export async function readBoundedJsonFile(
  path: string,
  maximumBytes = 32 * 1024 * 1024,
) {
  const bytes = (
    await readStableRegularFileSnapshot(
      resolve(path),
      maximumBytes,
      "INVALID_EFFECTS_RESULT_FILE",
    )
  ).bytes;
  return parseStrictJsonObject(decodeUtf8(bytes, path), path);
}

export async function readTextFile(
  path: string,
  maximumBytes = MAX_STUDY_BYTES,
) {
  return decodeUtf8(
    (
      await readStableRegularFileSnapshot(
        resolve(path),
        maximumBytes,
        "INVALID_EFFECTS_TEXT_FILE",
      )
    ).bytes,
    path,
  );
}
