import { randomUUID } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  realpath,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { parseCapabilityReport } from "./capability-report";
import {
  type CaseResult,
  invalid,
  parseCapabilitySuite,
} from "./capability-tests";
import { resolveContainedFile } from "./contained-path";
import { parseResolutionLock, RESOLUTION_PROTOCOL } from "./prompt-resolution";
import {
  contentHash,
  identifier,
  parsePromptSource,
  stringValue,
} from "./prompt-source";
import { parseManifest, readBounded } from "./wasm-artifact";
import { digest, record, WASM_LIMITS, WasmError } from "./wasm-contract";

export const CAPABILITY_VERIFIER = "capability-predicate-v1";
const roles = ["source", "lock", "build", "wasm", "tests"] as const;
type Role = (typeof roles)[number];
type FileRef = { path: string; hash: string };
export type CapabilityMetadata = {
  id: string;
  release: string;
  purpose: string;
  useWhen: string;
  doNotUseWhen: string;
};
export type CapabilityManifest = {
  version: 1;
  metadata: CapabilityMetadata;
  profile: "predicate-i32-v1";
  output: "boolean";
  permissions: [];
  files: Record<Role, FileRef>;
};
export type CapabilityReport = {
  version: 1;
  verifier: typeof CAPABILITY_VERIFIER;
  packageHash: string | null;
  status: "pass" | "fail" | "error";
  acceptance: "not-run";
  apiCalls: 0;
  results: CaseResult[];
  requirements: { id: string; caseIds: string[] }[];
  unchecked: string[];
  passed: number;
  failed: number;
  errors: number;
  diagnostics: string[];
};
export function parseCapabilityMetadata(input: unknown): CapabilityMetadata {
  const m = record(input, [
    "id",
    "release",
    "purpose",
    "useWhen",
    "doNotUseWhen",
  ]);
  return {
    id: identifier(m.id),
    release: identifier(m.release),
    purpose: stringValue(m.purpose, "purpose"),
    useWhen: stringValue(m.useWhen, "useWhen"),
    doNotUseWhen: stringValue(m.doNotUseWhen, "doNotUseWhen"),
  };
}
export function parseCapabilityManifest(input: unknown): CapabilityManifest {
  const m = record(input, [
    "version",
    "metadata",
    "profile",
    "output",
    "permissions",
    "files",
  ]);
  if (
    m.version !== 1 ||
    m.profile !== "predicate-i32-v1" ||
    m.output !== "boolean" ||
    !Array.isArray(m.permissions) ||
    m.permissions.length
  )
    invalid("unsupported capability contract");
  const f = record(m.files, [...roles]);
  const files = {} as Record<Role, FileRef>;
  for (const role of roles) {
    const r = record(f[role], ["path", "hash"]);
    // Flat package paths avoid platform-specific traversal and nested symlinks.
    if (
      typeof r.path !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(r.path) ||
      r.path === "capability.json"
    )
      invalid("invalid package path");
    if (typeof r.hash !== "string" || !/^[a-f0-9]{64}$/.test(r.hash))
      invalid("invalid file hash");
    files[role] = { path: r.path, hash: r.hash };
  }
  if (new Set(roles.map((r) => files[r].path)).size !== roles.length)
    invalid("duplicate package path");
  if (files.lock.path !== `${files.source.path}.lock.json`)
    invalid("lock path must follow source path");
  return {
    version: 1,
    metadata: parseCapabilityMetadata(m.metadata),
    profile: "predicate-i32-v1",
    output: "boolean",
    permissions: [],
    files,
  };
}
function json(bytes: Uint8Array): unknown {
  return JSON.parse(new TextDecoder().decode(bytes));
}
async function plainBytes(path: string) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink())
    invalid("expected a regular non-symlink file");
  return readBounded(path);
}
async function containedBytes(root: string, path: string) {
  const file = await resolveContainedFile(root, path, "capability file", {
    rejectSymbolicLinks: true,
  });
  return plainBytes(file);
}
export async function readCapability(path: string) {
  const raw = await plainBytes(path);
  const manifest = parseCapabilityManifest(json(raw));
  const root = dirname(resolve(path));
  const files = {} as Record<Role, Uint8Array>;
  for (const role of roles) {
    const ref = manifest.files[role];
    files[role] = await containedBytes(root, ref.path);
    if (digest(files[role]) !== ref.hash) invalid(`${role} hash mismatch`);
  }
  const source = parsePromptSource(json(files.source));
  const lock = parseResolutionLock(json(files.lock), source);
  const build = parseManifest(json(files.build));
  const suite = parseCapabilitySuite(json(files.tests), source);
  if (
    manifest.metadata.id !== source.id ||
    build.file !== manifest.files.wasm.path ||
    build.wasmHash !== digest(files.wasm) ||
    build.provenance.sourceHash !== contentHash(source) ||
    build.provenance.fingerprint !== lock.checksum ||
    build.irHash !== digest(JSON.stringify(lock.body)) ||
    contentHash(build.contract) !== contentHash(source.contract) ||
    build.provenance.testHash !== contentHash(source.examples) ||
    build.provenance.source !== manifest.files.source.path ||
    build.provenance.concept !== source.id ||
    build.provenance.predicate !== source.id ||
    build.provenance.typeHash !== contentHash(source.contract) ||
    build.provenance.promptHash !== contentHash(RESOLUTION_PROTOCOL) ||
    build.provenance.contextHash !== contentHash({ profile: source.profile }) ||
    build.provenance.conceptHash !==
      contentHash({
        intent: source.intent,
        requirements: source.requirements,
        unresolvedWhen: source.unresolvedWhen,
      })
  )
    invalid("source/lock/build linkage mismatch");
  if (digest(await plainBytes(path)) !== digest(raw))
    invalid("manifest changed while reading");
  return {
    manifest,
    packageHash: contentHash(manifest),
    source,
    lock,
    build,
    suite,
    bytes: files.wasm,
  };
}
export async function packageCapability(
  sourcePath: string,
  testsPath: string,
  metadataInput: unknown,
  outputDirectory: string,
  write: typeof writeFile = writeFile,
) {
  const metadata = parseCapabilityMetadata(metadataInput);
  const inputs = [sourcePath, `${sourcePath}.lock.json`, testsPath];
  const captured = await Promise.all(inputs.map(plainBytes));
  const source = parsePromptSource(json(captured[0] as Uint8Array));
  parseResolutionLock(json(captured[1] as Uint8Array), source);
  parseCapabilitySuite(json(captured[2] as Uint8Array), source);
  if (metadata.id !== source.id) invalid("capability id must match source id");
  const directory = resolve(outputDirectory);
  await mkdir(dirname(directory), { recursive: true });
  await mkdir(directory); // Exclusive ownership; an existing candidate is never overwritten.
  try {
    const names = [
      "source.prompt.json",
      "source.prompt.json.lock.json",
      "tests.json",
    ];
    for (let i = 0; i < names.length; i++)
      await write(
        resolve(directory, names[i] as string),
        captured[i] as Uint8Array,
        { flag: "wx" },
      );
    const { buildPromptWasm } = await import("./prompt-wasm");
    const built = await buildPromptWasm(
      resolve(directory, names[0] as string),
      directory,
    );
    const build = parseManifest(json(await plainBytes(built.manifest)));
    const paths: Record<Role, string> = {
      source: names[0] as string,
      lock: names[1] as string,
      tests: names[2] as string,
      build: "manifest.json",
      wasm: build.file,
    };
    const files = {} as Record<Role, FileRef>;
    for (const role of roles)
      files[role] = {
        path: paths[role],
        hash: digest(await plainBytes(resolve(directory, paths[role]))),
      };
    const manifest = parseCapabilityManifest({
      version: 1,
      metadata,
      profile: "predicate-i32-v1",
      output: "boolean",
      permissions: [],
      files,
    });
    const text = `${JSON.stringify(manifest, null, 2)}\n`;
    if (Buffer.byteLength(text) > WASM_LIMITS.bytes)
      invalid("manifest exceeds size limit");
    for (let i = 0; i < inputs.length; i++)
      if (
        digest(await plainBytes(inputs[i] as string)) !==
        digest(captured[i] as Uint8Array)
      )
        invalid("input changed during packaging");
    const path = resolve(directory, "capability.json");
    const pending = resolve(directory, "capability.pending");
    await write(pending, text, { flag: "wx" });
    await link(pending, path);
    await unlink(pending);
    // Confirm the published snapshot is internally consistent before returning it.
    const snapshot = await readCapability(path);
    return {
      manifest: path,
      packageHash: snapshot.packageHash,
      verification: "not-run",
      acceptance: "not-run",
      apiCalls: 0,
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
async function runIsolated(
  snapshot: Awaited<ReturnType<typeof readCapability>>,
): Promise<CaseResult[]> {
  return new Promise((resolveResult, reject) => {
    const worker = new Worker(
      new URL("./capability-worker.ts", import.meta.url).href,
    );
    const timer = setTimeout(() => {
      worker.terminate();
      reject(
        new WasmError(
          "EXECUTION_TIMEOUT",
          "capability verification exceeded 10 seconds",
        ),
      );
    }, 10_000);
    function finish() {
      clearTimeout(timer);
      worker.terminate();
    }
    worker.onerror = (event) => {
      finish();
      reject(new Error(event.message));
    };
    worker.onmessage = (event) => {
      finish();
      if (event.data.error) reject(new Error(event.data.error));
      else resolveResult(event.data.results);
    };
    worker.postMessage({
      manifest: snapshot.build,
      bytes: snapshot.bytes,
      source: snapshot.source,
      suite: snapshot.suite,
    });
  });
}
export async function verifyCapability(
  path: string,
): Promise<CapabilityReport> {
  const report: CapabilityReport = {
    version: 1,
    verifier: CAPABILITY_VERIFIER,
    packageHash: null,
    status: "error",
    acceptance: "not-run",
    apiCalls: 0,
    results: [],
    requirements: [],
    unchecked: [
      "SAAA acceptance",
      "Natural-language completeness is not proven by case coverage",
    ],
    passed: 0,
    failed: 0,
    errors: 0,
    diagnostics: [],
  };
  try {
    const snapshot = await readCapability(path);
    report.packageHash = snapshot.packageHash;
    report.requirements = snapshot.source.requirements.map((r) => ({
      id: r.id,
      caseIds: snapshot.suite.cases
        .filter((c) => c.requirementIds.includes(r.id))
        .map((c) => c.id),
    }));
    report.unchecked.push(
      ...report.requirements
        .filter((r) => !r.caseIds.length)
        .map((r) => `requirement:${r.id}`),
    );
    report.results = await runIsolated(snapshot);
    // Detect changes after the snapshot was executed. A report never authorizes deployment.
    if ((await readCapability(path)).packageHash !== snapshot.packageHash)
      invalid("package changed during verification");
  } catch (error) {
    report.diagnostics.push(
      (error instanceof Error ? error.message : String(error)).slice(0, 4096) ||
        "Unknown verification error",
    );
  }
  report.passed = report.results.filter((r) => r.status === "pass").length;
  report.failed = report.results.filter((r) => r.status === "fail").length;
  report.errors =
    report.results.filter((r) => r.status === "error").length +
    report.diagnostics.length;
  report.status = report.errors ? "error" : report.failed ? "fail" : "pass";
  return parseCapabilityReport(report);
}
export async function inspectCapability(path: string) {
  const snapshot = await readCapability(path);
  return {
    manifest: snapshot.manifest,
    packageHash: snapshot.packageHash,
    contract: snapshot.source.contract,
    requirements: snapshot.source.requirements,
    cases: snapshot.suite.cases.length,
    verification: "not-run",
    acceptance: "not-run",
    apiCalls: 0,
  };
}
export async function writeCapabilityReport(
  path: string,
  report: CapabilityReport,
  manifestPath: string,
) {
  parseCapabilityReport(report);
  const destination = resolve(
    await realpath(dirname(resolve(path))),
    basename(resolve(path)),
  );
  const root = await realpath(dirname(resolve(manifestPath)));
  const rel = relative(root, destination).replaceAll("\\", "/");
  if (rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel))
    invalid("report must be outside the candidate directory");
  if (
    report.status !== "error" &&
    (await readCapability(manifestPath)).packageHash !== report.packageHash
  )
    invalid("report belongs to a different candidate");
  const pending = resolve(
    dirname(destination),
    `.capability-report-${randomUUID()}.tmp`,
  );
  try {
    await writeFile(pending, `${JSON.stringify(report, null, 2)}\n`, {
      flag: "wx",
    });
    await link(pending, destination);
  } finally {
    await rm(pending, { force: true });
  }
}
