import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  inspectEffectsModuleBundle,
  readVerifiedEffectsExecutionSnapshot,
} from "./llang-effects-bundle-inspection";
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
import { generateEffectsAttestationKeyPair } from "./llang-effects-attestation-crypto";
import { createEffectsRequirementApproval } from "./llang-effects-requirement-approval";
import {
  attestEffectsAudit,
  verifyEffectsAttestationPackage,
} from "./llang-effects-audit-attestation";
import { stableJson } from "./stable-hash";
import { readEffectsRequirementContract } from "./llang-effects-requirement-contract";
import { explainEffectsAttestation } from "./llang-effects-attestation-summary";

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
let signedAttestationAuditHash = "";
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
  const approverKey = join(root, "approver-key"),
    hostKey = join(root, "host-key"),
    auditorKey = join(root, "auditor-key");
  await generateEffectsAttestationKeyPair(approverKey);
  await generateEffectsAttestationKeyPair(hostKey);
  await generateEffectsAttestationKeyPair(auditorKey);
  const publicKeys = await Promise.all(
      [approverKey, hostKey, auditorKey].map(
        async (directory) =>
          JSON.parse(
            await readFile(join(directory, "public-key.json"), "utf8"),
          ) as {
            keyId: string;
            algorithm: "Ed25519";
            publicKeySpki: string;
          },
      ),
    ),
    trustPolicyPath = join(root, "trust-policy.json"),
    approvalPath = join(root, "requirements-approval.json"),
    boundaryPath = join(root, "trust-data-boundary.json");
  await writeFile(
    trustPolicyPath,
    `${stableJson({
      format: "llang-effects-trust-policy",
      version: 1,
      id: "smoke.policy",
      revision: 1,
      keys: publicKeys
        .map(({ keyId, algorithm, publicKeySpki }) => ({
          keyId,
          algorithm,
          publicKeySpki,
        }))
        .sort((left, right) => left.keyId.localeCompare(right.keyId)),
      roles: {
        requirementApprovers: [publicKeys[0]?.keyId],
        executionHosts: [publicKeys[1]?.keyId],
        auditors: [publicKeys[2]?.keyId],
      },
      revokedKeyIds: [],
      rules: {
        distinctRoleKeys: true,
        allowReviewRequired: false,
        allowRecoveredExecution: false,
      },
    })}\n`,
  );
  const assuredSnapshot = await readVerifiedEffectsExecutionSnapshot(
      join(root, "inspection-bundle/module-build.json"),
    ),
    assuredRequirements = await readEffectsRequirementContract(
      join(root, "execution-requirements.json"),
      assuredSnapshot.bundleIdentityHash,
      assuredSnapshot.graph,
    ),
    operations = [
      ...new Set(
        assuredSnapshot.graph.program.nodes.flatMap((node) =>
          node.kind === "task"
            ? node.tasks.map((task) => `${task.operation}@${task.version}`)
            : [`${node.operation}@${node.version}`],
        ),
      ),
    ].sort(),
    sources = operations.map((operation, index) => ({
      id: `source-${index}`,
      operation,
      responsePath: [],
      classification: "untrusted-data",
    })),
    sinks = operations.map((operation, index) => ({
      id: `sink-${index}`,
      operation,
      requestPath: [],
      classification: "external-output",
    }));
  await writeFile(
    boundaryPath,
    `${stableJson({
      format: "llang-effects-trust-boundary",
      version: 1,
      id: "smoke.boundary",
      revision: 1,
      requirements: {
        id: assuredRequirements.document.id,
        revision: assuredRequirements.document.revision,
        commitmentHash: assuredRequirements.commitmentHash,
      },
      sources,
      sinks,
      allowedFlows: sources
        .flatMap((source) =>
          sinks.map((sink) => ({
            source: source.id,
            sink: sink.id,
            purpose: "smoke-flow",
          })),
        )
        .sort((left, right) =>
          `${left.source}\0${left.sink}\0${left.purpose}`.localeCompare(
            `${right.source}\0${right.sink}\0${right.purpose}`,
          ),
        ),
      rules: {
        denyUnlistedFlows: true,
        denyDataDerivedAuthority: true,
        rawExternalDataInAudit: false,
      },
    })}\n`,
  );
  await createEffectsRequirementApproval({
    manifestPath: join(root, "inspection-bundle/module-build.json"),
    requirementsPath: join(root, "execution-requirements.json"),
    signingKeyPath: join(approverKey, "private-key.pem"),
    outputPath: approvalPath,
    trustBoundaryPath: boundaryPath,
  });
  const signedExecution = await executeEffectsModuleBundle({
    manifestPath: join(root, "inspection-bundle/module-build.json"),
    grantPath: join(root, "execution-grant.json"),
    requirementsPath: join(root, "execution-requirements.json"),
    approvalPath,
    trustPolicyPath,
    hostSigningKeyPath: join(hostKey, "private-key.pem"),
    trustBoundaryPath: boundaryPath,
    outputDirectory: join(root, "signed-execution-evidence"),
    execute: async () => 42n,
  });
  if (signedExecution.status !== "completed" || signedExecution.version !== 4)
    throw new Error("signed effects execution smoke mismatch");
  const signedAudit = await auditEffectsExecution({
    manifestPath: join(root, "inspection-bundle/module-build.json"),
    requirementsPath: join(root, "execution-requirements.json"),
    evidenceDirectory: join(root, "signed-execution-evidence"),
    trustPolicyPath,
    requireAttestation: true,
    outputDirectory: join(root, "signed-execution-audit"),
  });
  if (signedAudit.status !== "passed")
    throw new Error("signed effects audit smoke mismatch");
  await attestEffectsAudit({
    manifestPath: join(root, "inspection-bundle/module-build.json"),
    requirementsPath: join(root, "execution-requirements.json"),
    auditDirectory: join(root, "signed-execution-audit"),
    trustPolicyPath,
    signingKeyPath: join(auditorKey, "private-key.pem"),
    outputDirectory: join(root, "signed-attestation-package"),
  });
  const signedVerification = await verifyEffectsAttestationPackage({
    manifestPath: join(root, "inspection-bundle/module-build.json"),
    requirementsPath: join(root, "execution-requirements.json"),
    packageDirectory: join(root, "signed-attestation-package"),
    trustPolicyPath,
  });
  if (signedVerification.status !== "trusted")
    throw new Error("signed effects package smoke mismatch");
  await explainEffectsAttestation({
    manifestPath: join(root, "inspection-bundle/module-build.json"),
    requirementsPath: join(root, "execution-requirements.json"),
    packageDirectory: join(root, "signed-attestation-package"),
    trustPolicyPath,
    outputDirectory: join(root, "attestation-summary"),
  });
  signedAttestationAuditHash = String(signedVerification.auditHash);
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
    signedAttestationAuditHash,
  }),
);
