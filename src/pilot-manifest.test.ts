import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import {
  assertPilotFrozen,
  assertPilotReviewApproved,
  parsePilotFreeze,
  parsePilotManifest,
  parsePilotReview,
  readPilotProtocol,
  requiredPilotFiles,
} from "./pilot-manifest";
import { scanSemanticSource } from "./semantic-source";

const manifestPath = resolve(
  import.meta.dir,
  "../pilots/erp-crud-v1/manifest.json",
);

describe("Private Pilot manifest and freeze", () => {
  test("strictly enforces the ERP shadow protocol", async () => {
    const protocol = await readPilotProtocol(manifestPath);
    expect(protocol.manifest).toMatchObject({
      version: 1,
      id: "erp-crud-v1",
      budget: { cooldownMsAfterEveryAttempt: 60_000 },
      execution: {
        mode: "shadow",
        businessWritesAllowed: false,
        externalIoAllowed: false,
      },
    });
    expect(protocol.manifest.cases).toHaveLength(8);
    expect(protocol.review.status).toBe("approved");
    expect(protocol.manifest.cases.every((entry) => entry.risk === "low")).toBe(
      true,
    );
    expect(Object.keys(protocol.freeze.files)).toEqual(
      requiredPilotFiles(protocol.manifest),
    );
    expect(() => assertPilotFrozen(protocol.freeze)).not.toThrow();
  });

  test("keeps the same Concept across every initial and changed schema", async () => {
    const protocol = await readPilotProtocol(manifestPath);
    const pairs = await Promise.all(
      protocol.manifest.cases.map(async (entry) => ({
        entry,
        initial: await scanSemanticSource(
          resolve(protocol.directory, entry.source),
        ),
        changed: await scanSemanticSource(
          resolve(protocol.directory, entry.schemaEvolutionSource),
        ),
      })),
    );
    for (const { entry, initial, changed } of pairs) {
      expect(changed.concept.id, entry.id).toBe(initial.concept.id);
      expect(changed.concept.hash, entry.id).toBe(initial.concept.hash);
    }
  }, 15_000);

  test("rejects unsafe execution, cooldown, unknown fields, and wrong case count", () => {
    const base = validManifest();
    expect(() =>
      parsePilotManifest({
        ...base,
        execution: {
          mode: "shadow",
          businessWritesAllowed: true,
          externalIoAllowed: false,
        },
      }),
    ).toThrow("business writes and external I/O disabled");
    expect(() =>
      parsePilotManifest({
        ...base,
        budget: {
          ...(base.budget as object),
          cooldownMsAfterEveryAttempt: 59_999,
        },
      }),
    ).toThrow("must be 60000");
    expect(() => parsePilotManifest({ ...base, surprise: true })).toThrow(
      "unknown field surprise",
    );
    expect(() => parsePilotManifest({ ...base, cases: [] })).toThrow(
      "exactly 8 cases",
    );
    expect(() =>
      parsePilotFreeze({
        version: 1,
        status: "draft",
        instructions: "fixture",
        files: { "manifest.json": "bad" },
      }),
    ).toThrow("hash is invalid");
  });

  test("requires a real independent approval before freeze", () => {
    const manifest = parsePilotManifest(validManifest());
    const draft = validReview();
    expect(() =>
      assertPilotReviewApproved(parsePilotReview(draft), manifest),
    ).toThrow("must be approved");

    const approved = {
      ...draft,
      status: "approved",
      reviewer: {
        name: "Independent Reviewer",
        role: "ERP Domain Reviewer",
        independentFromImplementation: true,
      },
      reviewedAt: "2026-07-24T00:00:00.000Z",
      decisions: Object.fromEntries(
        Object.keys(draft.decisions as object).map((key) => [key, true]),
      ),
      cases: (draft.cases as Array<Record<string, unknown>>).map(
        (entry, index) => ({
          ...entry,
          owner: `owner-${index}`,
          approved: true,
        }),
      ),
    };
    const approvedManifest = parsePilotManifest({
      ...validManifest(),
      cases: (validManifest().cases as Array<Record<string, unknown>>).map(
        (entry, index) => ({ ...entry, owner: `owner-${index}` }),
      ),
    });
    expect(() =>
      assertPilotReviewApproved(parsePilotReview(approved), approvedManifest),
    ).not.toThrow();
  });
});

function validManifest(): Record<string, unknown> {
  const cases = Array.from({ length: 8 }, (_, index) => ({
    id: `case-${index}`,
    domain: "inventory",
    source: `semantic/${index}.ts`,
    baseline: "baseline.ts",
    hiddenCases: "hidden.json",
    schemaEvolutionSource: `schema/${index}.ts`,
    fixture: "fixture.json",
    risk: "low",
    owner: "owner",
  }));
  return {
    version: 1,
    id: "fixture",
    freeze: "freeze.json",
    review: "review.json",
    domains: ["inventory"],
    projectFiles: ["project.ts"],
    cases,
    budget: {
      maxApiCalls: 8,
      maxEstimatedCost: 1,
      maxWallClockMs: 60_000,
      maxResponseOutputTokens: 1_000,
      cooldownMsAfterEveryAttempt: 60_000,
    },
    execution: {
      mode: "shadow",
      businessWritesAllowed: false,
      externalIoAllowed: false,
    },
    thresholds: {
      minFirstPassProjectFitRate: 0.8,
      maxUnresolvedRate: 0.3,
      maxFalseResolutions: 0,
    },
  };
}

function validReview(): Record<string, unknown> {
  return {
    version: 1,
    status: "draft",
    reviewer: {
      name: null,
      role: null,
      independentFromImplementation: false,
    },
    reviewedAt: null,
    decisions: {
      businessDefinitionsApproved: false,
      baselinesApproved: false,
      hiddenCasesApproved: false,
      schemaChangesApproved: false,
      syntheticDataOnly: false,
      advisoryOnly: false,
      budgetApproved: false,
      stopAuthorityConfirmed: false,
      goNoGoAuthorityConfirmed: false,
    },
    cases: Array.from({ length: 8 }, (_, index) => ({
      caseId: `case-${index}`,
      owner: "pending",
      risk: "low",
      approved: false,
    })),
  };
}
