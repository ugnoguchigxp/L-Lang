import { createHash, randomUUID } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  unlink,
} from "node:fs/promises";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { buildPaperReport } from "./paper-report";
import { withStudyRunLock, type StudyLockIO } from "./paper-study-lock";
import { parseStudyRun } from "./paper-study-validation";
import { contentHash } from "./prompt-source";

type FileEntry = { path: string; bytes: number; sha256: string };
export type StudyBundleManifest = {
  version: 1;
  format: "llang-paper-study-bundle";
  studyHash: string;
  runHash: string;
  inputSnapshotHash: string;
  mode: "fixture" | "live";
  files: FileEntry[];
  checksum: string;
};
type BundleHooks = {
  lockIO?: StudyLockIO;
  afterSourceScan?: () => void | Promise<void>;
  afterCopyFile?: (path: string) => void | Promise<void>;
  beforeManifestPublish?: () => void | Promise<void>;
  afterManifestPublish?: () => void | Promise<void>;
  afterVerifyScan?: () => void | Promise<void>;
};
const hashBytes = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const digest = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
const ordered = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function safePath(path: unknown): path is string {
  return (
    typeof path === "string" &&
    path.length > 0 &&
    !path.startsWith("/") &&
    !/^[a-zA-Z]:/.test(path) &&
    !path.includes("\\") &&
    !path.includes("\0") &&
    path
      .split("/")
      .every((segment) => segment && segment !== "." && segment !== "..")
  );
}

export function parseStudyBundleManifest(value: unknown): StudyBundleManifest {
  if (
    !object(value) ||
    !exact(value, [
      "version",
      "format",
      "studyHash",
      "runHash",
      "inputSnapshotHash",
      "mode",
      "files",
      "checksum",
    ]) ||
    value.version !== 1 ||
    value.format !== "llang-paper-study-bundle" ||
    !digest(value.studyHash) ||
    !digest(value.runHash) ||
    !digest(value.inputSnapshotHash) ||
    (value.mode !== "fixture" && value.mode !== "live") ||
    !Array.isArray(value.files) ||
    !digest(value.checksum)
  )
    throw new Error("invalid study bundle manifest");
  let last = "";
  for (const item of value.files) {
    if (
      !object(item) ||
      !exact(item, ["path", "bytes", "sha256"]) ||
      !safePath(item.path) ||
      item.path <= last ||
      !Number.isSafeInteger(item.bytes) ||
      Number(item.bytes) < 0 ||
      !digest(item.sha256) ||
      item.path === ".paper-study.lock" ||
      item.path === "reproduction.json"
    )
      throw new Error("invalid study bundle file entry");
    last = item.path;
  }
  if (
    !value.files.some((item: FileEntry) => item.path === "run.json") ||
    !value.files.some((item: FileEntry) => item.path === "inputs.json")
  )
    throw new Error("study bundle is missing required files");
  const { checksum, ...body } = value;
  if (checksum !== contentHash(body))
    throw new Error("study bundle manifest checksum mismatch");
  return value as StudyBundleManifest;
}

async function filesIn(
  root: string,
  omitOwnLock = false,
): Promise<FileEntry[]> {
  const files: FileEntry[] = [];
  async function visit(dir: string, prefix: string) {
    const entries = await readdir(dir);
    for (const name of entries) {
      const path = prefix ? `${prefix}/${name}` : name;
      if (!safePath(path)) throw new Error(`unsafe bundle path: ${path}`);
      if (omitOwnLock && path === ".paper-study.lock") continue;
      if (path === ".paper-study.lock" || path === "reproduction.json")
        throw new Error(`forbidden study bundle entry: ${path}`);
      const absolute = resolve(dir, name);
      const info = await lstat(absolute);
      if (info.isDirectory()) await visit(absolute, path);
      else if (info.isFile()) {
        const bytes = await readFile(absolute);
        files.push({ path, bytes: bytes.length, sha256: hashBytes(bytes) });
      } else
        throw new Error(
          `study bundle contains symlink or special file: ${path}`,
        );
    }
  }
  await visit(root, "");
  return files.sort((a, b) => ordered(a.path, b.path));
}

function sameFiles(expected: FileEntry[], actual: FileEntry[]) {
  if (
    expected.length !== actual.length ||
    expected.some(
      (item, index) =>
        item.path !== actual[index]?.path ||
        item.bytes !== actual[index]?.bytes ||
        item.sha256 !== actual[index]?.sha256,
    )
  )
    throw new Error("study bundle file set or byte hash mismatch");
}

async function acceptedRun(evidence: string) {
  const raw = JSON.parse(await readFile(resolve(evidence, "run.json"), "utf8"));
  const run = parseStudyRun(raw);
  if (run.version !== 2) throw new Error("study bundle requires StudyRun v2");
  if (run.status !== "complete")
    throw new Error("study bundle requires complete run");
  const report = await buildPaperReport(evidence);
  if (
    report.recordIntegrity !== "verified" ||
    report.oracleUnverified !== 0 ||
    report.missingTrials !== 0 ||
    report.completedTrials !== report.plannedTrials ||
    report.rows.some(
      (row) =>
        ["pending", "uncertain", "missing"].includes(row.status) ||
        (row.status === "pass" &&
          (!row.oracleEvidencePath ||
            !row.oracleEvidenceHash ||
            (row.oraclePass !== true && row.oraclePass !== false))),
    )
  )
    throw new Error("study run lacks complete verified records");
  return { run, raw, report };
}

async function bundleRoot(path: string) {
  const root = await realpath(path);
  if (!(await lstat(root)).isDirectory())
    throw new Error("study bundle root is not a directory");
  const entries = (await readdir(root)).sort(ordered);
  if (
    entries.length !== 2 ||
    entries[0] !== "bundle.json" ||
    entries[1] !== "evidence"
  )
    throw new Error("study bundle root has unexpected entries");
  if (
    !(await lstat(resolve(root, "bundle.json"))).isFile() ||
    !(await lstat(resolve(root, "evidence"))).isDirectory()
  )
    throw new Error("study bundle root has invalid entry types");
  return root;
}

export async function verifyStudyBundle(
  bundleDir: string,
  hooks: BundleHooks = {},
) {
  const root = await bundleRoot(bundleDir);
  const manifestBytes = await readFile(resolve(root, "bundle.json"));
  const manifest = parseStudyBundleManifest(
    JSON.parse(manifestBytes.toString()),
  );
  const evidence = resolve(root, "evidence");
  sameFiles(manifest.files, await filesIn(evidence));
  const { run, raw, report } = await acceptedRun(evidence);
  if (
    manifest.studyHash !== run.studyHash ||
    manifest.runHash !== contentHash(raw) ||
    manifest.inputSnapshotHash !== run.inputSnapshotHash ||
    manifest.mode !== run.mode
  )
    throw new Error("study bundle run linkage mismatch");
  await hooks.afterVerifyScan?.();
  sameFiles(manifest.files, await filesIn(evidence));
  await bundleRoot(root);
  if (!(await readFile(resolve(root, "bundle.json"))).equals(manifestBytes))
    throw new Error("study bundle manifest changed during verification");
  let totalBytes = 0;
  for (const file of manifest.files) {
    totalBytes += file.bytes;
    if (!Number.isSafeInteger(totalBytes))
      throw new Error("study bundle total bytes overflow");
  }
  return {
    version: 1 as const,
    format: "llang-paper-study-bundle-verification" as const,
    bundleHash: contentHash(manifest),
    fileCount: manifest.files.length,
    totalBytes,
    recordIntegrity: "verified" as const,
    evidenceEligible: false as const,
    report,
  };
}

async function publishManifest(path: string, manifest: StudyBundleManifest) {
  const temp = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temp, "wx", 0o600);
  let failure: unknown;
  try {
    await handle.writeFile(`${JSON.stringify(manifest, null, 2)}\n`);
    await handle.sync();
  } catch (error) {
    failure = error;
  }
  try {
    await handle.close();
  } catch (error) {
    failure ??= error;
  }
  if (failure) {
    try {
      await unlink(temp);
    } catch (cleanupError) {
      throw new Error("manifest preparation and cleanup failed", {
        cause: { failure, cleanupError },
      });
    }
    throw failure;
  }
  try {
    await link(temp, path);
  } finally {
    await unlink(temp);
  }
}

export async function createStudyBundle(
  runDir: string,
  outDir: string,
  hooks: BundleHooks = {},
) {
  const parent = await realpath(dirname(resolve(outDir)));
  if (!(await lstat(parent)).isDirectory())
    throw new Error("study bundle output parent is not a directory");
  const output = resolve(parent, basename(resolve(outDir)));
  return withStudyRunLock(
    runDir,
    async (source) => {
      const fromSource = relative(source, output);
      if (
        !fromSource ||
        (fromSource !== ".." && !fromSource.startsWith(`..${sep}`))
      )
        throw new Error("study bundle output must be outside the source run");
      const original = await filesIn(source, true);
      const { run, raw } = await acceptedRun(source);
      await hooks.afterSourceScan?.();
      await mkdir(output, { mode: 0o700 });
      const evidence = resolve(output, "evidence");
      await mkdir(evidence, { mode: 0o700 });
      for (const file of original) {
        const target = resolve(evidence, ...file.path.split("/"));
        await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        const bytes = await readFile(resolve(source, ...file.path.split("/")));
        if (bytes.length !== file.bytes || hashBytes(bytes) !== file.sha256)
          throw new Error(`source changed during bundle copy: ${file.path}`);
        const handle = await open(target, "wx", 0o600);
        try {
          await handle.writeFile(bytes);
          await handle.sync();
        } finally {
          await handle.close();
        }
        const saved = await readFile(target);
        if (saved.length !== file.bytes || hashBytes(saved) !== file.sha256)
          throw new Error(`bundle copy mismatch: ${file.path}`);
        await hooks.afterCopyFile?.(file.path);
      }
      sameFiles(original, await filesIn(source, true));
      const copied = await filesIn(evidence);
      sameFiles(original, copied);
      const copiedRun = await acceptedRun(evidence);
      if (contentHash(copiedRun.raw) !== contentHash(raw))
        throw new Error("copied run changed");
      const body = {
        version: 1 as const,
        format: "llang-paper-study-bundle" as const,
        studyHash: run.studyHash,
        runHash: contentHash(raw),
        inputSnapshotHash: run.inputSnapshotHash as string,
        mode: run.mode,
        files: copied,
      };
      const manifest = { ...body, checksum: contentHash(body) };
      await hooks.beforeManifestPublish?.();
      await publishManifest(resolve(output, "bundle.json"), manifest);
      await hooks.afterManifestPublish?.();
      return verifyStudyBundle(output);
    },
    hooks.lockIO,
  );
}
