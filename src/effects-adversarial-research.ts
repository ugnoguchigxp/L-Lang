import Ajv2020 from "ajv/dist/2020";
import { resolve } from "node:path";
import claimsSchema from "../schemas/effects-claims-v1.schema.json";
import bundleSchema from "../schemas/effects-preregistration-bundle-v1.schema.json";
import analysisSchema from "../schemas/effects-analysis-plan-v1.schema.json";
import sampleSchema from "../schemas/effects-sample-size-plan-v1.schema.json";
import provenanceSchema from "../schemas/effects-dataset-provenance-v1.schema.json";
import { decodeUtf8, parseStrictJsonObject } from "./llang-jsonc";
import { readStableRegularFileSnapshot } from "./llang-effects-stable-file";
import { fingerprintFor, sha256, stableJson } from "./stable-hash";

export type EffectsAnalysisPlan = Readonly<{
  format: "llang-effects-analysis-plan";
  version: 1;
  id: string;
  revision: number;
  researchQuestions: readonly Readonly<{
    id: "RQ1" | "RQ2" | "RQ3" | "RQ4";
    question: string;
    lane: "confirmatory" | "exploratory";
  }>[];
  primaryArms: readonly ["llang", "typescript"];
  unitOfAnalysis: "normal-adversarial-case-pair";
  repetitionReduction: "all-repetitions-must-pass";
  familyAggregation: "equal-weight-family-means";
  hypotheses: readonly Readonly<{
    id: string;
    rq: "RQ1" | "RQ2";
    endpoint: "adversarial-violation-free-completion" | "normal-completion";
    estimand: "llang-minus-typescript";
    alternative: "superiority" | "noninferiority";
    minimumPracticalDifference: number;
    decisionRule: "simultaneous-lower-bound-exceeds-margin";
  }>[];
  statistics: Readonly<{
    method: "paired-family-hoeffding-v1";
    confidenceLevel: 0.95;
    test: "hoeffding-one-sided-bound";
    multiplicity: "bonferroni-two-confirmatory-endpoints";
    secondary: "exploratory-no-confirmatory-claims";
    seed: number;
    digits: number;
    softwareVersion: "llang-effects-analysis-v1";
  }>;
  missingness: Readonly<{
    failed: "failure";
    timeout: "failure";
    unknown: "missing";
    uncertain: "missing";
    excluded: "retain-with-reason";
    primary: "complete-pairs-with-attrition";
    sensitivity: "missing-llang-failure-typescript-success";
    emptyAnalysis: "not-estimable";
  }>;
  stopping: "fixed-sample-no-optional-stopping";
  ablations: Readonly<{ lane: "exploratory-separate"; omissionReason: string }>;
  validity: Readonly<{
    construct: string;
    internal: string;
    external: string;
    conclusion: string;
  }>;
}>;

export type EffectsSampleSizePlan = Readonly<{
  format: "llang-effects-sample-size-plan";
  version: 1;
  method: "paired-family-hoeffding-precision-v1";
  formula: "ceil(2*ln(2*endpoints/alpha)/(halfWidth*halfWidth))";
  softwareVersion: "llang-effects-analysis-v1";
  seed: number;
  alpha: 0.05;
  endpoints: 2;
  halfWidth: number;
  pairsPerFamily: number;
  independentFamilies: number;
  requiredCasePairs: number;
  assumptions: Readonly<{
    independentFamilies: true;
    withinFamilyDependence: "arbitrary";
    pairedDifferenceRange: readonly [-1, 1];
    repetitionsIncreaseSampleSize: false;
  }>;
  purpose: "fixture" | "confirmatory";
}>;

export type EffectsDatasetProvenance = Readonly<{
  format: "llang-effects-dataset-provenance";
  version: 1;
  mode: "fixture" | "candidate" | "reviewed";
  author: string | null;
  source: string;
  license: string;
  createdOn: string | null;
  samplingFrame: string;
  inclusion: string;
  exclusion: string;
  representativeness: string;
  strata: readonly Readonly<{ family: string; domain: string }>[];
  cases: readonly Readonly<{
    id: string;
    family: string;
    partition: "fixture" | "pilot" | "confirmatory";
    origin:
      | "independent"
      | "fixture-derived"
      | "pilot-derived"
      | "public-example"
      | "observed-failure";
    previouslyObserved: boolean;
    sourceHash: string;
    normalInputHash: string;
    adversarialInputHash: string;
  }>[];
  contamination: Readonly<{
    status: "not-run" | "passed" | "failed";
    comparedCorpusHashes: readonly string[];
    findings: readonly string[];
  }>;
}>;

const ajv = new Ajv2020({ strict: true, allErrors: false });
const validateAnalysis = ajv.compile<EffectsAnalysisPlan>(analysisSchema);
const validateSample = ajv.compile<EffectsSampleSizePlan>(sampleSchema);
const validateProvenance =
  ajv.compile<EffectsDatasetProvenance>(provenanceSchema);

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}

// Copy only standard, bounded JSON before validation; callers retain no mutable
// references to accepted contracts. Text readers also reject duplicate keys.
function snapshot(value: unknown): unknown {
  function assertJson(item: unknown, depth: number): void {
    if (depth > 64) throw new Error("INVALID_EFFECTS_RESEARCH_DEPTH");
    if (item === null || typeof item === "string" || typeof item === "boolean")
      return;
    if (typeof item === "number" && Number.isFinite(item)) return;
    if (
      !item ||
      typeof item !== "object" ||
      (!Array.isArray(item) &&
        Object.getPrototypeOf(item) !== Object.prototype &&
        Object.getPrototypeOf(item) !== null)
    )
      throw new Error("INVALID_EFFECTS_RESEARCH_JSON");
    if (
      Array.isArray(item) &&
      (Object.keys(item).length !== item.length ||
        Object.keys(item).some((key, index) => key !== String(index)))
    )
      throw new Error("INVALID_EFFECTS_RESEARCH_JSON");
    for (const key of Reflect.ownKeys(item)) {
      if (Array.isArray(item) && key === "length") continue;
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (
        typeof key !== "string" ||
        !descriptor?.enumerable ||
        !("value" in descriptor)
      )
        throw new Error("INVALID_EFFECTS_RESEARCH_JSON");
      assertJson(descriptor.value, depth + 1);
    }
  }
  assertJson(value, 0);
  const json = JSON.stringify(value);
  if (!json || Buffer.byteLength(json) > 1024 * 1024)
    throw new Error("INVALID_EFFECTS_RESEARCH_SIZE");
  // Ajv uniqueItems uses ordinary object methods; strict text parsing has
  // already handled duplicate keys at the file boundary.
  return JSON.parse(json) as unknown;
}

function canonicalIds(ids: readonly string[]): boolean {
  return (
    ids.length === new Set(ids).size &&
    ids.join("\0") === [...ids].sort().join("\0")
  );
}

export function parseEffectsAnalysisPlan(value: unknown): EffectsAnalysisPlan {
  const document = snapshot(value);
  if (!validateAnalysis(document))
    throw new Error("INVALID_EFFECTS_ANALYSIS_PLAN");
  if (
    document.researchQuestions.map((rq) => rq.id).join(",") !==
      "RQ1,RQ2,RQ3,RQ4" ||
    document.researchQuestions.some(
      (rq) =>
        rq.lane !==
        (rq.id === "RQ1" || rq.id === "RQ2" ? "confirmatory" : "exploratory"),
    ) ||
    !canonicalIds(document.hypotheses.map((hypothesis) => hypothesis.id)) ||
    document.hypotheses[0]?.rq !== "RQ1" ||
    document.hypotheses[0]?.endpoint !==
      "adversarial-violation-free-completion" ||
    document.hypotheses[0]?.alternative !== "superiority" ||
    document.hypotheses[1]?.rq !== "RQ2" ||
    document.hypotheses[1]?.endpoint !== "normal-completion" ||
    document.hypotheses[1]?.alternative !== "noninferiority"
  )
    throw new Error("INCONSISTENT_EFFECTS_ANALYSIS_PLAN");
  return freeze(document);
}

export function parseEffectsSampleSizePlan(
  value: unknown,
): EffectsSampleSizePlan {
  const document = snapshot(value);
  if (!validateSample(document))
    throw new Error("INVALID_EFFECTS_SAMPLE_SIZE_PLAN");
  // A family mean of paired binary differences lies in [-1, 1]. Hoeffding's
  // two-sided bound is 2 exp(-n h²/2). Union-bound over the two endpoints.
  const families = Math.ceil(
    (2 * Math.log((2 * document.endpoints) / document.alpha)) /
      document.halfWidth ** 2,
  );
  if (
    document.independentFamilies !== families ||
    document.requiredCasePairs !== families * document.pairsPerFamily
  )
    throw new Error("EFFECTS_SAMPLE_SIZE_RESULT_MISMATCH");
  return freeze(document);
}

export function parseEffectsDatasetProvenance(
  value: unknown,
): EffectsDatasetProvenance {
  const document = snapshot(value);
  if (!validateProvenance(document))
    throw new Error("INVALID_EFFECTS_DATASET_PROVENANCE");
  if (
    !canonicalIds(document.cases.map((item) => item.id)) ||
    !canonicalIds(document.strata.map((item) => item.family)) ||
    !canonicalIds(document.contamination.comparedCorpusHashes) ||
    document.cases.some(
      (item) =>
        !document.strata.some((stratum) => stratum.family === item.family),
    ) ||
    document.strata.some(
      (stratum) =>
        !document.cases.some((item) => item.family === stratum.family),
    ) ||
    (document.createdOn !== null &&
      (!Number.isFinite(Date.parse(document.createdOn)) ||
        new Date(document.createdOn).toISOString().slice(0, 10) !==
          document.createdOn)) ||
    (document.mode !== "fixture" &&
      (!document.author || !document.createdOn)) ||
    (document.mode === "fixture" &&
      document.cases.some((item) => item.partition !== "fixture")) ||
    (document.mode !== "fixture" &&
      document.cases.some((item) => item.partition === "fixture")) ||
    (document.contamination.status === "passed" &&
      (document.contamination.comparedCorpusHashes.length === 0 ||
        document.contamination.findings.length !== 0))
  )
    throw new Error("INCONSISTENT_EFFECTS_DATASET_PROVENANCE");
  const exposedHashes = new Set(
    document.cases
      .filter(
        (item) =>
          item.partition !== "confirmatory" ||
          item.previouslyObserved ||
          item.origin !== "independent",
      )
      .flatMap((item) => [
        item.sourceHash,
        item.normalInputHash,
        item.adversarialInputHash,
      ]),
  );
  const confirmatory = document.cases.filter(
    (item) => item.partition === "confirmatory",
  );
  if (
    confirmatory.some(
      (item) =>
        item.origin !== "independent" ||
        item.previouslyObserved ||
        [item.sourceHash, item.normalInputHash, item.adversarialInputHash].some(
          (hash) => exposedHashes.has(hash),
        ),
    )
  )
    throw new Error("EFFECTS_CONFIRMATORY_CONTAMINATION");
  // Exact duplicated pairs must not inflate sample size. Semantic duplicates
  // and derivatives still require the external contamination review.
  if (
    new Set(
      document.cases.map(
        (item) => `${item.normalInputHash}/${item.adversarialInputHash}`,
      ),
    ).size !== document.cases.length
  )
    throw new Error("EFFECTS_DUPLICATE_CASE_PAIR");
  if (
    document.mode === "reviewed" &&
    document.contamination.status !== "passed"
  )
    throw new Error("EFFECTS_CONTAMINATION_REVIEW_REQUIRED");
  return freeze(document);
}

export async function readEffectsResearchDocument<T>(
  file: string,
  parser: (value: unknown) => T,
): Promise<
  Readonly<{ document: T; sourceHash: string; commitmentHash: string }>
> {
  const bytes = (
    await readStableRegularFileSnapshot(
      resolve(file),
      1024 * 1024,
      "INVALID_EFFECTS_RESEARCH_FILE",
    )
  ).bytes;
  const document = parser(
    parseStrictJsonObject(
      decodeUtf8(bytes, "effects-research"),
      "effects-research",
    ),
  );
  return Object.freeze({
    document,
    sourceHash: sha256(bytes),
    commitmentHash: sha256(stableJson(document)),
  });
}

export function validateEffectsResearchDesign(
  analysisValue: unknown,
  sampleValue: unknown,
  provenanceValue: unknown,
) {
  const analysis = parseEffectsAnalysisPlan(analysisValue);
  const sample = parseEffectsSampleSizePlan(sampleValue);
  const provenance = parseEffectsDatasetProvenance(provenanceValue);
  if (
    analysis.statistics.seed !== sample.seed ||
    analysis.statistics.softwareVersion !== sample.softwareVersion
  )
    throw new Error("EFFECTS_RESEARCH_DESIGN_MISMATCH");
  const cases = provenance.cases.filter(
    (item) =>
      item.partition ===
      (sample.purpose === "fixture" ? "fixture" : "confirmatory"),
  );
  const families = new Map<string, number>();
  for (const item of cases)
    families.set(item.family, (families.get(item.family) ?? 0) + 1);
  if (
    (sample.purpose === "fixture") !== (provenance.mode === "fixture") ||
    cases.length !== sample.requiredCasePairs ||
    families.size !== sample.independentFamilies ||
    [...families.values()].some((count) => count !== sample.pairsPerFamily)
  )
    throw new Error("EFFECTS_SAMPLE_DATASET_MISMATCH");
  return freeze({
    format: "llang-effects-research-design-validation",
    version: 1,
    analysisHash: fingerprintFor(analysis),
    sampleSizeHash: fingerprintFor(sample),
    provenanceHash: fingerprintFor(provenance),
    casePairs: cases.length,
    independentFamilies: families.size,
    evidenceEligible: false,
    registered: false,
    independentlyReproduced: false,
    externalIdentityVerification: "not-performed",
    researchComparison: "not-run",
  } as const);
}

export type EffectsClaims = Readonly<{
  format: "llang-effects-claims";
  version: 1;
  claims: readonly Readonly<{
    id:
      | "fixture-fault-detection"
      | "adversarial-mechanism-efficacy"
      | "normal-completion-maintenance";
    minimumEvidence: "E1" | "E2";
    population: string;
    endpoint:
      | "adversarial-violation-free-completion"
      | "normal-completion"
      | null;
    limitations: string;
  }>[];
  unsupportedClaims: readonly [
    "live-model-generation-quality",
    "human-auditability",
    "general-typescript-superiority",
    "production-safety",
  ];
}>;
const validateClaims = ajv.compile<EffectsClaims>(claimsSchema);
const validateBundle = ajv.compile(bundleSchema);
export function parseEffectsClaims(value: unknown): EffectsClaims {
  const document = snapshot(value);
  if (!validateClaims(document)) throw new Error("INVALID_EFFECTS_CLAIMS");
  const expected = [
    ["fixture-fault-detection", "E1", null],
    [
      "adversarial-mechanism-efficacy",
      "E2",
      "adversarial-violation-free-completion",
    ],
    ["normal-completion-maintenance", "E2", "normal-completion"],
  ];
  if (
    document.claims.some(
      (claim, index) =>
        claim.id !== expected[index]?.[0] ||
        claim.minimumEvidence !== expected[index]?.[1] ||
        claim.endpoint !== expected[index]?.[2],
    )
  )
    throw new Error("EFFECTS_CLAIM_EVIDENCE_MISMATCH");
  return freeze(document);
}

// This prepares a submission bundle. External registration and reproduction
// are deliberately absent: software must not manufacture either assertion.
export function createEffectsPreregistrationBundle(
  analysisValue: unknown,
  sampleValue: unknown,
  claimsValue: unknown,
) {
  const analysis = parseEffectsAnalysisPlan(analysisValue);
  const sample = parseEffectsSampleSizePlan(sampleValue);
  const claims = parseEffectsClaims(claimsValue);
  if (analysis.statistics.seed !== sample.seed)
    throw new Error("EFFECTS_RESEARCH_DESIGN_MISMATCH");
  return freeze({
    format: "llang-effects-preregistration-bundle",
    version: 1,
    analysisHash: fingerprintFor(analysis),
    sampleSizeHash: fingerprintFor(sample),
    claimsHash: fingerprintFor(claims),
    registered: false,
    externalTimestamp: null,
    independentlyReproduced: false,
    independentReproductionRecord: null,
    evidenceEligible: false,
    ethics: {
      humanParticipants: false,
      realCredentials: false,
      realBusinessData: false,
      externalNetwork: false,
      externalRegistrationPerformed: false,
    },
    externalGates: [
      "independent-dataset-author",
      "independent-domain-review",
      "immutable-external-timestamp",
      "owner-run-approval",
      "third-party-reproduction",
    ],
  } as const);
}

export function parseEffectsPreregistrationBundle(
  value: unknown,
  analysis: unknown,
  sample: unknown,
  claims: unknown,
) {
  const document = snapshot(value);
  if (!validateBundle(document))
    throw new Error("INVALID_EFFECTS_PREREGISTRATION_BUNDLE");
  const expected = createEffectsPreregistrationBundle(analysis, sample, claims);
  if (stableJson(document) !== stableJson(expected))
    throw new Error("EFFECTS_PREREGISTRATION_BINDING_MISMATCH");
  return expected;
}

export function renderEffectsResearchTemplates(
  analysisValue: unknown,
  sampleValue: unknown,
  claimsValue: unknown,
) {
  const analysis = parseEffectsAnalysisPlan(analysisValue);
  const sample = parseEffectsSampleSizePlan(sampleValue);
  const claims = parseEffectsClaims(claimsValue);
  const bundle = createEffectsPreregistrationBundle(analysis, sample, claims);
  // JSON quotations in code fences preserve authored text without turning it
  // into Markdown links, tables, HTML or executable instructions.
  const quoted = (value: unknown) =>
    JSON.stringify(value, null, 2)
      .replaceAll("<", "\\u003c")
      .replaceAll("`", "\\u0060");
  return Object.freeze({
    "CLAIMS.md": `# Effects claim-to-evidence matrix

Status: research comparison not-run; evidenceEligible: false.

\`\`\`json
${quoted(claims)}
\`\`\`
`,
    "preregistration.md": `# Effects preregistration template

Unregistered ${sample.purpose} template. No independent identities, external timestamp or reproduction record has been supplied.

The machine-readable analysis and sample-size plans are authoritative. These choices require independent review before confirmatory use.

## Analysis contract

\`\`\`json
${quoted(analysis)}
\`\`\`

## Precision contract

\`\`\`json
${quoted(sample)}
\`\`\`

Each family mean is in [-1, 1]. For n independent families and half-width h, the two-sided Hoeffding bound is 2 exp(-n h^2 / 2). Bonferroni over two endpoints gives n = ceil(2 ln(4 / 0.05) / h^2). This is a conservative precision bound, not a power calculation or a guarantee of family independence. Within-family dependence is unrestricted; repetition never increases n.

Reference: [Hoeffding (1963)](https://doi.org/10.1080/01621459.1963.10500830). The seed is committed for the later runner; this analytic formula uses no random draws.

## Registration status

\`\`\`json
${quoted(bundle)}
\`\`\`
`,
    "preregistration-bundle.json": `${stableJson(bundle)}\n`,
  });
}
