import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

import { compileSemanticContract } from "./semantic-contract";
import { scanSemanticSource } from "./semantic-source";

const example = fileURLToPath(
  new URL("../examples/active-customer/semantic.ts", import.meta.url),
);

describe("semantic contract", () => {
  test("assigns deterministic traceable clause ids and a stable hash", async () => {
    const source = await scanSemanticSource(example);
    const first = compileSemanticContract(source);
    const second = compileSemanticContract(source);

    expect(first).toEqual(second);
    expect(first.contractHash).toMatch(/^[a-f0-9]{64}$/);
    expect(
      first.contract.clauses
        .filter((clause) => clause.normative)
        .map((clause) => clause.id),
    ).toEqual([
      "requirements[0]",
      "requirements[1]",
      "requirements[2]",
      "exclusions[0]",
      "exclusions[1]",
    ]);
    expect(first.contract.clauses[0]).toMatchObject({
      id: "definition",
      normative: false,
    });
  });
});
