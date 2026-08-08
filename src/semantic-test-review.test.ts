import { describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { relative, resolve } from "node:path";
import { readSemanticTestLock } from "./semantic-test-lock";
import {
  approveSemanticTestReview,
  createSemanticTestReviewCandidate,
  readSemanticTestReviewCandidate,
} from "./semantic-test-review";

const workspaceRoot = resolve(import.meta.dir, "..");

describe("Semantic Test Plan review", () => {
  test("stores a review candidate without freezing and freezes only after approval", async () => {
    const parent = resolve(workspaceRoot, ".semantic", "test-workspaces");
    await mkdir(parent, { recursive: true });
    const testRoot = await mkdtemp(resolve(parent, "semantic-test-review-"));
    const sourcePath = resolve(testRoot, "semantic.ts");
    const outsideRoot = await mkdtemp(
      resolve(tmpdir(), "semantic-test-review-outside-"),
    );
    const testLockPath = resolve(testRoot, "semantic-test.lock");
    const reviewRoot = resolve(testRoot, "reviews");
    try {
      await writeFile(sourcePath, renderSource(testRoot), "utf8");
      const created = await createSemanticTestReviewCandidate({
        sourcePath,
        workspaceRoot,
        reviewRoot,
        provider: "fixture:test-review",
        model: "fixture-model",
        resolve: async (request) => ({
          synthesis: {
            outcome: "resolved",
            plan: {
              version: 1,
              contractHash: request.contractHash,
              obligations: [
                {
                  id: "accepted",
                  kind: "example",
                  sourceClauses: ["requirements[0]"],
                  strength: "hard",
                  rationale: "Enabled is accepted.",
                  input: { enabled: true },
                  expected: true,
                },
                {
                  id: "rejected",
                  kind: "example",
                  sourceClauses: ["exclusions[0]"],
                  strength: "hard",
                  rationale: "Disabled is rejected.",
                  input: { enabled: false },
                  expected: false,
                },
              ],
            },
            diagnostics: [],
          },
          response: null,
          rawOutput: { fixture: true },
        }),
      });

      expect(created.apiCalls).toBe(0);
      expect(await exists(testLockPath)).toBe(false);
      expect(
        (
          await readSemanticTestReviewCandidate(created.candidate.id, {
            workspaceRoot,
            reviewRoot,
          })
        ).approval,
      ).toBeNull();

      const approved = await approveSemanticTestReview(
        created.candidate.id,
        {
          reviewer: "staging-user",
          workspaceRoot,
          reviewRoot,
          testLockPath,
        },
      );
      expect(approved.status).toBe("approved");
      const lock = await readSemanticTestLock(testLockPath);
      expect(Object.values(lock.entries)[0]).toMatchObject({
        freezeMode: "staged",
        testPlanHash: created.candidate.testPlanHash,
      });
      expect(
        JSON.parse(
          await readFile(
            resolve(created.candidateDirectory, "approval.json"),
            "utf8",
          ),
        ),
      ).toMatchObject({
        candidateId: created.candidate.id,
        reviewer: "staging-user",
      });

      await rm(testLockPath);
      const recovered = await approveSemanticTestReview(
        created.candidate.id,
        {
          reviewer: "ignored-on-replay",
          workspaceRoot,
          reviewRoot,
          testLockPath,
        },
      );
      expect(recovered.status).toBe("already-approved");
      expect(
        Object.values((await readSemanticTestLock(testLockPath)).entries)[0],
      ).toMatchObject({
        freezeMode: "staged",
        frozenAt: approved.approval.approvedAt,
        testPlanHash: created.candidate.testPlanHash,
      });

      const validLockText = await readFile(testLockPath, "utf8");
      const malformedLock = JSON.parse(validLockText) as {
        entries: Record<string, Record<string, unknown>>;
      };
      const malformedEntry = Object.values(malformedLock.entries)[0];
      if (malformedEntry === undefined) {
        throw new Error("expected a Semantic Test lock entry");
      }
      malformedEntry.response = {
        id: "tampered-response",
        model: "fixture-model",
        usage: { unexpected: true },
      };
      await writeFile(
        testLockPath,
        `${JSON.stringify(malformedLock, null, 2)}\n`,
        "utf8",
      );
      await expect(readSemanticTestLock(testLockPath)).rejects.toThrow(
        "response.usage",
      );
      await writeFile(testLockPath, validLockText, "utf8");

      const nonCanonicalLock = JSON.parse(validLockText) as {
        entries: Record<string, Record<string, unknown>>;
      };
      const nonCanonicalEntry = Object.values(nonCanonicalLock.entries)[0];
      if (nonCanonicalEntry === undefined) {
        throw new Error("expected a Semantic Test lock entry");
      }
      nonCanonicalEntry.frozenAt = "2026-07-24T00:00:00Z";
      await writeFile(
        testLockPath,
        `${JSON.stringify(nonCanonicalLock, null, 2)}\n`,
        "utf8",
      );
      await expect(readSemanticTestLock(testLockPath)).rejects.toThrow(
        "canonical ISO timestamp",
      );
      await writeFile(testLockPath, validLockText, "utf8");

      await writeFile(
        sourcePath,
        renderSource(testRoot).replace(
          "enabled is true.",
          "enabled must be true.",
        ),
        "utf8",
      );
      await expect(
        approveSemanticTestReview(created.candidate.id, {
          reviewer: "staging-user",
          workspaceRoot,
          reviewRoot,
          testLockPath,
        }),
      ).rejects.toThrow("stale for the current contract");

      const candidatePath = resolve(
        created.candidateDirectory,
        "candidate.json",
      );
      const candidateDocument = JSON.parse(
        await readFile(candidatePath, "utf8"),
      ) as Record<string, unknown>;
      const outsideSource = resolve(outsideRoot, "outside.ts");
      const linkedSource = resolve(testRoot, "linked.ts");
      await writeFile(outsideSource, "export {};\n", "utf8");
      await symlink(outsideSource, linkedSource);
      candidateDocument.source = relativeWorkspacePath(linkedSource);
      await writeFile(
        candidatePath,
        `${JSON.stringify(candidateDocument, null, 2)}\n`,
        "utf8",
      );
      await expect(
        approveSemanticTestReview(created.candidate.id, {
          reviewer: "staging-user",
          workspaceRoot,
          reviewRoot,
          testLockPath,
        }),
      ).rejects.toThrow("must resolve inside the workspace root");

      candidateDocument.source = "../outside-workspace.ts";
      await writeFile(
        candidatePath,
        `${JSON.stringify(candidateDocument, null, 2)}\n`,
        "utf8",
      );
      await expect(
        approveSemanticTestReview(created.candidate.id, {
          reviewer: "staging-user",
          workspaceRoot,
          reviewRoot,
          testLockPath,
        }),
      ).rejects.toThrow("must resolve inside the workspace root");
    } finally {
      await Promise.all([
        rm(testRoot, { recursive: true, force: true }),
        rm(outsideRoot, { recursive: true, force: true }),
      ]);
    }
  }, 15_000);
});

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function renderSource(root: string): string {
  return `
import {
  concept,
  generatePredicate,
  semanticTest,
} from ${JSON.stringify(resolve(workspaceRoot, "src", "dsl"))};

type ReviewCustomer = {
  enabled: boolean;
};

export const ReviewCustomerConcept = concept<ReviewCustomer>\`
Definition:
A customer that is currently enabled.

Requirements:
- enabled is true.

Exclusions:
- enabled is false.
\`;

export const isReviewCustomer = generatePredicate(ReviewCustomerConcept);

semanticTest(isReviewCustomer, {
  accept: [{ enabled: true }],
  reject: [{ enabled: false }],
});

void ${JSON.stringify(root)};
`;
}

function relativeWorkspacePath(path: string): string {
  return relative(workspaceRoot, path).replaceAll("\\", "/");
}
