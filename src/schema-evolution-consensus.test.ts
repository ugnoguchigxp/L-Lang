import { describe, expect, test } from "bun:test";

import { selectConsensusVotes } from "./schema-evolution-consensus";

describe("schema evolution consensus", () => {
  test("selects a two-of-three resolved semantic group", () => {
    const result = selectConsensusVotes([
      { trial: 1, outcome: "resolved", eligible: true, signature: "same" },
      { trial: 2, outcome: "unresolved", eligible: true, signature: "unresolved" },
      { trial: 3, outcome: "resolved", eligible: true, signature: "same" },
    ]);
    expect(result).toMatchObject({
      reached: true,
      selectedOutcome: "resolved",
      selectedSignature: "same",
      supportingTrials: [1, 3],
    });
  });

  test("selects unresolved only when it has quorum", () => {
    const result = selectConsensusVotes([
      { trial: 1, outcome: "unresolved", eligible: true, signature: "unresolved" },
      { trial: 2, outcome: "resolved", eligible: true, signature: "candidate" },
      { trial: 3, outcome: "unresolved", eligible: true, signature: "unresolved" },
    ]);
    expect(result.selectedOutcome).toBe("unresolved");
    expect(result.supportingTrials).toEqual([1, 3]);
  });

  test("does not select without quorum", () => {
    const result = selectConsensusVotes([
      { trial: 1, outcome: "resolved", eligible: true, signature: "a" },
      { trial: 2, outcome: "resolved", eligible: true, signature: "b" },
      { trial: 3, outcome: "error", eligible: false, signature: null },
    ]);
    expect(result.reached).toBe(false);
    expect(result.selectedOutcome).toBeNull();
  });

  test("excludes candidates that failed local validation", () => {
    const result = selectConsensusVotes([
      { trial: 1, outcome: "resolved", eligible: false, signature: "same" },
      { trial: 2, outcome: "resolved", eligible: true, signature: "same" },
      { trial: 3, outcome: "unresolved", eligible: true, signature: "unresolved" },
    ]);
    expect(result.reached).toBe(false);
  });
});
