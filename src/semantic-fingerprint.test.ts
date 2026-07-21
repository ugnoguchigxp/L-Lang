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
      conceptHash: "521d6202119acba1db62dab0121e1c9bec1db626e5132ac76137c1a0db408012",
      valueHash: "3da60d12ec57478f33a58a2ec8628c5e29c43e90c1033d09ec4307917c043e48",
      promptHash: "a828d8fb34ab433442cebd1f6cdb5ef8943c5fe9274cbc7cdff0cccedff839bc",
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
    ).toBe("cc3d387fa887bdfea813a168e64c6a7f832faa5a6503181168c23dcee1eead94");
  });
});
