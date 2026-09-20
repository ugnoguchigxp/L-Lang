import { afterEach, describe, expect, test } from "bun:test";
import { link, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import analysisTemplate from "../benchmarks/effects-adversarial-v1/research/analysis-plan.json";
import sampleTemplate from "../benchmarks/effects-adversarial-v1/research/sample-size-plan.json";
import {
  parseEffectsAnalysisPlan,
  parseEffectsDatasetProvenance,
  parseEffectsSampleSizePlan,
  readEffectsResearchDocument,
  validateEffectsResearchDesign,
} from "./effects-adversarial-research";
import { fingerprintFor, sha256 } from "./stable-hash";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
function item<T>(values: readonly T[], index: number): T {
  const value = values[index];
  if (value === undefined) throw new Error("Missing test fixture item");
  return value;
}
function provenance() {
  const cases = Array.from(
    { length: sampleTemplate.requiredCasePairs },
    (_, index) => {
      const id = `case-${String(index).padStart(4, "0")}`;
      return {
        id,
        family: `family-${String(index).padStart(4, "0")}`,
        partition: "fixture",
        origin: "fixture-derived",
        previouslyObserved: false,
        sourceHash: sha256(`${id}-source`),
        normalInputHash: sha256(`${id}-normal`),
        adversarialInputHash: sha256(`${id}-adversarial`),
      };
    },
  );
  return {
    format: "llang-effects-dataset-provenance",
    version: 1,
    mode: "fixture",
    author: null,
    source: "synthetic parser fixture",
    license: "MIT",
    createdOn: null,
    samplingFrame: "Synthetic contracts only",
    inclusion: "Parser coverage",
    exclusion: "All empirical claims",
    representativeness: "No population inference",
    strata: cases.map((item) => ({ family: item.family, domain: "synthetic" })),
    cases,
    contamination: {
      status: "not-run",
      comparedCorpusHashes: [] as string[],
      findings: [] as string[],
    },
  };
}
function candidate() {
  const value = provenance();
  return {
    ...value,
    mode: "candidate",
    author: "synthetic-author-id",
    createdOn: "2026-09-20",
    cases: value.cases.map((item) => ({
      ...item,
      partition: "confirmatory",
      origin: "independent",
    })),
  };
}

describe("Effects adversarial research contracts (PR-0)", () => {
  test("accepts immutable templates without promoting fixture evidence", () => {
    const analysis = parseEffectsAnalysisPlan(analysisTemplate);
    expect(Object.isFrozen(analysis.hypotheses[0])).toBe(true);
    const before = fingerprintFor(analysis);
    const copy = structuredClone(analysisTemplate);
    const copied = parseEffectsAnalysisPlan(copy);
    item(copy.hypotheses, 0).minimumPracticalDifference = 0.9;
    expect(fingerprintFor(analysis)).toBe(before);
    expect(fingerprintFor(copied)).toBe(before);
    expect(
      validateEffectsResearchDesign(
        analysisTemplate,
        sampleTemplate,
        provenance(),
      ),
    ).toMatchObject({
      casePairs: 9,
      independentFamilies: 9,
      evidenceEligible: false,
      registered: false,
      independentlyReproduced: false,
      researchComparison: "not-run",
    });
  });
  test("recomputes precision sample size rather than accepting an asserted count", () => {
    expect(parseEffectsSampleSizePlan(sampleTemplate).requiredCasePairs).toBe(
      9,
    );
    for (const halfWidth of [0.01, 0.1, 0.3, 1]) {
      const independentFamilies = Math.ceil(
        (2 * Math.log(80)) / halfWidth ** 2,
      );
      const plan = {
        ...sampleTemplate,
        halfWidth,
        independentFamilies,
        requiredCasePairs: independentFamilies * 2,
        pairsPerFamily: 2,
      };
      expect(parseEffectsSampleSizePlan(plan).independentFamilies).toBe(
        independentFamilies,
      );
      expect(() =>
        parseEffectsSampleSizePlan({
          ...plan,
          independentFamilies: independentFamilies + 1,
        }),
      ).toThrow("RESULT_MISMATCH");
    }
  });
  test("rejects missing, unknown, nonfinite, fractional and out-of-range fields", () => {
    for (const parserAndValue of [
      [parseEffectsAnalysisPlan, analysisTemplate],
      [parseEffectsSampleSizePlan, sampleTemplate],
      [parseEffectsDatasetProvenance, provenance()],
    ] as const) {
      const [parse, value] = parserAndValue;
      for (const key of Object.keys(value)) {
        const changed: Record<string, unknown> = { ...value };
        delete changed[key];
        expect(() => parse(changed)).toThrow();
      }
      expect(() => parse({ ...value, evidenceEligible: true })).toThrow();
      expect(() => parse({ ...value, unknown: undefined })).toThrow();
    }
    for (const value of [0, -1, NaN, Infinity, 0.5, 1000001])
      expect(() =>
        parseEffectsSampleSizePlan({
          ...sampleTemplate,
          independentFamilies: value,
        }),
      ).toThrow();
    for (const value of [0, -1, NaN, Infinity, 1.1])
      expect(() =>
        parseEffectsSampleSizePlan({ ...sampleTemplate, halfWidth: value }),
      ).toThrow();
    expect(() =>
      parseEffectsAnalysisPlan({
        ...analysisTemplate,
        statistics: { ...analysisTemplate.statistics, extra: true },
      }),
    ).toThrow();
    expect(() =>
      parseEffectsAnalysisPlan({
        ...analysisTemplate,
        validity: { ...analysisTemplate.validity, internal: "" },
      }),
    ).toThrow();
  });
  test("rejects non-JSON inputs without invoking getters", () => {
    let invoked = false;
    expect(() =>
      parseEffectsAnalysisPlan({
        get format() {
          invoked = true;
          return "llang-effects-analysis-plan";
        },
      }),
    ).toThrow();
    expect(invoked).toBe(false);
    expect(() => parseEffectsAnalysisPlan(new Date())).toThrow();
    expect(() =>
      parseEffectsAnalysisPlan({ toJSON: () => analysisTemplate }),
    ).toThrow();
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(() => parseEffectsAnalysisPlan(cycle)).toThrow("DEPTH");
  });
  test("fixes RQ coverage, endpoints, comparison, missingness and analysis lanes", () => {
    const mutations = [
      { researchQuestions: analysisTemplate.researchQuestions.slice(1) },
      { researchQuestions: [...analysisTemplate.researchQuestions].reverse() },
      {
        researchQuestions: analysisTemplate.researchQuestions.map((rq) => ({
          ...rq,
          lane: "confirmatory",
        })),
      },
      {
        hypotheses: analysisTemplate.hypotheses.map((h) => ({
          ...h,
          rq: "RQ1",
        })),
      },
      { primaryArms: ["llang", "weak-baseline"] },
      { unitOfAnalysis: "trial" },
      { stopping: "stop-on-significance" },
      {
        missingness: { ...analysisTemplate.missingness, uncertain: "success" },
      },
      { ablations: { lane: "primary", omissionReason: "not available" } },
    ];
    for (const mutation of mutations)
      expect(() =>
        parseEffectsAnalysisPlan({ ...analysisTemplate, ...mutation }),
      ).toThrow();
  });
  test("rejects pilot exposure and derived confirmatory cases", () => {
    for (const origin of [
      "fixture-derived",
      "pilot-derived",
      "public-example",
      "observed-failure",
    ]) {
      const value = candidate();
      item(value.cases, 0).origin = origin;
      expect(() => parseEffectsDatasetProvenance(value)).toThrow(
        "CONTAMINATION",
      );
    }
    const value = candidate();
    item(value.cases, 0).previouslyObserved = true;
    expect(() => parseEffectsDatasetProvenance(value)).toThrow("CONTAMINATION");
    const overlap = candidate();
    item(overlap.cases, 0).partition = "pilot";
    item(overlap.cases, 1).normalInputHash = item(
      overlap.cases,
      0,
    ).adversarialInputHash;
    expect(() => parseEffectsDatasetProvenance(overlap)).toThrow(
      "CONTAMINATION",
    );
  });
  test("binds provenance to canonical cases, family strata and valid calendar dates", () => {
    const mutations = [
      { cases: [...provenance().cases].reverse() },
      { strata: provenance().strata.slice(1) },
      { createdOn: "2026-02-30" },
      { createdOn: "2026-13-01" },
      { mode: "candidate" },
      {
        contamination: {
          status: "passed",
          comparedCorpusHashes: [],
          findings: [],
        },
      },
    ];
    for (const mutation of mutations)
      expect(() =>
        parseEffectsDatasetProvenance({ ...provenance(), ...mutation }),
      ).toThrow();
    const duplicate = provenance();
    item(duplicate.cases, 1).normalInputHash = item(
      duplicate.cases,
      0,
    ).normalInputHash;
    item(duplicate.cases, 1).adversarialInputHash = item(
      duplicate.cases,
      0,
    ).adversarialInputHash;
    expect(() => parseEffectsDatasetProvenance(duplicate)).toThrow(
      "DUPLICATE_CASE_PAIR",
    );
    expect(() =>
      parseEffectsDatasetProvenance({ ...candidate(), mode: "reviewed" }),
    ).toThrow("REVIEW_REQUIRED");
  });
  test("binds sample size to distinct families, balanced pairs and frozen seed", () => {
    const collapsed = provenance();
    for (const item of collapsed.cases) item.family = "single-family";
    collapsed.strata = [{ family: "single-family", domain: "synthetic" }];
    expect(() =>
      validateEffectsResearchDesign(
        analysisTemplate,
        sampleTemplate,
        collapsed,
      ),
    ).toThrow("SAMPLE_DATASET_MISMATCH");
    expect(() =>
      validateEffectsResearchDesign(
        analysisTemplate,
        { ...sampleTemplate, seed: 1 },
        provenance(),
      ),
    ).toThrow("DESIGN_MISMATCH");
    expect(() =>
      validateEffectsResearchDesign(
        analysisTemplate,
        { ...sampleTemplate, purpose: "confirmatory" },
        provenance(),
      ),
    ).toThrow("SAMPLE_DATASET_MISMATCH");
    const value = candidate();
    const result = validateEffectsResearchDesign(
      analysisTemplate,
      { ...sampleTemplate, purpose: "confirmatory" },
      value,
    );
    expect(result.evidenceEligible).toBe(false);
  });
  test("bounds file reads and rejects duplicate keys, symlinks and hard links", async () => {
    const root = await mkdtemp(join(tmpdir(), "effects-research-"));
    temporary.push(root);
    const file = join(root, "analysis.json");
    const bytes = `${JSON.stringify(analysisTemplate)}\n`;
    await writeFile(file, bytes);
    expect(
      (await readEffectsResearchDocument(file, parseEffectsAnalysisPlan))
        .sourceHash,
    ).toBe(sha256(bytes));
    const symbolic = join(root, "symbolic.json");
    await symlink(file, symbolic);
    await expect(
      readEffectsResearchDocument(symbolic, parseEffectsAnalysisPlan),
    ).rejects.toThrow("INVALID_EFFECTS_RESEARCH_FILE");
    const hard = join(root, "hard.json");
    await link(file, hard);
    await expect(
      readEffectsResearchDocument(file, parseEffectsAnalysisPlan),
    ).rejects.toThrow("INVALID_EFFECTS_RESEARCH_FILE");
    await rm(hard);
    await writeFile(
      file,
      bytes.replace('"version":1', '"version":1,"version":1'),
    );
    await expect(
      readEffectsResearchDocument(file, parseEffectsAnalysisPlan),
    ).rejects.toThrow();
    await writeFile(file, " ".repeat(1024 * 1024 + 1));
    await expect(
      readEffectsResearchDocument(file, parseEffectsAnalysisPlan),
    ).rejects.toThrow("INVALID_EFFECTS_RESEARCH_FILE");
    await writeFile(file, new Uint8Array([0xff]));
    await expect(
      readEffectsResearchDocument(file, parseEffectsAnalysisPlan),
    ).rejects.toThrow();
  });
});

// Registration metadata is not an assertion of external research completion.
import claimsTemplate from "../benchmarks/effects-adversarial-v1/research/claims.json";
import {
  createEffectsPreregistrationBundle,
  parseEffectsClaims,
  parseEffectsPreregistrationBundle,
  renderEffectsResearchTemplates,
} from "./effects-adversarial-research";
import { readFile } from "node:fs/promises";

describe("Effects preregistration templates", () => {
  test("binds claims and plans without allowing self-certified evidence", () => {
    const bundle = createEffectsPreregistrationBundle(
      analysisTemplate,
      sampleTemplate,
      claimsTemplate,
    );
    expect(
      parseEffectsPreregistrationBundle(
        bundle,
        analysisTemplate,
        sampleTemplate,
        claimsTemplate,
      ),
    ).toEqual(bundle);
    for (const mutation of [
      { registered: true },
      { externalTimestamp: "2026-09-20" },
      { evidenceEligible: true },
      { independentlyReproduced: true },
      { independentReproductionRecord: "self-attested" },
      { ethics: { ...bundle.ethics, externalNetwork: true } },
      { externalGates: [] },
      { extra: "ignored" },
    ])
      expect(() =>
        parseEffectsPreregistrationBundle(
          { ...bundle, ...mutation },
          analysisTemplate,
          sampleTemplate,
          claimsTemplate,
        ),
      ).toThrow();
    const changed = structuredClone(analysisTemplate);
    item(changed.hypotheses, 0).minimumPracticalDifference = 0.2;
    expect(() =>
      parseEffectsPreregistrationBundle(
        bundle,
        changed,
        sampleTemplate,
        claimsTemplate,
      ),
    ).toThrow("BINDING_MISMATCH");
  });
  test("rejects expanded claims and downgraded evidence requirements", () => {
    const wrongEvidence = structuredClone(claimsTemplate);
    item(wrongEvidence.claims, 1).minimumEvidence = "E1";
    expect(() => parseEffectsClaims(wrongEvidence)).toThrow(
      "EVIDENCE_MISMATCH",
    );
    const wrongEndpoint = structuredClone(claimsTemplate);
    item(wrongEndpoint.claims, 1).endpoint = "normal-completion";
    expect(() => parseEffectsClaims(wrongEndpoint)).toThrow(
      "EVIDENCE_MISMATCH",
    );
    expect(() =>
      parseEffectsClaims({ ...claimsTemplate, unsupportedClaims: [] }),
    ).toThrow();
    expect(() =>
      parseEffectsClaims({
        ...claimsTemplate,
        claims: [...claimsTemplate.claims, claimsTemplate.claims[0]],
      }),
    ).toThrow();
  });
  test("checked-in human-readable templates match deterministic generation", async () => {
    const files = renderEffectsResearchTemplates(
      analysisTemplate,
      sampleTemplate,
      claimsTemplate,
    );
    for (const [name, bytes] of Object.entries(files)) {
      expect(
        await readFile(
          new URL(
            `../benchmarks/effects-adversarial-v1/research/${name}`,
            import.meta.url,
          ),
          "utf8",
        ),
      ).toBe(bytes);
    }
  });
  test("authored labels cannot break out of Markdown code fences", () => {
    const hostile = structuredClone(claimsTemplate);
    item(hostile.claims, 0).limitations =
      "``` <script>unexpected</script> [link](https://example.invalid)";
    const markdown = renderEffectsResearchTemplates(
      analysisTemplate,
      sampleTemplate,
      hostile,
    )["CLAIMS.md"];
    expect(markdown.match(/```/g)?.length).toBe(2);
    expect(markdown).not.toContain("<script>");
  });
});
