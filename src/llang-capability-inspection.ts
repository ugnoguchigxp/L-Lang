import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, readFile, realpath, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { atomicWriteText } from "./atomic-file";
import {
  readLlangCapability,
  requestRevision,
  requirementCoverage,
} from "./llang-capability-contracts";
import {
  generateLlangPredicateProjection,
  LLANG_PREDICATE_PROJECTION_VERSION,
} from "./llang-predicate-projection";
import { contentHash } from "./prompt-source";
import { digest, WasmError } from "./wasm-contract";

export const LLANG_CAPABILITY_INSPECTION_VERSION = 1 as const;

type Snapshot = Awaited<ReturnType<typeof readLlangCapability>>;
type DirectoryIdentity = { dev: number; ino: number };
type InspectionWriter = (path: string, value: string) => Promise<void>;

function reportFor(snapshot: Snapshot) {
  const source = generateLlangPredicateProjection(snapshot.checked.program);
  return {
    format: "llang-capability-inspection" as const,
    version: LLANG_CAPABILITY_INSPECTION_VERSION,
    profile: snapshot.manifest.profile,
    packageHash: snapshot.packageHash,
    metadata: snapshot.manifest.metadata,
    request: {
      id: snapshot.request.id,
      body: snapshot.request.body,
      requirements: snapshot.request.requirements,
      requestRevision: requestRevision(snapshot.request),
    },
    contract: {
      input: snapshot.request.contract,
      output: snapshot.manifest.output,
      permissions: snapshot.manifest.permissions,
      inputValidation:
        "The L-Lang runtime validates own data properties before evaluation; this projection assumes contract-valid input.",
    },
    artifacts: {
      sourceHash: snapshot.checked.sourceHash,
      programHash: snapshot.checked.programHash,
      artifactHash: snapshot.build.wasmHash,
      suiteHash: contentHash(snapshot.suite),
      build: {
        compiler: snapshot.build.compiler,
        backend: snapshot.build.backend,
        options: snapshot.build.options,
      },
    },
    requirementCoverage: requirementCoverage(snapshot.request, snapshot.suite),
    cases: snapshot.suite.cases.map((item) => ({
      id: item.id,
      requirementIds: item.requirementIds,
    })),
    typescript: {
      projectionVersion: LLANG_PREDICATE_PROJECTION_VERSION,
      source,
      projectionHash: digest(source),
      sourceHash: snapshot.checked.sourceHash,
      programHash: snapshot.checked.programHash,
    },
    inspection: {
      integrity: "checked" as const,
      verification: "not-run" as const,
      acceptance: "not-run" as const,
      semanticEquivalence: "not-checked" as const,
      apiCalls: 0 as const,
      authenticity:
        "Compare packageHash with an externally trusted value; package integrity alone does not establish authenticity.",
      coverageMeaning:
        "Requirement coverage records case mappings, not proof that requirement meaning is satisfied.",
    },
  };
}

function isContained(root: string, target: string): boolean {
  const relation = relative(root, target);
  return (
    relation === "" ||
    (!relation.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
      relation !== ".." &&
      !isAbsolute(relation))
  );
}

async function assertExternalNewDirectory(
  manifestPath: string,
  outputDirectory: string,
): Promise<string> {
  const directory = resolve(outputDirectory);
  const packageRoot = await realpath(dirname(resolve(manifestPath)));
  if ((await lstat(dirname(directory))).isSymbolicLink())
    throw new WasmError(
      "INVALID_ARGUMENT",
      "inspection output parent must not be a symbolic link",
    );
  const parent = await realpath(dirname(directory));
  const canonicalTarget = resolve(parent, basename(directory));
  if (isContained(packageRoot, canonicalTarget))
    throw new WasmError(
      "INVALID_ARGUMENT",
      "inspection output must be outside the capability package",
    );
  return canonicalTarget;
}

async function assertUnchanged(path: string, expectedPackageHash: string) {
  const current = await readLlangCapability(path);
  if (current.packageHash !== expectedPackageHash)
    throw new WasmError(
      "INVALID_CAPABILITY",
      "package changed during inspection",
    );
}

async function directoryIdentity(path: string): Promise<DirectoryIdentity> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new WasmError(
      "INVALID_ARGUMENT",
      "inspection output changed during publication",
    );
  return { dev: info.dev, ino: info.ino };
}

async function assertDirectoryIdentity(
  path: string,
  expected: DirectoryIdentity,
): Promise<void> {
  const current = await directoryIdentity(path);
  if (current.dev !== expected.dev || current.ino !== expected.ino)
    throw new WasmError(
      "INVALID_ARGUMENT",
      "inspection output changed during publication",
    );
}

async function assertPublishedText(path: string, expected: string) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink())
    throw new WasmError(
      "INVALID_ARGUMENT",
      "inspection output changed during publication",
    );
  const actual = await readFile(path),
    expectedBytes = new TextEncoder().encode(expected);
  if (
    actual.length !== expectedBytes.length ||
    !actual.every((value, index) => value === expectedBytes[index])
  )
    throw new WasmError(
      "INVALID_ARGUMENT",
      "inspection output changed during publication",
    );
}

async function sameDirectoryIdentity(
  path: string,
  expected: DirectoryIdentity,
): Promise<boolean> {
  try {
    const current = await directoryIdentity(path);
    return current.dev === expected.dev && current.ino === expected.ino;
  } catch {
    return false;
  }
}

async function atomicCreateText(path: string, value: string): Promise<void> {
  const pending = resolve(
    dirname(path),
    `.${basename(path)}.${randomUUID()}.pending`,
  );
  try {
    await atomicWriteText(pending, value);
    await link(pending, path);
  } finally {
    await rm(pending, { force: true });
  }
}

export async function inspectLlangCapability(
  path: string,
  outputDirectory?: string,
  write: InspectionWriter = atomicCreateText,
) {
  const snapshot = await readLlangCapability(path);
  const report = reportFor(snapshot);
  if (!outputDirectory) {
    await assertUnchanged(path, snapshot.packageHash);
    return report;
  }

  const directory = await assertExternalNewDirectory(path, outputDirectory);
  await mkdir(directory);
  const identity = await directoryIdentity(directory),
    projectionPath = resolve(directory, "program.inspection.ts"),
    reportPath = resolve(directory, "inspection.json"),
    reportText = `${JSON.stringify(report, null, 2)}\n`;
  try {
    await assertDirectoryIdentity(directory, identity);
    await write(projectionPath, report.typescript.source);
    await assertDirectoryIdentity(directory, identity);
    await assertPublishedText(projectionPath, report.typescript.source);
    await assertUnchanged(path, snapshot.packageHash);
    await assertDirectoryIdentity(directory, identity);
    await write(reportPath, reportText);
    await assertDirectoryIdentity(directory, identity);
    await assertPublishedText(projectionPath, report.typescript.source);
    await assertPublishedText(reportPath, reportText);
    await assertUnchanged(path, snapshot.packageHash);
    await assertDirectoryIdentity(directory, identity);
    await assertPublishedText(projectionPath, report.typescript.source);
    await assertPublishedText(reportPath, reportText);
    return report;
  } catch (error) {
    if (await sameDirectoryIdentity(directory, identity))
      await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
