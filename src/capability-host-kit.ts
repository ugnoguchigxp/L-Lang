import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  packageCapability,
  readCapability,
  verifyCapability,
} from "./capability-package";
import { HOST_PROTOCOL, runHostRequest } from "./capability-host";
import { readJson } from "./prompt-source";
import { digest } from "./wasm-contract";

export async function createHostKit(directory: string) {
  const root = resolve(directory);
  await mkdir(root, { recursive: false });
  const example = resolve(import.meta.dir, "../examples/capability-access");
  const candidate = await packageCapability(
    resolve(example, "access.prompt.json"),
    resolve(example, "tests.json"),
    await readJson(resolve(example, "metadata.json")),
    resolve(root, "candidate"),
  );
  const report = await verifyCapability(candidate.manifest);
  if (report.status !== "pass")
    throw new Error("kit candidate failed verification");
  const bundled = await Bun.build({
    entrypoints: [
      "capability-host-cli.ts",
      "capability-worker.ts",
      "capability-invoke-worker.ts",
    ].map((name) => resolve(import.meta.dir, name)),
    outdir: resolve(root, "runtime"),
    target: "bun",
    naming: "[name].ts",
  });
  if (!bundled.success) throw new Error("runtime bundle failed");
  for (const name of ["request.schema.json", "response.schema.json"])
    await cp(
      resolve(import.meta.dir, "../examples/saaa-host", name),
      resolve(root, name),
    );
  const vectors: {
    request: Record<string, unknown>;
    expected: Record<string, unknown>;
  }[] = [];
  for (const enabled of [true, false])
    for (const suspended of [true, false]) {
      const request = {
        protocol: HOST_PROTOCOL,
        requestId: `access-${vectors.length}`,
        operation: "invoke",
        packageHash: candidate.packageHash,
        input: { enabled, suspended },
        undefinedFields: [],
        timeoutMs: 10000,
      };
      const response = await runHostRequest(candidate.manifest, request);
      if (response.status !== "ok") throw new Error("kit invocation failed");
      vectors.push({
        request,
        expected: { status: "ok", result: { value: enabled && !suspended } },
      });
    }
  const first = vectors[0];
  if (!first) throw new Error("missing vectors");
  vectors.push({
    request: {
      ...first.request,
      requestId: "bad-input",
      input: { enabled: "true", suspended: false },
    },
    expected: { status: "error", error: "invalid-input" },
  });
  await writeFile(
    resolve(root, "vectors.json"),
    JSON.stringify(vectors, null, 2),
  );
  await writeFile(
    resolve(root, "request.json"),
    JSON.stringify(first.request, null, 2),
  );
  await writeFile(
    resolve(root, "verification.json"),
    JSON.stringify(report, null, 2),
  );
  const snapshot = await readCapability(candidate.manifest);
  const files = [
    "candidate/capability.json",
    ...Object.values(snapshot.manifest.files).map((f) => `candidate/${f.path}`),
    "vectors.json",
    "request.json",
    "verification.json",
    "request.schema.json",
    "response.schema.json",
    ...bundled.outputs.map((f) => `runtime/${f.path.split(/[\\/]/).pop()}`),
  ];
  const hashes: Record<string, string> = {};
  for (const file of files)
    hashes[file] = digest(await readFile(resolve(root, file)));
  const git = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
    cwd: resolve(import.meta.dir, ".."),
  });
  const state = Bun.spawnSync(["git", "status", "--porcelain"], {
    cwd: resolve(import.meta.dir, ".."),
  });
  const provenance = {
    commit: git.exitCode === 0 ? git.stdout.toString().trim() : null,
    dirty: state.exitCode === 0 ? state.stdout.length > 0 : null,
  };
  const info = {
    protocol: HOST_PROTOCOL,
    bunVersion: Bun.version,
    packageHash: snapshot.packageHash,
    fixture: true,
    provenance,
    acceptance: "not-run",
    files: hashes,
  };
  await writeFile(resolve(root, "kit.json"), JSON.stringify(info, null, 2));
  return info;
}
if (import.meta.main) {
  const destination = process.argv[2];
  if (!destination) throw new Error("expected new kit directory");
  console.log(JSON.stringify(await createHostKit(destination), null, 2));
}
