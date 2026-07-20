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
      conceptHash: "95d3fc327cf4abfd77643df0b5aa2fa61d735bd08403c2f48bae2b34d1a6c392",
      sourceHash: "e38b866499af9131eb0d12bb1b130ddc420f246f9c3964caf7df8e2a104ac031",
      typeHash: "e7548c874bb83c456c7e19013acac574381d20744e1602f717e96405c1184e47",
      testHash: "a657838b34667dfd72900d66c36cd158f00712b58441c0f27d244ffa664a4a37",
      promptHash: "abf1e29957315be4e02e14f85b07fe85d4a55d03dd250338be446e6838ca1016",
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
    ).toBe("c110b425bff1621247dc4a2304070410c3eb022018f9f253e518edb8f2cb7535");
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
      conceptHash: "a3eea5326ee057140772139a5d1cc41a4c3271b81f0c840ed4e3f62c30ff6405",
      valueHash: "3da60d12ec57478f33a58a2ec8628c5e29c43e90c1033d09ec4307917c043e48",
      promptHash: "6cb7df03060158ab3cf63794f7826964190e3d37e3b375d1aad0216a1ce49796",
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
    ).toBe("f87f36422a1f305662b344957f088bda49ac98605559c0ae15722001a8a6ff82");
  });
});
