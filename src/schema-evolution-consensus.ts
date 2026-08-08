export type ConsensusVote = {
  trial: number;
  outcome: "resolved" | "unresolved" | "error";
  eligible: boolean;
  signature: string | null;
};

export type ConsensusSelection = {
  reached: boolean;
  quorum: number;
  selectedOutcome: "resolved" | "unresolved" | null;
  selectedSignature: string | null;
  supportingTrials: number[];
  groups: Array<{
    outcome: "resolved" | "unresolved";
    signature: string;
    trials: number[];
    count: number;
  }>;
};

export function selectConsensusVotes(
  votes: ConsensusVote[],
  quorum = 2,
): ConsensusSelection {
  const groups = new Map<
    string,
    {
      outcome: "resolved" | "unresolved";
      signature: string;
      trials: number[];
    }
  >();
  for (const vote of votes) {
    if (!vote.eligible || vote.outcome === "error" || vote.signature === null) {
      continue;
    }
    const key = `${vote.outcome}:${vote.signature}`;
    const group = groups.get(key) ?? {
      outcome: vote.outcome,
      signature: vote.signature,
      trials: [],
    };
    group.trials.push(vote.trial);
    groups.set(key, group);
  }
  const ranked = [...groups.values()]
    .map((group) => ({ ...group, count: group.trials.length }))
    .sort(
      (left, right) =>
        right.count - left.count ||
        left.signature.localeCompare(right.signature),
    );
  const winner = ranked[0];
  const tied = winner !== undefined && ranked[1]?.count === winner.count;
  const reached =
    winner !== undefined && winner.count >= quorum && tied === false;
  return {
    reached,
    quorum,
    selectedOutcome: reached ? winner.outcome : null,
    selectedSignature: reached ? winner.signature : null,
    supportingTrials: reached ? [...winner.trials] : [],
    groups: ranked,
  };
}
