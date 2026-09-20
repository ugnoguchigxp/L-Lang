import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectEffectsModuleBundle } from "./llang-effects-bundle-inspection";
import { auditEffectsExecution } from "./llang-effects-execution-audit";
import { executeEffectsModuleBundle } from "./llang-effects-execution-evidence";
import {
  effectsManifest,
  HostOperationRegistry,
  type OperationDefinition,
} from "./llang-effects-contract";
import { runLinearEffects } from "./llang-effects-runtime";
import { Decimal, i64, LBytes } from "./llang-effects-values";
import {
  assertEffectsWasm,
  emitLinearEffectsWasm,
  SESSION_STATUS,
} from "./llang-effects-wasm";
import { LocalFileAdapter } from "./llang-io-file-adapter";
import { buildEffectsModuleProgram } from "./llang-module-effects-build";

const emitted = emitLinearEffectsWasm({
    initial: 2,
    steps: [
      { operation: 0, payload: 11, combine: "add" },
      { operation: 1, payload: 12, combine: "add" },
    ],
  }),
  instance = new WebAssembly.Instance(assertEffectsWasm(emitted.bytes), {}),
  exports = instance.exports as unknown as {
    memory: WebAssembly.Memory;
    start(out: number, capacity: number): number;
    resume(
      event: number,
      length: number,
      out: number,
      capacity: number,
    ): number;
  },
  view = new DataView(exports.memory.buffer),
  request = 64,
  event = 128,
  output = 192;

if (exports.start(request, 16) !== SESSION_STATUS.YIELDED)
  throw new Error("effects smoke did not yield");
for (const [sequence, value] of [3, 5].entries()) {
  view.setUint32(event, 0, true);
  view.setUint32(event + 4, sequence + 1, true);
  view.setUint32(event + 8, 1, true);
  view.setInt32(event + 12, value, true);
  const status = exports.resume(
    event,
    16,
    sequence === 0 ? request : output,
    sequence === 0 ? 16 : 4,
  );
  if (
    status !== (sequence === 0 ? SESSION_STATUS.YIELDED : SESSION_STATUS.DONE)
  )
    throw new Error("effects smoke resume failed");
}
if (view.getInt32(output, true) !== 10)
  throw new Error("effects smoke Wasm result mismatch");

const hostOperations: OperationDefinition[] = ["host.first", "host.second"].map(
    (id) => ({
      id,
      version: 1,
      requestType: { value: "i32" },
      responseType: { value: "i32" },
      errorType: { code: "string" },
      effect: "host",
      resource: "none",
      cancellable: true,
      idempotent: true,
    }),
  ),
  registry = new HostOperationRegistry(hostOperations),
  manifest = effectsManifest(
    registry,
    hostOperations.map(({ id, version }) => ({ id, version })),
  ),
  hosted = await runLinearEffects({
    wasm: emitted.bytes,
    manifest,
    registry,
    grant: {
      operations: new Set(["host.first@1", "host.second@1"]),
      wallClock: false,
    },
    execute: async (request) => ({
      ok: true,
      value: request.operation === "host.first" ? 3 : 5,
    }),
  });
if (hosted.result !== 10 || hosted.ledger.used("hostRequests") !== 2)
  throw new Error("effects smoke hosted runtime mismatch");

const root = await mkdtemp(join(tmpdir(), "llang-effects-smoke-"));
let bundleIdentityHash = "";
let executionEvidenceHash = "";
let executionAuditHash = "";
try {
  const files = await LocalFileAdapter.create(root),
    handle = await files.openWrite("result.bin", { replace: false }),
    bytes = LBytes.encodeUtf8("ok");
  await files.writeChunk(handle, bytes);
  await files.commit(handle);
  if ((await readFile(join(root, "result.bin"), "utf8")) !== "ok")
    throw new Error("effects smoke file mismatch");

  await writeFile(
    join(root, "inspection.llang.jsonc"),
    JSON.stringify({
      language: "l-lang",
      version: 5,
      kind: "module",
      profile: "module-effects-v1",
      module: "smoke/inspection",
      entry: "main",
      imports: [],
      operations: [
        {
          id: "host.echo",
          version: 1,
          requestType: "i64",
          responseType: "i64",
          errorType: { code: "string" },
          effect: "host",
          resource: "none",
          cancellable: true,
          idempotent: true,
        },
      ],
      resultType: "i64",
      nodes: [
        {
          kind: "await",
          operation: "host.echo",
          version: 1,
          request: { i64: "42" },
        },
      ],
    }),
  );
  await buildEffectsModuleProgram({
    entry: "inspection.llang.jsonc",
    root,
    entryName: "main",
    target: "all",
    outDir: join(root, "inspection-bundle"),
  });
  const inspected = await inspectEffectsModuleBundle(
    join(root, "inspection-bundle/module-build.json"),
    join(root, "inspection-output"),
  );
  if (
    inspected.inspection.execution !== "not-run" ||
    inspected.reconstruction.wasmBytes !== "checked"
  )
    throw new Error("effects bundle inspection smoke mismatch");
  bundleIdentityHash = inspected.bundleIdentityHash;
  await writeFile(
    join(root, "execution-grant.json"),
    JSON.stringify({
      format: "llang-effects-grant",
      version: 1,
      bundleIdentityHash,
      operations: ["host.echo@1"],
      file: null,
      http: null,
      wallClock: false,
      deadlineMs: 30_000,
      limits: {},
    }),
  );
  await writeFile(
    join(root, "execution-requirements.json"),
    JSON.stringify({
      format: "llang-effects-requirements",
      version: 1,
      id: "smoke-inspection",
      revision: 1,
      body: "Execute the inspected host operation and complete.",
      bundleIdentityHash,
      requirements: [
        {
          id: "complete",
          level: "must",
          statement: "The execution must complete.",
          verification: "outcome",
        },
        {
          id: "invoke-host",
          level: "must",
          statement: "Invoke the declared host operation.",
          verification: "structure",
        },
      ],
      bindings: [
        {
          requirementId: "complete",
          nodes: [],
          operations: [],
          authorityRules: [],
          terminalStatuses: ["completed"],
        },
        {
          requirementId: "invoke-host",
          nodes: [0],
          operations: ["host.echo@1"],
          authorityRules: [],
          terminalStatuses: [],
        },
      ],
      authorityCeiling: {
        operations: ["host.echo@1"],
        file: null,
        http: null,
        wallClock: false,
        deadlineMs: 30_000,
        limits: {},
      },
      expectedTerminalStatuses: ["completed"],
    }),
  );
  const execution = await executeEffectsModuleBundle({
    manifestPath: join(root, "inspection-bundle/module-build.json"),
    grantPath: join(root, "execution-grant.json"),
    requirementsPath: join(root, "execution-requirements.json"),
    outputDirectory: join(root, "execution-evidence"),
    execute: async () => 42n,
  });
  if (execution.status !== "completed" || execution.version !== 2)
    throw new Error("effects execution evidence smoke mismatch");
  executionEvidenceHash = String(
    (execution.authenticity as Record<string, unknown>).evidenceHash,
  );
  const audit = await auditEffectsExecution({
    manifestPath: join(root, "inspection-bundle/module-build.json"),
    requirementsPath: join(root, "execution-requirements.json"),
    evidenceDirectory: join(root, "execution-evidence"),
    outputDirectory: join(root, "execution-audit"),
  });
  if (audit.status !== "passed")
    throw new Error("effects execution audit smoke mismatch");
  executionAuditHash = String(
    (audit.authenticity as Record<string, unknown>).auditHash,
  );
} finally {
  await rm(root, { recursive: true, force: true });
}

if (i64.add(40n, 2n) !== 42n) throw new Error("effects smoke i64 mismatch");
if (new Decimal(125n, 2).rescale(1, "half-even").coefficient !== 12n)
  throw new Error("effects smoke decimal mismatch");

console.log(
  JSON.stringify({
    ok: true,
    abi: emitted.contract.abi,
    programHash: emitted.contract.programHash,
    wasmBytes: emitted.bytes.length,
    bundleIdentityHash,
    executionEvidenceHash,
    executionAuditHash,
  }),
);
