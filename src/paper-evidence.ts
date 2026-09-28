import { createHash } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { parseDevelopmentRun } from "./capability-development";
import { readCapability } from "./capability-package";
import { parseCapabilityReport } from "./capability-report";
import { resolveContainedFile } from "./contained-path";
import { contentHash, readJson } from "./prompt-source";

export type EvidenceFile = {
  path: string;
  role: string;
  bytes: number;
  sha256: string;
};
export type EvidenceInventory = {
  version: 1;
  origin: "past-live" | "saved-replay" | "fixture";
  files: EvidenceFile[];
  diagnostics: string[];
  runStatus: string;
  packageHash: string | null;
  wasmHash: string | null;
};

const sha = (data: Uint8Array) =>
  createHash("sha256").update(data).digest("hex");
function safeRelative(path: string) {
  if (
    !path ||
    path.startsWith("/") ||
    path.split(/[\\/]/).some((part) => part === ".." || part === "." || !part)
  )
    throw new Error(`invalid evidence path: ${path}`);
  return path;
}
async function listFiles(root: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(resolve(root, prefix), { withFileTypes: true });
  const result: string[] = [];
  for (const entry of entries) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    safeRelative(path);
    if (entry.isSymbolicLink())
      throw new Error(`symbolic link in evidence: ${path}`);
    if (entry.isDirectory()) result.push(...(await listFiles(root, path)));
    else if (entry.isFile()) result.push(path);
    else throw new Error(`unsupported evidence entry: ${path}`);
  }
  return result;
}
function role(path: string): string {
  if (path === "run.json") return "run";
  if (path === "metadata.json") return "metadata";
  if (
    path === "source.json" ||
    /^attempt-\d+\/(source\.json|candidate\/source\.prompt\.json)$/.test(path)
  )
    return "source";
  if (
    path === "tests.json" ||
    /^attempt-\d+\/candidate\/tests\.json$/.test(path)
  )
    return "suite";
  if (
    /^attempt-\d+\/(source\.json|candidate\/source\.prompt\.json)\.lock\.json$/.test(
      path,
    )
  )
    return "lock";
  if (/^attempt-\d+\/candidate\/[a-f0-9]{64}\.wasm$/.test(path)) return "wasm";
  if (/^attempt-\d+\/candidate\/manifest\.json$/.test(path))
    return "build-manifest";
  if (/^attempt-\d+\/candidate\/capability\.json$/.test(path))
    return "package-manifest";
  if (/^attempt-\d+\/report\.json$/.test(path)) return "report";
  return "other";
}
export async function inspectEvidence(
  root: string,
  origin: EvidenceInventory["origin"],
): Promise<EvidenceInventory> {
  const files: EvidenceFile[] = [];
  const diagnostics: string[] = [];
  for (const path of (await listFiles(root)).sort()) {
    const fileRole = role(path);
    if (fileRole === "other") {
      diagnostics.push(`unselected file: ${path}`);
      continue;
    }
    const full = await resolveContainedFile(root, path, "evidence", {
      rejectSymbolicLinks: true,
    });
    const bytes = await readFile(full);
    files.push({
      path,
      role: fileRole,
      bytes: bytes.length,
      sha256: sha(bytes),
    });
  }
  for (const name of [
    "run.json",
    "source.json",
    "metadata.json",
    "tests.json",
  ]) {
    if (!files.some((f) => f.path === name))
      diagnostics.push(`missing ${name}`);
  }
  let runStatus = "unknown",
    packageHash: string | null = null,
    wasmHash: string | null = null;
  if (!diagnostics.some((d) => d.startsWith("missing"))) {
    try {
      const run = parseDevelopmentRun(
        await readJson(resolve(root, "run.json")),
      );
      runStatus = run.status;
      if (
        (origin === "past-live" && run.config.mode !== "live") ||
        (origin === "saved-replay" && run.config.mode !== "replay") ||
        (origin === "fixture" && run.config.mode !== "fixture")
      )
        diagnostics.push("origin differs from recorded run mode");
      for (const [name, hash] of [
        ["source.json", run.sourceHash],
        ["metadata.json", run.metadataHash],
        ["tests.json", run.suiteHash],
      ] as const)
        if (
          hash !== null &&
          contentHash(await readJson(resolve(root, name))) !== hash
        )
          diagnostics.push(`${name} related hash mismatch`);
      for (const attempt of run.attempts) {
        const dir = `attempt-${attempt.index}`;
        const manifestPath = `${dir}/candidate/capability.json`;
        if (!files.some((f) => f.path === manifestPath)) {
          diagnostics.push(`missing ${manifestPath}`);
          continue;
        }
        const pkg = await readCapability(resolve(root, manifestPath));
        if (pkg.packageHash !== attempt.packageHash)
          diagnostics.push(`${manifestPath} package hash mismatch`);
        if (pkg.lock.irHash !== attempt.irHash)
          diagnostics.push(`${manifestPath} IR hash mismatch`);
        const reportPath = `${dir}/report.json`;
        if (!files.some((f) => f.path === reportPath))
          diagnostics.push(`missing ${reportPath}`);
        else {
          const report = parseCapabilityReport(
            await readJson(resolve(root, reportPath)),
          );
          if (
            report.packageHash !== pkg.packageHash ||
            report.status !== attempt.status
          )
            diagnostics.push(`${reportPath} related result mismatch`);
        }
        if (attempt.index === run.attempts.length - 1) {
          packageHash = pkg.packageHash;
          wasmHash = pkg.build.wasmHash;
        }
      }
    } catch (error) {
      diagnostics.push(error instanceof Error ? error.message : String(error));
    }
  }
  return {
    version: 1,
    origin,
    files,
    diagnostics,
    runStatus,
    packageHash,
    wasmHash,
  };
}

export async function verifyInventory(
  path: string,
): Promise<EvidenceInventory> {
  const inventory = (await readJson(path)) as EvidenceInventory;
  if (
    inventory.version !== 1 ||
    !["past-live", "saved-replay", "fixture"].includes(inventory.origin) ||
    !Array.isArray(inventory.files) ||
    new Set(inventory.files.map((f) => f.path)).size !== inventory.files.length
  )
    throw new Error("invalid inventory");
  const root = dirname(path);
  for (const file of inventory.files) {
    const target = await resolveContainedFile(
      root,
      safeRelative(`evidence/${file.path}`),
      "evidence",
      { rejectSymbolicLinks: true },
    );
    const bytes = await readFile(target);
    if (bytes.length !== file.bytes || sha(bytes) !== file.sha256)
      throw new Error(`evidence hash mismatch: ${file.path}`);
  }
  const current = await inspectEvidence(
    resolve(root, "evidence"),
    inventory.origin,
  );
  const selected = {
    ...inventory,
    diagnostics: inventory.diagnostics.filter(
      (d) => !d.startsWith("unselected file: "),
    ),
  };
  if (JSON.stringify(current) !== JSON.stringify(selected))
    throw new Error("inventory linkage mismatch");
  return inventory;
}

export async function saveInventory(
  input: string,
  outDir: string,
  origin: EvidenceInventory["origin"] = "past-live",
) {
  const inputRoot = resolve(input),
    outputRoot = resolve(outDir);
  if (outputRoot === inputRoot || outputRoot.startsWith(`${inputRoot}${sep}`))
    throw new Error("output must be outside input root");
  if (!(await lstat(inputRoot)).isDirectory())
    throw new Error("input must be a directory");
  const inventory = await inspectEvidence(inputRoot, origin);
  await mkdir(dirname(outputRoot), { recursive: true });
  await mkdir(outputRoot, { recursive: false });
  const evidenceRoot = resolve(outputRoot, "evidence");
  await mkdir(evidenceRoot);
  for (const file of inventory.files) {
    const source = await resolveContainedFile(
      inputRoot,
      file.path,
      "evidence",
      { rejectSymbolicLinks: true },
    );
    const target = resolve(evidenceRoot, file.path);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(source, target);
  }
  await writeFile(
    resolve(outputRoot, "inventory.json"),
    `${JSON.stringify(inventory, null, 2)}\n`,
    { flag: "wx" },
  );
  const buildManifest = inventory.files
    .filter((f) => f.role === "build-manifest")
    .at(-1);
  const build = buildManifest
    ? ((await readJson(resolve(inputRoot, buildManifest.path))) as {
        compiler?: string;
        backend?: string;
        options?: string;
      })
    : null;
  const gitCommit = Bun.spawnSync(["git", "rev-parse", "HEAD"]);
  const gitStatus = Bun.spawnSync(["git", "status", "--porcelain"]);
  const environment = {
    version: 1,
    original: {
      commit: "unknown",
      reason: "original run does not record a verified commit or OS",
    },
    observed: {
      commit:
        gitCommit.exitCode === 0
          ? gitCommit.stdout.toString().trim()
          : "unknown",
      workingTreeDirty:
        gitStatus.exitCode === 0 ? gitStatus.stdout.length > 0 : null,
      bun: Bun.version,
      platform: process.platform,
      arch: process.arch,
      packageJsonSha256: sha(
        await readFile(resolve(process.cwd(), "package.json")),
      ),
      bunLockSha256: sha(await readFile(resolve(process.cwd(), "bun.lock"))),
      compiler: build?.compiler ?? "unknown",
      backend: build?.backend ?? "unknown",
      options: build?.options ?? "unknown",
    },
    distribution: {
      rawEvidence: "local-only",
      redaction: "not-applied",
      replayable: true,
    },
  };
  await writeFile(
    resolve(outputRoot, "environment.json"),
    `${JSON.stringify(environment, null, 2)}\n`,
    { flag: "wx" },
  );
  await verifyInventory(resolve(outputRoot, "inventory.json"));
  return {
    inventory,
    environment,
    relativeInput: relative(process.cwd(), inputRoot),
  };
}
