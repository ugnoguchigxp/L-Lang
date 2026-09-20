import { lstat, mkdir, open, readdir, realpath, rm } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { verifyEffectsAttestationPackage } from "./llang-effects-audit-attestation";
import { readStableRegularFileSnapshot } from "./llang-effects-stable-file";
import { decodeUtf8, parseStrictJsonObject } from "./llang-jsonc";
import { stableJson } from "./stable-hash";
import { sha256 } from "./stable-hash";
import { readEffectsSignatureEnvelope } from "./llang-effects-attestation-crypto";
import { pathsOverlap } from "./llang-effects-execution-grant";

const MAX_BYTES = 16 * 1024 * 1024;
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

async function create(path: string, text: string) {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(text);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

const text = (value: unknown) =>
  typeof value === "string" && /^[A-Za-z0-9._/@+:-]{1,256}$/.test(value)
    ? value
    : "not-available";
const textArray = (value: unknown) =>
  Array.isArray(value)
    ? value.map(text).filter((item) => item !== "not-available")
    : [];
const count = (value: unknown) =>
  Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0;
const endpointLabels = (value: unknown) =>
  Array.isArray(value)
    ? value
        .filter(object)
        .map((item) => `${text(item.id)} (${text(item.operation)})`)
        .filter((item) => !item.includes("not-available"))
    : [];
const flowLabels = (value: unknown) =>
  Array.isArray(value)
    ? value
        .filter(object)
        .map(
          (item) =>
            `${text(item.source)} -> ${text(item.sink)} (${text(item.purpose)})`,
        )
        .filter((item) => !item.includes("not-available"))
    : [];

export async function explainEffectsAttestation(options: {
  manifestPath: string;
  requirementsPath: string;
  packageDirectory: string;
  trustPolicyPath: string;
  outputDirectory: string;
}) {
  const verificationOptions = {
      manifestPath: options.manifestPath,
      requirementsPath: options.requirementsPath,
      packageDirectory: options.packageDirectory,
      trustPolicyPath: options.trustPolicyPath,
    },
    verification = await verifyEffectsAttestationPackage(verificationOptions),
    packageDirectory = await realpath(resolve(options.packageDirectory)),
    packageInfo = await lstat(packageDirectory),
    auditSnapshot = await readStableRegularFileSnapshot(
      resolve(packageDirectory, "execution-audit.json"),
      MAX_BYTES,
      "INVALID_EFFECTS_ATTESTATION_PACKAGE",
    ),
    projectionSnapshot = await readStableRegularFileSnapshot(
      resolve(packageDirectory, "program.inspection.ts"),
      MAX_BYTES,
      "INVALID_EFFECTS_ATTESTATION_PACKAGE",
    ),
    signedAudit = await readEffectsSignatureEnvelope(
      resolve(packageDirectory, "audit-attestation.json"),
      "audit-attestation",
    ),
    audit = parseStrictJsonObject(
      decodeUtf8(auditSnapshot.bytes, "execution-audit.json"),
      "execution-audit.json",
    );
  if (verification.status !== "trusted")
    throw new Error("EFFECTS_ATTESTATION_NOT_TRUSTED");
  const signedFiles = object(signedAudit.document.payload.files)
    ? signedAudit.document.payload.files
    : undefined;
  if (
    !object(audit) ||
    !signedFiles ||
    signedFiles["execution-audit.json"] !== sha256(auditSnapshot.bytes) ||
    signedFiles["program.inspection.ts"] !== sha256(projectionSnapshot.bytes)
  )
    throw new Error("INVALID_EFFECTS_EXECUTION_AUDIT");
  const requirements = object(audit.requirements) ? audit.requirements : {},
    bundle = object(audit.bundle) ? audit.bundle : {},
    authority = object(audit.authority) ? audit.authority : {},
    execution = object(audit.execution) ? audit.execution : {},
    trust = object(audit.trust) ? audit.trust : {},
    policy = object(trust.policy) ? trust.policy : {},
    approver = object(trust.requirementApprover)
      ? trust.requirementApprover
      : {},
    host = object(trust.executionHost) ? trust.executionHost : {},
    transcript = object(execution.transcript) ? execution.transcript : {},
    coverage = object(requirements.coverage) ? requirements.coverage : {},
    checks = object(audit.checks) ? audit.checks : {},
    trustData = object(audit.trustData) ? audit.trustData : undefined,
    summary = Object.freeze({
      format: "llang-effects-attestation-summary",
      version: 1,
      verification: {
        status: verification.status,
        signatureStatus: verification.signatureStatus,
        auditStatus: verification.auditStatus,
        trustDecision: verification.trustDecision,
        apiCalls: 0,
      },
      policy: {
        id: text(policy.id),
        revision: policy.revision,
      },
      requirement: {
        id: text(requirements.id),
        revision: requirements.revision,
        commitmentHash: requirements.commitmentHash,
        semanticMeaning: "not-proven",
        approverKeyId: text(approver.keyId),
      },
      bundle: {
        identityHash: bundle.bundleIdentityHash,
        entry: text(bundle.entry),
        wasmHash: bundle.bundledWasmHash,
      },
      authority: {
        ceilingCommitmentHash: authority.ceilingCommitmentHash,
        grantCommitmentHash: authority.grantCommitmentHash,
        grantWithinCeiling: authority.grantWithinCeiling,
      },
      execution: {
        status: execution.status,
        hostKeyId: text(host.keyId),
        phase: text(host.phase),
        observedOperations: textArray(transcript.observedOperations),
        unboundObservedOperations: textArray(
          transcript.unboundObservedOperations,
        ),
        cleanupStatus: object(execution.cleanup)
          ? text(execution.cleanup.status)
          : "not-applicable",
      },
      audit: {
        machineChecks: text(checks.machineChecks),
        failures: textArray(checks.failures),
        policyRejections: textArray(checks.policyRejections),
        manualRequirements: count(coverage.manual),
        reviewRequired: count(coverage.reviewRequired),
      },
      trustData: trustData
        ? {
            authorityDerivation: trustData.authorityDerivation,
            staticFlowStatus: trustData.staticFlowStatus,
            observedFlowStatus: trustData.observedFlowStatus,
            rawExternalDataRecorded: trustData.rawExternalDataRecorded,
            sources: trustData.sources,
            sinks: trustData.sinks,
            allowedFlows: trustData.allowedFlows,
          }
        : { status: "not-evaluated" },
      limitations: [
        "natural-language-meaning-not-proven",
        "external-data-truth-not-proven",
        "host-integrity-not-proven",
        "freshness-not-proven",
        "anti-replay-not-provided",
      ],
    }),
    markdown = `# L-Lang Effects attestation summary

## Verification

- Status: ${text(verification.status)}
- Audit: ${text(verification.auditStatus)}
- Trust: ${text(verification.trustDecision)}
- Policy: ${text(policy.id)} revision ${String(policy.revision)}

## Requirement and publishers

- Requirement: ${text(requirements.id)} revision ${String(requirements.revision)}
- Approver: ${text(approver.keyId)}
- Execution host: ${text(host.keyId)}
- Semantic meaning: not proven

## Bundle and authority

- Entry: ${text(bundle.entry)}
- Bundle identity: ${text(bundle.bundleIdentityHash)}
- Wasm: ${text(bundle.bundledWasmHash)}
- Grant within ceiling: ${String(authority.grantWithinCeiling)}

## Trust and data

- Authority derivation: ${text(trustData?.authorityDerivation ?? "not-evaluated")}
- Static flow: ${text(trustData?.staticFlowStatus ?? "not-evaluated")}
- Observed flow: ${text(trustData?.observedFlowStatus ?? "not-evaluated")}
- Raw external data recorded: ${String(trustData?.rawExternalDataRecorded ?? false)}
- Sources: ${endpointLabels(trustData?.sources).join(", ") || "none"}
- Sinks: ${endpointLabels(trustData?.sinks).join(", ") || "none"}
- Allowed flows: ${flowLabels(trustData?.allowedFlows).join(", ") || "none"}

## Execution

- Status: ${text(execution.status)}
- Phase: ${text(host.phase)}
- Observed operations: ${textArray(transcript.observedOperations).join(", ") || "none"}
- Cleanup: ${object(execution.cleanup) ? text(execution.cleanup.status) : "not-applicable"}

## Audit findings

- Machine checks: ${text(checks.machineChecks)}
- Failures: ${textArray(checks.failures).join(", ") || "none"}
- Policy rejections: ${textArray(checks.policyRejections).join(", ") || "none"}
- Manual requirements: ${String(count(coverage.manual))}
- Review required: ${String(count(coverage.reviewRequired))}

## Limitations

- Natural-language meaning is not proven.
- External data truth and host integrity are not proven.
- Freshness and anti-replay are not provided.
`,
    outputInput = resolve(options.outputDirectory),
    parentInfo = await lstat(dirname(outputInput));
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink())
    throw new Error("INVALID_EFFECTS_SUMMARY_OUTPUT_PARENT");
  const parent = await realpath(dirname(outputInput)),
    output = resolve(parent, basename(outputInput));
  const protectedInputs = await Promise.all([
    realpath(resolve(options.manifestPath)),
    realpath(resolve(options.requirementsPath)),
    realpath(resolve(options.trustPolicyPath)),
  ]);
  if (
    pathsOverlap(packageDirectory, output) ||
    protectedInputs.some((input) => pathsOverlap(input, output))
  )
    throw new Error("EFFECTS_SUMMARY_OUTPUT_OVERLAP");
  await mkdir(output);
  const outputInfo = await lstat(output);
  try {
    await create(
      resolve(output, "attestation-summary.json"),
      `${stableJson(summary)}\n`,
    );
    await create(resolve(output, "attestation-summary.md"), markdown);
    await create(
      resolve(output, "program.inspection.ts"),
      decodeUtf8(projectionSnapshot.bytes, "program.inspection.ts"),
    );
    await verifyEffectsAttestationPackage(verificationOptions);
    const expected = [
        "attestation-summary.json",
        "attestation-summary.md",
        "program.inspection.ts",
      ],
      names = (await readdir(output)).sort(),
      currentPackage = await lstat(packageDirectory);
    if (
      names.join("\0") !== expected.join("\0") ||
      currentPackage.dev !== packageInfo.dev ||
      currentPackage.ino !== packageInfo.ino
    )
      throw new Error("EFFECTS_SUMMARY_OUTPUT_CHANGED");
    for (const [name, expectedText] of [
      ["attestation-summary.json", `${stableJson(summary)}\n`],
      ["attestation-summary.md", markdown],
      [
        "program.inspection.ts",
        decodeUtf8(projectionSnapshot.bytes, "program.inspection.ts"),
      ],
    ] as const) {
      const snapshot = await readStableRegularFileSnapshot(
        resolve(output, name),
        MAX_BYTES,
        "EFFECTS_SUMMARY_OUTPUT_CHANGED",
      );
      if (decodeUtf8(snapshot.bytes, name) !== expectedText)
        throw new Error("EFFECTS_SUMMARY_OUTPUT_CHANGED");
    }
  } catch (error) {
    const current = await lstat(output).catch(() => undefined);
    if (
      current?.isDirectory() &&
      !current.isSymbolicLink() &&
      current.dev === outputInfo.dev &&
      current.ino === outputInfo.ino
    )
      await rm(output, { recursive: true });
    throw error;
  }
  return Object.freeze({
    format: "llang-effects-attestation-summary-result",
    version: 1,
    status: verification.status,
    output: basename(output),
    apiCalls: 0,
  });
}
