import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import { arch, platform } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import {
  assertEffectsBundleIdentity,
  readVerifiedEffectsExecutionSnapshot,
} from "./llang-effects-bundle-inspection";
import {
  ResourceLedger,
  type OperationDefinition,
} from "./llang-effects-contract";
import {
  pathsOverlap,
  readEffectsExecutionGrant,
  type ParsedEffectsExecutionGrant,
} from "./llang-effects-execution-grant";
import {
  assertEffectsRequirementIdentity,
  assertGrantWithinRequirement,
  readEffectsRequirementContract,
  type ParsedEffectsRequirementContract,
} from "./llang-effects-requirement-contract";
import {
  createTypedIoExecutor,
  runTypedEffectsSnapshot,
  type TypedOperationExecutor,
} from "./llang-effects-typed-runtime";
import type { BoundedPullStream } from "./llang-effects-concurrency";
import { encodeEffectWire, type EffectValue } from "./llang-effects-ir";
import { LocalFileAdapter } from "./llang-io-file-adapter";
import { HttpAdapter } from "./llang-io-http-adapter";
import {
  decodeUtf8,
  LLANG_SOURCE_BYTES,
  parseStrictJsonObject,
} from "./llang-jsonc";
import { fingerprintFor, sha256, stableJson } from "./stable-hash";
import {
  classifyExecutionError,
  EffectsTranscriptWriter,
  readEffectsTranscript,
} from "./llang-effects-transcript-writer";
import {
  readStableRegularFile,
  readStableRegularFileSnapshot,
} from "./llang-effects-stable-file";
import { readEffectsSigningKey } from "./llang-effects-attestation-crypto";
import {
  assertEffectsTrustRole,
  readEffectsTrustPolicy,
} from "./llang-effects-trust-policy";
import { readAndVerifyEffectsRequirementApproval } from "./llang-effects-requirement-approval";
import { createEffectsExecutionAttestation } from "./llang-effects-execution-attestation";
import {
  effectsObservedFlowSummary,
  readEffectsTrustBoundary,
} from "./llang-effects-trust-boundary";

export const LLANG_EFFECTS_EXECUTION_VERSION = 2 as const;
export const LLANG_EFFECTS_SIGNED_EXECUTION_VERSION = 3 as const;
export const LLANG_EFFECTS_ASSURED_EXECUTION_VERSION = 4 as const;

type CredentialState = Readonly<{
  headers: ReadonlyMap<string, Readonly<Record<string, string>>>;
  names: readonly string[];
  accessed: boolean;
}>;

export type EffectsExecutionReport = Readonly<Record<string, unknown>> &
  Readonly<{ status: "completed" | "failed" | "cancelled" | "incomplete" }>;

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length &&
  Object.keys(value).every((key) => keys.includes(key));

async function durableCreateText(path: string, value: string): Promise<void> {
  const pending = resolve(
      dirname(path),
      `.${basename(path)}.${randomUUID()}.pending`,
    ),
    handle = await open(pending, "wx", 0o600);
  try {
    await handle.writeFile(value);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(pending, path);
    const directory = await open(dirname(path), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await unlink(pending).catch(() => undefined);
  }
}

async function readCredentialEnvironment(
  path?: string,
  allowedOrigins: ReadonlySet<string> = new Set(),
): Promise<CredentialState> {
  if (!path)
    return Object.freeze({ headers: new Map(), names: [], accessed: false });
  const absolute = resolve(path),
    bytes = await readStableRegularFile(
      absolute,
      LLANG_SOURCE_BYTES,
      "INVALID_CREDENTIAL_MAPPING_FILE",
    );
  const value = parseStrictJsonObject(decodeUtf8(bytes, absolute), absolute);
  if (
    !object(value) ||
    !exact(value, ["format", "version", "origins"]) ||
    value.format !== "llang-effects-credential-env" ||
    value.version !== 1 ||
    !object(value.origins)
  )
    throw new Error("INVALID_CREDENTIAL_MAPPING");
  const headers = new Map<string, Readonly<Record<string, string>>>(),
    names = new Set<string>();
  for (const [origin, rawHeaders] of Object.entries(value.origins)) {
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      throw new Error("INVALID_CREDENTIAL_MAPPING");
    }
    if (
      parsed.origin !== origin ||
      !allowedOrigins.has(origin) ||
      !object(rawHeaders)
    )
      throw new Error("INVALID_CREDENTIAL_MAPPING");
    const resolved = Object.create(null) as Record<string, string>;
    for (const [name, environmentName] of Object.entries(rawHeaders)) {
      const lower = name.toLowerCase();
      if (
        name !== lower ||
        typeof environmentName !== "string" ||
        !/^[A-Za-z_][A-Za-z0-9_]*$/.test(environmentName) ||
        !["authorization", "proxy-authorization", "cookie"].includes(lower)
      )
        throw new Error("INVALID_CREDENTIAL_MAPPING");
      const credential = process.env[environmentName];
      if (credential === undefined)
        throw new Error("MISSING_CREDENTIAL_ENVIRONMENT");
      resolved[lower] = credential;
      names.add(lower);
    }
    headers.set(origin, Object.freeze(resolved));
  }
  return Object.freeze({
    headers,
    names: Object.freeze([...names].sort()),
    accessed: true,
  });
}

async function prepareOutput(
  manifestPath: string,
  outputDirectory: string,
  grant: ParsedEffectsExecutionGrant,
) {
  const directory = resolve(outputDirectory),
    parentInfo = await lstat(dirname(directory));
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink())
    throw new Error("INVALID_EVIDENCE_OUTPUT_PARENT");
  const parent = await realpath(dirname(directory)),
    target = resolve(parent, basename(directory)),
    bundleRoot = await realpath(dirname(resolve(manifestPath)));
  if (pathsOverlap(bundleRoot, target))
    throw new Error("EVIDENCE_OVERLAPS_BUNDLE");
  if (grant.adapterRoot && pathsOverlap(grant.adapterRoot, target))
    throw new Error("EVIDENCE_OVERLAPS_FILE_ROOT");
  await mkdir(target);
  const info = await lstat(target);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error("INVALID_EVIDENCE_OUTPUT");
  return Object.freeze({ path: target, dev: info.dev, ino: info.ino });
}

async function assertRequirementOutsideWritableGrant(
  requirements: ParsedEffectsRequirementContract,
  grant: ParsedEffectsExecutionGrant,
) {
  if (!grant.adapterRoot || !grant.document.file?.replace) return;
  const requirementPath = await realpath(requirements.path),
    relativePath = relative(grant.adapterRoot, requirementPath);
  if (
    relativePath === "" ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  )
    return;
  const logicalPath = relativePath.split(sep).join("/"),
    writable = grant.document.file.logicalRoots.some(
      (root) => logicalPath === root || logicalPath.startsWith(`${root}/`),
    );
  if (writable) throw new Error("REQUIREMENTS_INSIDE_WRITABLE_FILE_GRANT");
}

async function assertOutputIdentity(output: {
  path: string;
  dev: number;
  ino: number;
}) {
  const info = await lstat(output.path);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.dev !== output.dev ||
    info.ino !== output.ino
  )
    throw new Error("EVIDENCE_OUTPUT_CHANGED");
}

async function assertOwnedFile(
  path: string,
  identity: Readonly<{ dev: number; ino: number }>,
  expected?: string,
) {
  const snapshot = await readStableRegularFileSnapshot(
      path,
      16 * 1024 * 1024,
      "EXECUTION_EVIDENCE_FILE_CHANGED",
    ),
    info = snapshot;
  if (info.dev !== identity.dev || info.ino !== identity.ino)
    throw new Error("EXECUTION_EVIDENCE_FILE_CHANGED");
  if (
    expected !== undefined &&
    new TextDecoder("utf-8", { fatal: true }).decode(snapshot.bytes) !==
      expected
  )
    throw new Error("EXECUTION_EVIDENCE_FILE_CHANGED");
}

function resultForError(error: unknown) {
  const classified = classifyExecutionError(error);
  return Object.freeze({
    status:
      classified.code === "cancelled" || classified.code === "timeout"
        ? "cancelled"
        : "failed",
    errorCode: classified.code,
    certainty: classified.certainty,
  });
}

export async function executeEffectsModuleBundle(options: {
  manifestPath: string;
  grantPath: string;
  outputDirectory: string;
  requirementsPath?: string;
  approvalPath?: string;
  trustPolicyPath?: string;
  hostSigningKeyPath?: string;
  trustBoundaryPath?: string;
  credentialEnvironmentPath?: string;
  execute?: TypedOperationExecutor;
  openStream?: (
    operation: OperationDefinition,
    request: EffectValue,
    context: Readonly<{ signal: AbortSignal }>,
  ) => Promise<BoundedPullStream>;
  signal?: AbortSignal;
  now?: () => number;
}): Promise<EffectsExecutionReport> {
  const signedOptionCount = [
    options.approvalPath,
    options.trustPolicyPath,
    options.hostSigningKeyPath,
  ].filter(Boolean).length;
  if (signedOptionCount !== 0 && signedOptionCount !== 3)
    throw new Error("INCOMPLETE_EFFECTS_ATTESTATION_OPTIONS");
  if (signedOptionCount && !options.requirementsPath)
    throw new Error("SIGNED_EXECUTION_REQUIRES_REQUIREMENTS");
  if (options.trustBoundaryPath && signedOptionCount !== 3)
    throw new Error("TRUST_BOUNDARY_REQUIRES_SIGNED_EXECUTION");
  const snapshot = await readVerifiedEffectsExecutionSnapshot(
      options.manifestPath,
    ),
    grant = await readEffectsExecutionGrant(
      options.grantPath,
      snapshot.bundleIdentityHash,
      snapshot.graph.manifest,
    ),
    requirements = options.requirementsPath
      ? await readEffectsRequirementContract(
          options.requirementsPath,
          snapshot.bundleIdentityHash,
          snapshot.graph,
        )
      : undefined;
  if (requirements) {
    assertGrantWithinRequirement(grant, requirements);
    await assertRequirementOutsideWritableGrant(requirements, grant);
  }
  const signed = signedOptionCount === 3,
    boundary =
      options.trustBoundaryPath && requirements
        ? await readEffectsTrustBoundary(
            options.trustBoundaryPath,
            requirements,
            snapshot.graph,
          )
        : undefined,
    issuancePolicy = signed
      ? await readEffectsTrustPolicy(options.trustPolicyPath as string)
      : undefined,
    hostSigningKey = signed
      ? await readEffectsSigningKey(options.hostSigningKeyPath as string)
      : undefined;
  if (issuancePolicy && hostSigningKey)
    assertEffectsTrustRole(
      issuancePolicy,
      "executionHosts",
      hostSigningKey.keyId,
    );
  const approval =
      signed && issuancePolicy && requirements
        ? await readAndVerifyEffectsRequirementApproval({
            approvalPath: options.approvalPath as string,
            snapshot,
            requirements,
            policy: issuancePolicy,
            ...(boundary ? { boundary } : {}),
          })
        : undefined,
    approvalBytes = approval
      ? await readStableRegularFileSnapshot(
          approval.path,
          1024 * 1024,
          "EFFECTS_REQUIREMENT_APPROVAL_CHANGED",
        )
      : undefined,
    policyBytes = issuancePolicy
      ? await readStableRegularFileSnapshot(
          issuancePolicy.path,
          1024 * 1024,
          "EFFECTS_TRUST_POLICY_CHANGED",
        )
      : undefined,
    boundaryBytes = boundary
      ? await readStableRegularFileSnapshot(
          boundary.path,
          1024 * 1024,
          "EFFECTS_TRUST_BOUNDARY_CHANGED",
        )
      : undefined;
  if (
    (approvalBytes && sha256(approvalBytes.bytes) !== approval?.sourceHash) ||
    (policyBytes && sha256(policyBytes.bytes) !== issuancePolicy?.sourceHash) ||
    (boundaryBytes && sha256(boundaryBytes.bytes) !== boundary?.sourceHash)
  )
    throw new Error("EFFECTS_ATTESTATION_INPUT_CHANGED");
  const credentials = await readCredentialEnvironment(
      options.credentialEnvironmentPath,
      new Set(grant.document.http?.origins ?? []),
    ),
    output = await prepareOutput(
      options.manifestPath,
      options.outputDirectory,
      grant,
    ),
    executionId = randomUUID(),
    startedAt = (options.now ?? Date.now)(),
    monotonicStartedAt = performance.now(),
    lockPath = resolve(output.path, "execution.lock"),
    intentPath = resolve(output.path, "execution-intent.json"),
    transcriptPath = resolve(output.path, "effects-transcript.jsonl"),
    reportPath = resolve(output.path, "effects-execution.json"),
    approvalCopyPath = resolve(output.path, "requirements-approval.json"),
    policyCopyPath = resolve(output.path, "issuance-trust-policy.json"),
    attestationPath = resolve(output.path, "execution-attestation.json"),
    boundaryCopyPath = resolve(output.path, "trust-data-boundary.json"),
    provenancePath = resolve(output.path, "static-provenance.json"),
    ownerToken = randomUUID(),
    lock = {
      format: "llang-effects-execution-lock",
      version: 1,
      executionId,
      ownerToken,
      pid: process.pid,
      startedAt,
    },
    intent = {
      format: "llang-effects-execution-intent",
      version: boundary ? 4 : signed ? 3 : requirements ? 2 : 1,
      executionId,
      bundleIdentityHash: snapshot.bundleIdentityHash,
      grantSourceHash: grant.sourceHash,
      grantCommitmentHash: grant.commitmentHash,
      bundledWasmHash: sha256(snapshot.wasmBytes),
      startedAt,
      deadlineMs: grant.document.deadlineMs,
      credentialInjection: credentials.accessed
        ? "host-provided-not-recorded"
        : "not-needed",
      credentialHeaderNames: credentials.names,
      ...(requirements
        ? {
            grantSummary: grant.summary,
            requirements: {
              id: requirements.document.id,
              revision: requirements.document.revision,
              sourceHash: requirements.sourceHash,
              commitmentHash: requirements.commitmentHash,
              authorityCommitmentHash: requirements.authorityCommitmentHash,
            },
          }
        : {}),
      ...(signed && approval && issuancePolicy && hostSigningKey
        ? {
            attestation: {
              approvalSourceHash: approval.sourceHash,
              approvalPayloadHash: approval.document.payloadHash,
              approvalKeyId: approval.document.keyId,
              issuancePolicyId: issuancePolicy.document.id,
              issuancePolicyRevision: issuancePolicy.document.revision,
              issuancePolicySourceHash: issuancePolicy.sourceHash,
              issuancePolicyCommitmentHash: issuancePolicy.commitmentHash,
              hostKeyId: hostSigningKey.keyId,
            },
          }
        : {}),
      ...(boundary
        ? {
            boundary: {
              id: boundary.document.id,
              revision: boundary.document.revision,
              sourceHash: boundary.sourceHash,
              commitmentHash: boundary.commitmentHash,
              provenanceHash: boundary.provenanceHash,
            },
          }
        : {}),
    },
    intentText = `${stableJson(intent)}\n`;
  await durableCreateText(lockPath, `${stableJson(lock)}\n`);
  if (approvalBytes && policyBytes) {
    await durableCreateText(
      approvalCopyPath,
      decodeUtf8(approvalBytes.bytes, options.approvalPath as string),
    );
    await durableCreateText(
      policyCopyPath,
      decodeUtf8(policyBytes.bytes, options.trustPolicyPath as string),
    );
  }
  if (boundaryBytes && boundary) {
    await durableCreateText(
      boundaryCopyPath,
      decodeUtf8(boundaryBytes.bytes, boundary.path),
    );
    await durableCreateText(
      provenancePath,
      `${stableJson(boundary.provenance)}\n`,
    );
  }
  await durableCreateText(intentPath, intentText);
  const lockIdentity = await lstat(lockPath),
    intentIdentity = await lstat(intentPath);

  const recorder = await EffectsTranscriptWriter.create(transcriptPath),
    ledger = new ResourceLedger(grant.limits),
    file = grant.adapterRoot
      ? await LocalFileAdapter.create(grant.adapterRoot)
      : undefined,
    http = grant.document.http
      ? new HttpAdapter(
          new Set(grant.document.http.origins),
          credentials.headers,
          {
            allowPublic: grant.document.http.allowPublic,
            allowedAddresses: grant.document.http.allowedAddresses,
          },
        )
      : undefined,
    ioExecute = createTypedIoExecutor({
      ...(file ? { file } : {}),
      ...(http ? { http } : {}),
    }),
    controller = new AbortController(),
    abort = () => controller.abort(options.signal?.reason),
    timer = setTimeout(
      () => controller.abort(new Error("TIMEOUT")),
      grant.document.deadlineMs,
    );
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  let result: EffectValue | undefined,
    resultStatus:
      | ReturnType<typeof resultForError>
      | Readonly<{
          status: "completed";
          resultHash: string;
          resultType: unknown;
          bytes: number;
          certainty: "known";
        }>,
    cleanupFailures: string[] = [];
  try {
    const abortable = async <T>(run: () => Promise<T>): Promise<T> => {
      if (controller.signal.aborted) throw new Error("CANCELLED");
      let rejectAbort: ((error: Error) => void) | undefined;
      const cancelled = new Promise<never>((_resolve, reject) => {
          rejectAbort = reject;
        }),
        onAbort = () =>
          rejectAbort?.(
            controller.signal.reason instanceof Error
              ? controller.signal.reason
              : new Error("CANCELLED"),
          );
      controller.signal.addEventListener("abort", onAbort, { once: true });
      try {
        return await Promise.race([run(), cancelled]);
      } finally {
        controller.signal.removeEventListener("abort", onAbort);
      }
    };
    const execute: TypedOperationExecutor = async (
      operation,
      request,
      context,
    ) => {
      if (operation.id === "clock.wall") {
        if (!grant.grant.wallClock)
          throw new Error("PERMISSION_DENIED: wall clock");
        return BigInt((options.now ?? Date.now)());
      }
      if (["file.read", "file.write", "http.request"].includes(operation.id))
        return abortable(() => ioExecute(operation, request, context));
      const customExecute = options.execute;
      if (customExecute)
        return abortable(() => customExecute(operation, request, context));
      throw new Error(`UNSUPPORTED_OPERATION: ${operation.id}`);
    };
    result = (
      await runTypedEffectsSnapshot({
        graph: snapshot.graph,
        wasmBytes: snapshot.wasmBytes,
        states: snapshot.states,
        grant: grant.grant,
        execute,
        ...(options.openStream ? { openStream: options.openStream } : {}),
        ledger,
        concurrency: grant.limits.concurrentTasks,
        signal: controller.signal,
        recorder,
        sessionId: executionId,
      })
    ).result;
    const encoded = encodeEffectWire(snapshot.graph.program.resultType, result);
    resultStatus = Object.freeze({
      status: "completed",
      resultHash: sha256(encoded),
      resultType: snapshot.manifest.resultType,
      bytes: encoded.length,
      certainty: "known",
    });
  } catch (error) {
    resultStatus = resultForError(error);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
    for (const dispose of [
      file ? () => file.dispose() : undefined,
      http ? () => http.dispose() : undefined,
    ])
      if (dispose)
        try {
          await dispose();
        } catch {
          cleanupFailures.push("adapter-cleanup");
        }
  }

  if (
    (cleanupFailures.length || recorder.cleanupFailures) &&
    resultStatus.status === "completed"
  )
    resultStatus = Object.freeze({
      status: "failed",
      errorCode: "internal",
      certainty: "unknown",
    });
  let bundleChangedAfterStart = false;
  try {
    await assertEffectsBundleIdentity(
      options.manifestPath,
      snapshot.bundleIdentityHash,
    );
  } catch {
    bundleChangedAfterStart = true;
    resultStatus = Object.freeze({
      status: "failed",
      errorCode: "bundle-changed",
      certainty: "known",
    });
  }
  let grantChangedAfterStart = false;
  try {
    await assertOwnedFile(grant.path, grant.fileIdentity);
    const currentGrant = await readEffectsExecutionGrant(
      grant.path,
      snapshot.bundleIdentityHash,
      snapshot.graph.manifest,
    );
    if (
      currentGrant.sourceHash !== grant.sourceHash ||
      currentGrant.commitmentHash !== grant.commitmentHash
    )
      throw new Error("EFFECTS_GRANT_CHANGED");
  } catch {
    grantChangedAfterStart = true;
    resultStatus = Object.freeze({
      status: "failed",
      errorCode: "grant-changed",
      certainty: "known",
    });
  }
  let requirementsChangedAfterStart = false;
  if (requirements)
    try {
      await assertEffectsRequirementIdentity(
        requirements,
        snapshot.bundleIdentityHash,
        snapshot.graph,
      );
    } catch {
      requirementsChangedAfterStart = true;
      resultStatus = Object.freeze({
        status: "failed",
        errorCode: "requirements-changed",
        certainty: "known",
      });
    }
  await recorder.append({
    kind: "terminal",
    outcome: {
      code: resultStatus.status,
      certainty: resultStatus.certainty,
    },
  });
  await recorder.close();
  const transcript = await readEffectsTranscript(transcriptPath);
  const observedFlow = boundary
      ? effectsObservedFlowSummary(boundary, transcript.events)
      : undefined,
    observedFlowHash = observedFlow ? fingerprintFor(observedFlow) : undefined;
  cleanupFailures = [
    ...cleanupFailures,
    ...transcript.events
      .filter(
        (event) => event.kind === "cleanup" && event.outcome?.code !== "ok",
      )
      .map(() => "operation-cleanup"),
  ];
  const finishedAt = (options.now ?? Date.now)(),
    durationMs = Math.max(0, performance.now() - monotonicStartedAt),
    resource = ledger.snapshot(),
    unreleased = Object.fromEntries(
      (["concurrentIo", "concurrentTasks", "openResources", "streams"] as const)
        .filter((name) => resource.used[name] !== 0)
        .map((name) => [name, resource.used[name]]),
    ),
    unknownOutcomes = transcript.events.filter(
      (event) => event.outcome?.certainty === "unknown",
    ).length,
    base = {
      format: "llang-effects-execution",
      version: boundary
        ? LLANG_EFFECTS_ASSURED_EXECUTION_VERSION
        : signed
          ? LLANG_EFFECTS_SIGNED_EXECUTION_VERSION
          : requirements
            ? LLANG_EFFECTS_EXECUTION_VERSION
            : 1,
      executionId,
      status: resultStatus.status,
      bundle: {
        bundleIdentityHash: snapshot.bundleIdentityHash,
        entry: snapshot.manifest.entry,
        abi: snapshot.manifest.abi,
        manifestHash: sha256(stableJson(snapshot.manifest)),
        bundledWasmHash: sha256(snapshot.wasmBytes),
        inspectionVersion: snapshot.inspection.version,
        inspection: "passed",
        bundleChangedAfterStart,
      },
      grant: {
        sourceHash: grant.sourceHash,
        commitmentHash: grant.commitmentHash,
        summary: grant.summary,
        changedAfterStart: grantChangedAfterStart,
      },
      ...(requirements
        ? {
            requirements: {
              status: "bound",
              id: requirements.document.id,
              revision: requirements.document.revision,
              sourceHash: requirements.sourceHash,
              commitmentHash: requirements.commitmentHash,
              authorityCommitmentHash: requirements.authorityCommitmentHash,
              bundleIdentityHash: requirements.document.bundleIdentityHash,
              coverage: requirements.coverage,
              changedAfterStart: requirementsChangedAfterStart,
              semanticMeaning: "not-proven",
            },
            authority: {
              ceilingCommitmentHash: requirements.authorityCommitmentHash,
              grantWithinCeiling: true,
              exceededRules: [],
            },
          }
        : {}),
      runtime: {
        bundledWasmHash: sha256(snapshot.wasmBytes),
        stateContractHash: fingerprintFor(snapshot.manifest.wasm?.states ?? []),
        stateCount: snapshot.states.length,
        hostRuntime: "llang-effects-execution-v1",
      },
      transcript: {
        format: "llang-effects-transcript",
        version: 1,
        path: "effects-transcript.jsonl",
        events: transcript.events.length,
        bytes: transcript.bytes,
        fileHash: transcript.hash,
        firstHash: transcript.events[0]?.eventHash ?? null,
        finalHash: transcript.finalHash,
      },
      result: resultStatus,
      resource: {
        ...resource,
        unreleased,
        fuelUnit: "continuation-yield",
        memoryUnit: "instantiated-wasm-byte",
      },
      cleanup: {
        attempted: true,
        completed: cleanupFailures.length === 0,
        failures: cleanupFailures,
        unknownOutcomes,
      },
      credential: {
        status: credentials.accessed ? "accessed" : "not-needed",
        headerNames: credentials.names,
        values: "not-recorded",
      },
      timing: {
        startedAt,
        finishedAt,
        durationMs,
        durationClock: "monotonic",
      },
      provenance: {
        os: platform(),
        arch: arch(),
        bun: process.versions.bun ?? "not-bun",
        compiler: "0.1.0-dev.1",
        binaryen: "132.0.0",
        typescript: "5.9.3",
      },
      authenticity: {
        attestation: signed ? "detached-ed25519" : "not-signed",
        retention: "caller-managed",
        ...(hostSigningKey ? { signerKeyId: hostSigningKey.keyId } : {}),
      },
      ...(boundary && observedFlow && observedFlowHash
        ? {
            trustData: {
              boundary: {
                id: boundary.document.id,
                revision: boundary.document.revision,
                sourceHash: boundary.sourceHash,
                commitmentHash: boundary.commitmentHash,
              },
              staticProvenanceHash: boundary.provenanceHash,
              staticFlowStatus: "passed",
              observedFlowStatus: "matched",
              observedFlow,
              observedFlowHash,
              authorityDerivation: "static-not-data-derived",
              rawExternalDataRecorded: false,
            },
          }
        : {}),
      limitations: [
        "host-and-service-authenticity-not-proven",
        "business-correctness-not-proven",
        "external-side-effects-not-rolled-back",
      ],
    },
    evidenceHash = fingerprintFor({
      report: base,
      intentHash: sha256(intentText),
      transcriptHash: transcript.hash,
    }),
    report = Object.freeze({
      ...base,
      authenticity: { ...base.authenticity, evidenceHash },
    }) as EffectsExecutionReport,
    reportText = `${stableJson(report)}\n`;
  await assertOutputIdentity(output);
  await assertOwnedFile(lockPath, lockIdentity);
  await assertOwnedFile(intentPath, intentIdentity, intentText);
  await durableCreateText(reportPath, reportText);
  const reportIdentity = await lstat(reportPath);
  await assertOutputIdentity(output);
  await assertOwnedFile(lockPath, lockIdentity);
  await assertOwnedFile(intentPath, intentIdentity, intentText);
  await assertOwnedFile(reportPath, reportIdentity, reportText);
  if (signed && approval && issuancePolicy && hostSigningKey && requirements) {
    const [currentApproval, currentPolicy, copiedApproval, copiedPolicy] =
      await Promise.all([
        readStableRegularFileSnapshot(
          approval.path,
          1024 * 1024,
          "EFFECTS_ATTESTATION_INPUT_CHANGED",
        ),
        readStableRegularFileSnapshot(
          issuancePolicy.path,
          1024 * 1024,
          "EFFECTS_ATTESTATION_INPUT_CHANGED",
        ),
        readStableRegularFileSnapshot(
          approvalCopyPath,
          1024 * 1024,
          "EXECUTION_EVIDENCE_FILE_CHANGED",
        ),
        readStableRegularFileSnapshot(
          policyCopyPath,
          1024 * 1024,
          "EXECUTION_EVIDENCE_FILE_CHANGED",
        ),
      ]);
    if (
      !approvalBytes ||
      !policyBytes ||
      currentApproval.dev !== approvalBytes.dev ||
      currentApproval.ino !== approvalBytes.ino ||
      sha256(currentApproval.bytes) !== approval.sourceHash ||
      currentPolicy.dev !== policyBytes.dev ||
      currentPolicy.ino !== policyBytes.ino ||
      sha256(currentPolicy.bytes) !== issuancePolicy.sourceHash ||
      sha256(copiedApproval.bytes) !== approval.sourceHash ||
      sha256(copiedPolicy.bytes) !== issuancePolicy.sourceHash
    )
      throw new Error("EFFECTS_ATTESTATION_INPUT_CHANGED");
    if (boundary && boundaryBytes) {
      const [currentBoundary, copiedBoundary, copiedProvenance] =
        await Promise.all([
          readStableRegularFileSnapshot(
            boundary.path,
            1024 * 1024,
            "EFFECTS_ATTESTATION_INPUT_CHANGED",
          ),
          readStableRegularFileSnapshot(
            boundaryCopyPath,
            1024 * 1024,
            "EXECUTION_EVIDENCE_FILE_CHANGED",
          ),
          readStableRegularFileSnapshot(
            provenancePath,
            1024 * 1024,
            "EXECUTION_EVIDENCE_FILE_CHANGED",
          ),
        ]);
      if (
        currentBoundary.dev !== boundaryBytes.dev ||
        currentBoundary.ino !== boundaryBytes.ino ||
        sha256(currentBoundary.bytes) !== boundary.sourceHash ||
        sha256(copiedBoundary.bytes) !== boundary.sourceHash ||
        decodeUtf8(copiedProvenance.bytes, provenancePath) !==
          `${stableJson(boundary.provenance)}\n`
      )
        throw new Error("EFFECTS_ATTESTATION_INPUT_CHANGED");
    }
    const attestation = createEffectsExecutionAttestation(
        {
          format: "llang-effects-execution-attestation",
          version: boundary ? 2 : 1,
          executionId,
          phase: "normal",
          approval: {
            sourceHash: approval.sourceHash,
            payloadHash: approval.document.payloadHash,
            keyId: approval.document.keyId,
          },
          issuancePolicy: {
            id: issuancePolicy.document.id,
            revision: issuancePolicy.document.revision,
            sourceHash: issuancePolicy.sourceHash,
            commitmentHash: issuancePolicy.commitmentHash,
          },
          intentHash: sha256(intentText),
          bundle: {
            bundleIdentityHash: snapshot.bundleIdentityHash,
            bundledWasmHash: sha256(snapshot.wasmBytes),
          },
          requirements: {
            sourceHash: requirements.sourceHash,
            commitmentHash: requirements.commitmentHash,
            authorityCommitmentHash: requirements.authorityCommitmentHash,
          },
          grant: {
            sourceHash: grant.sourceHash,
            commitmentHash: grant.commitmentHash,
          },
          transcript: {
            fileHash: transcript.hash,
            finalHash: transcript.finalHash,
            events: transcript.events.length,
          },
          execution: {
            reportHash: sha256(reportText),
            evidenceHash,
            status: resultStatus.status,
            certainty: resultStatus.certainty,
            cleanupCommitmentHash: fingerprintFor(
              report.cleanup as Readonly<Record<string, unknown>>,
            ),
            resourceCommitmentHash: fingerprintFor(
              report.resource as Readonly<Record<string, unknown>>,
            ),
            replayedOperations: 0,
          },
          ...(boundary && observedFlowHash
            ? {
                boundary: {
                  sourceHash: boundary.sourceHash,
                  commitmentHash: boundary.commitmentHash,
                  provenanceHash: boundary.provenanceHash,
                  observedFlowHash,
                },
              }
            : {}),
        },
        hostSigningKey,
      ),
      attestationText = `${stableJson(attestation)}\n`;
    await durableCreateText(attestationPath, attestationText);
    const attestationIdentity = await lstat(attestationPath);
    await assertOwnedFile(
      attestationPath,
      attestationIdentity,
      attestationText,
    );
  }
  await unlink(lockPath);
  return report;
}
