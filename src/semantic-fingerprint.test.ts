import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import {
  fingerprintFor,
  generatedOutputPath,
  predicateSemanticHashes,
  staticJudgmentSemanticHashes,
  workspaceRelativePath,
} from "./semantic-fingerprint";
import { scanSemanticSource } from "./semantic-source";
import { scanStaticJudgmentSource } from "./static-judgment-source";

describe("semantic fingerprint", () => {
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
      sourceHash: "cce3e4996f4c934b7b3e7ae24a4fdb09591ced2ea73415b5876d47209e380a50",
      typeHash: "e7548c874bb83c456c7e19013acac574381d20744e1602f717e96405c1184e47",
      testHash: "a657838b34667dfd72900d66c36cd158f00712b58441c0f27d244ffa664a4a37",
      promptHash: "cce0bcf759af5f2b723e41e99b865c02e5c30c441a812c8cf6f53dbe31971ed0",
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
    ).toBe("ad3051010aae2dd7ae17a87cb1347e77891ce6b4ab2b0ce56534cde9edd63359");
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
