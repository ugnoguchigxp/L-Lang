import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import {
  fingerprintFor,
  generatedOutputPath,
  predicateSemanticHashes,
  resolveWorkspacePath,
  staticJudgmentSemanticHashes,
  workspaceRelativePath,
} from "./semantic-fingerprint";
import { scanSemanticSource } from "./semantic-source";
import { scanStaticJudgmentSource } from "./static-judgment-source";

describe("semantic fingerprint", () => {
  test("resolves relative paths from the workspace and rejects escapes", () => {
    const workspaceRoot = resolve("fixtures/workspace");
    expect(
      resolveWorkspacePath(
        workspaceRoot,
        "nested/source.ts",
        "semantic source",
      ),
    ).toBe(resolve(workspaceRoot, "nested/source.ts"));
    expect(() =>
      resolveWorkspacePath(workspaceRoot, "../outside.ts", "semantic source"),
    ).toThrow("semantic source must be inside the workspace root");
  });

  test("preserves the Predicate lock hashes and fingerprint", async () => {
    const workspaceRoot = process.cwd();
    const source = await scanSemanticSource(
      resolve(workspaceRoot, "examples/active-customer/semantic.ts"),
    );
    const hashes = predicateSemanticHashes(source);
    const sourcePath = workspaceRelativePath(
      workspaceRoot,
      source.absolutePath,
      "semantic source",
    );

    expect(hashes).toEqual({
      conceptHash: "f37a8bb48560ef60dff868a7ceda3cdbdee4b5de370f625af021b9b1128821bf",
      sourceHash: "4a08e9aa1846ba353ca32c4a4664a2a1e07001ad648928a043c59fd41e95f5f8",
      typeHash: "e7548c874bb83c456c7e19013acac574381d20744e1602f717e96405c1184e47",
      testHash: "1c93ebef274be501ddf935edf52151d16402d630b2ec0b0104cdcd2b10f2f326",
      promptHash: "4de2a24673da9a4513cd784dae2cee172cfa26515c2a1b0ea60a3a3e679beb2b",
      contextVersion: 1,
      contextHash: "0c1da50c727b7e9825244775e88c1c6ba53a17dbf0be374fa4ea662569996ca7",
    });
    expect(
      fingerprintFor({
        source: sourcePath,
        predicate: source.predicate.name,
        conceptId: source.concept.id,
        provider: "fixture:openai-response.fixture.json",
        model: "gpt-5.4-mini",
        ...hashes,
      }),
    ).toBe("a1101691af914a95f6fc596167ff7dc072b2cc07b1cdaacc53a73f93d3ec3d13");
    expect(
      workspaceRelativePath(
        workspaceRoot,
        generatedOutputPath(source.absolutePath, source.predicate.name),
        "generated output",
      ),
    ).toBe("examples/active-customer/is-active-customer.generated.ts");
  });

  test("preserves the Static Judgment lock hashes and fingerprint", async () => {
    const workspaceRoot = process.cwd();
    const source = await scanStaticJudgmentSource(
      resolve(workspaceRoot, "examples/static-judgment/semantic.ts"),
    );
    const hashes = staticJudgmentSemanticHashes(source);

    expect(hashes).toEqual({
      conceptHash: "ffc5d7954cd26d4c0a5a9454cdc79ccb3683688ae3f8506c5e291c68bac386ae",
      valueHash: "3da60d12ec57478f33a58a2ec8628c5e29c43e90c1033d09ec4307917c043e48",
      promptHash: "0f828dbbbcb3e457b2e2f7dc845cfeddf5fcad19ca62e2d0dba5d7433c361c6b",
    });
    expect(
      fingerprintFor({
        source: "examples/static-judgment/semantic.ts",
        judgment: source.judgment.name,
        conceptId: source.concept.id,
        provider: "fixture:openai-response.true.fixture.json",
        model: "gpt-5.4-mini",
        ...hashes,
      }),
    ).toBe("75f5c33a0bb8bb8a9c9754a355f0d7b877f9b148289b9e5c5f77c9a217769b17");
  });
});
