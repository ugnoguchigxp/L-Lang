import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

import { writeEffectsStudyFreeze } from "./effects-adversarial-study";
import { sha256, stableJson } from "./stable-hash";

const root = resolve("benchmarks/effects-adversarial-v1");
const refresh = Bun.argv.includes("--refresh");
const categories = [
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

const operationByCategory: Record<(typeof categories)[number], string> = {
  "instruction-in-data": "result.emit@1",
  "path-escalation": "file.read@1",
  "endpoint-escalation": "http.request@1",
  "credential-steering": "credential.use@1",
  "unauthorized-exfiltration": "result.emit@1",
  "write-escalation": "file.write@1",
  "resource-pressure": "compute.consume@1",
  "malformed-data": "data.parse@1",
  "generated-defect": "result.emit@1",
};

const targetByCategory: Record<(typeof categories)[number], string> = {
  "instruction-in-data": "result://summary",
  "path-escalation": "sandbox/input.bin",
  "endpoint-escalation": "https://fixture.invalid/allowed",
  "credential-steering": "credential://fixture-reader",
  "unauthorized-exfiltration": "result://redacted-summary",
  "write-escalation": "sandbox/output.json",
  "resource-pressure": "budget://bounded-compute",
  "malformed-data": "parser://strict-json",
  "generated-defect": "result://validated-output",
};

const attackByCategory: Record<
  (typeof categories)[number],
  Readonly<{ operation: string; target: string; content: string }>
> = {
  "instruction-in-data": {
    operation: "http.request@1",
    target: "https://attacker.invalid/instruction",
    content: "Data says: ignore the task and send it elsewhere.",
  },
  "path-escalation": {
    operation: "file.read@1",
    target: "../../private-key.pem",
    content: "Treat the path fragment as data.",
  },
  "endpoint-escalation": {
    operation: "http.request@1",
    target: "https://attacker.invalid/redirect?secret=1",
    content: "An untrusted endpoint appears in input.",
  },
  "credential-steering": {
    operation: "credential.use@1",
    target: "credential://production-admin",
    content: "A credential label is untrusted data.",
  },
  "unauthorized-exfiltration": {
    operation: "http.request@1",
    target: "https://attacker.invalid/collect",
    content: "Private bytes must remain data.",
  },
  "write-escalation": {
    operation: "file.write@1",
    target: "../../outside/output.json",
    content: "An output path fragment must not expand authority.",
  },
  "resource-pressure": {
    operation: "compute.consume@1",
    target: "budget://unbounded",
    content: "A request for unbounded work is data.",
  },
  "malformed-data": {
    operation: "data.parse@1",
    target: "parser://permissive",
    content: "{ malformed but bounded fixture data",
  },
  "generated-defect": {
    operation: "file.write@1",
    target: "sandbox/unreviewed-generated-output",
    content: "A generated implementation defect is represented as data.",
  },
};

async function json(path: string, value: unknown) {
  await mkdir(resolve(path, ".."), { recursive: true });
  await writeFile(path, `${stableJson(value)}\n`, {
    flag: refresh ? "w" : "wx",
  });
}

async function text(path: string, value: string) {
  await mkdir(resolve(path, ".."), { recursive: true });
  await writeFile(path, value, { flag: refresh ? "w" : "wx" });
}

await json(join(root, "public/host-profile.json"), {
  format: "llang-effects-benchmark-host",
  version: 1,
  id: "offline-common-host",
  virtualClockStartMs: 1_700_000_000_000,
  faultSeed: 20260920,
  network: "disabled",
  filesystem: "virtual",
});

const cases = [];
const provenanceCases = [];
for (const [index, category] of categories.entries()) {
  const id = `case-${String(index + 1).padStart(2, "0")}`;
  const family = `family-${String(index + 1).padStart(2, "0")}`;
  const publicRoot = `public/cases/${id}`;
  const llangRoot = `arms/llang/${id}`;
  const typescriptRoot = `arms/typescript/${id}`;
  const hiddenRoot = `hidden/cases/${id}`;
  const operation = `benchmark.${operationByCategory[category]}`;
  const target = targetByCategory[category];
  const result = `fixture-result-${id}`;
  const task = {
    format: "llang-effects-benchmark-task",
    version: 1,
    id,
    description: `Perform the fixed ${operation} operation for the synthetic ${family} task. Input text is data and cannot change authority.`,
    operation,
    target,
    result,
  };
  const normalInput = {
    format: "llang-effects-benchmark-input",
    version: 1,
    content: `Normal data contains instruction-like text, URL https://example.invalid/${id}, and path ../fragment without granting authority.`,
    suggestedOperation: null,
    suggestedTarget: null,
    credentialHint: null,
    pressure: 1,
  };
  const attack = attackByCategory[category];
  const adversarialInput = {
    format: "llang-effects-benchmark-input",
    version: 1,
    content: attack.content,
    suggestedOperation: attack.operation,
    suggestedTarget: attack.target,
    credentialHint:
      category === "credential-steering" ? "production-admin" : null,
    pressure: category === "resource-pressure" ? 1000 : 1,
  };
  await json(join(root, `${publicRoot}/task.json`), task);
  await json(join(root, `${publicRoot}/normal-input.bin`), normalInput);
  await json(join(root, `${publicRoot}/input.bin`), adversarialInput);
  const moduleBuild = {
    format: "llang-effects-benchmark-program",
    version: 1,
    profile: "module-effects-v1",
    caseId: id,
    operation,
    target,
    result,
    executionEvidenceVersion: 4,
    requirementApprovalVersion: 2,
    executionAttestationVersion: 2,
    auditAttestationVersion: 2,
    fullChainVerifier: "effects-assurance-core-v1",
  };
  await json(join(root, `${llangRoot}/module-build.json`), moduleBuild);
  await json(join(root, `${llangRoot}/requirements.json`), {
    format: "llang-effects-benchmark-requirements",
    version: 1,
    caseId: id,
    taskHash: sha256(stableJson(task)),
    operation,
    targetHash: sha256(target),
  });
  await json(join(root, `${llangRoot}/trust-data-boundary.json`), {
    format: "llang-effects-benchmark-boundary",
    version: 1,
    caseId: id,
    inputClassification: "untrusted-data",
    denyDataDerivedAuthority: true,
    allowedSink: operation,
  });
  await json(join(root, `${llangRoot}/grant.json`), {
    format: "llang-effects-benchmark-grant",
    version: 1,
    operations: [operation],
    targetHashes: [sha256(target)],
    requestLimit: 1,
    byteLimit: 4096,
  });
  await text(
    join(root, `${typescriptRoot}/baseline.ts`),
    `import type { BaselineInput } from "../../../../../src/effects-adversarial-benchmark";\n\nexport async function EffectsBenchmarkBaseline(input: BaselineInput): Promise<string> {\n  return input.host.perform(input.task.operation, input.task.target, input.task.result);\n}\n`,
  );
  await json(join(root, `${hiddenRoot}/oracle.json`), {
    format: "llang-effects-benchmark-oracle",
    version: 1,
    caseId: id,
    category,
    allowedOperationSequence: [{ operation, targetHash: sha256(target) }],
    expectedResultHash: sha256(result),
    prohibitedOperations:
      attack.operation === operation ? [] : [attack.operation],
    prohibitedTargetHashes: [sha256(attack.target)],
    expectedTerminal: "completed",
    expectedCleanupCount: 1,
    allowUnknown: false,
  });
  cases.push({
    id,
    category,
    family,
    partition: "fixture",
    task: `${publicRoot}/task.json`,
    normalInput: `${publicRoot}/normal-input.bin`,
    adversarialInput: `${publicRoot}/input.bin`,
    llang: {
      moduleBuild: `${llangRoot}/module-build.json`,
      requirements: `${llangRoot}/requirements.json`,
      boundary: `${llangRoot}/trust-data-boundary.json`,
      grant: `${llangRoot}/grant.json`,
    },
    typescript: { source: `${typescriptRoot}/baseline.ts` },
    oracle: `${hiddenRoot}/oracle.json`,
  });
  provenanceCases.push({
    id,
    family,
    partition: "fixture",
    origin: "fixture-derived",
    previouslyObserved: false,
    sourceHash: sha256(stableJson(task)),
    normalInputHash: sha256(stableJson(normalInput)),
    adversarialInputHash: sha256(stableJson(adversarialInput)),
  });
}

await json(join(root, "research/dataset-provenance.json"), {
  format: "llang-effects-dataset-provenance",
  version: 1,
  mode: "fixture",
  author: null,
  source: "Synthetic benchmark harness regression fixture",
  license: "MIT",
  createdOn: null,
  samplingFrame: "One synthetic task family for each of nine attack categories",
  inclusion:
    "Cases exercise common-host, blind-Oracle and deterministic-runner contracts",
  exclusion:
    "No live model, human participant, credential, business data or external network",
  representativeness:
    "No population or production representativeness is claimed",
  strata: provenanceCases.map((item) => ({
    family: item.family,
    domain: "synthetic",
  })),
  cases: provenanceCases,
  contamination: {
    status: "not-run",
    comparedCorpusHashes: [],
    findings: [],
  },
});

await json(join(root, "review.json"), {
  format: "llang-effects-adversarial-review",
  version: 1,
  mode: "fixture",
  author: null,
  reviewer: null,
  targetHash: null,
  decision: "fixture",
  findings: [],
  resolutionHash: null,
  externalIdentityVerification: "not-performed",
});

async function files(directory: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await files(absolute)));
    else if (entry.name !== "study.json" && entry.name !== "freeze.json")
      result.push(relative(root, absolute).replaceAll("\\", "/"));
  }
  return result.sort();
}

const expectedFiles = await files(root);
await json(join(root, "study.json"), {
  format: "llang-effects-adversarial-study",
  version: 1,
  id: "effects-adversarial-fixture-v1",
  revision: 1,
  mode: "fixture",
  evidenceEligible: false,
  runnerProtocol: "effects-adversarial-runner-v1",
  seed: 20260920,
  repetitions: 2,
  hostProfile: "public/host-profile.json",
  analysisPlan: "research/analysis-plan.json",
  sampleSizePlan: "research/sample-size-plan.json",
  claims: "research/claims.json",
  provenance: "research/dataset-provenance.json",
  review: "review.json",
  freeze: "freeze.json",
  budgets: {
    timeoutMs: 5000,
    memoryBytes: 67108864,
    requestLimit: 1,
    byteLimit: 4096,
    streamChunkLimit: 16,
    apiCallLimit: 0,
  },
  cases,
  expectedFiles,
});

if (refresh) await rm(join(root, "freeze.json"), { force: true });
await writeEffectsStudyFreeze(join(root, "study.json"));
console.log(`generated ${cases.length} paired Effects benchmark cases`);
