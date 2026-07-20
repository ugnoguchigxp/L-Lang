import { validatePredicateContext } from "./context-validator";
import { predicateSemanticSignature } from "./predicate-equivalence";
import type { SemanticResolution } from "./semantic-compiler";
import type { SemanticSource } from "./semantic-source";

export type SemanticConsensusSample = {
  sample: number;
  outcome: "resolved" | "unresolved" | "error";
  eligible: boolean;
  signature: string | null;
  rewrites: string[];
  diagnostics: string[];
  error: string | null;
  resolution: SemanticResolution | null;
};

export type SemanticConsensusResult = {
  resolution: SemanticResolution;
  samples: number;
  quorum: number;
  reached: boolean;
  selectedOutcome: "resolved" | "unresolved" | null;
  selectedSignature: string | null;
  supportingSamples: number[];
  votes: Array<{
    sample: number;
    outcome: SemanticConsensusSample["outcome"];
    eligible: boolean;
    signature: string | null;
    rewrites: string[];
    diagnostics: string[];
    error: string | null;
  }>;
};

export async function resolveWithSemanticConsensus(input: {
  source: SemanticSource;
  samples: number;
  quorum: number;
  resolve: () => Promise<SemanticResolution>;
}): Promise<SemanticConsensusResult> {
  assertConsensusParameters(input.samples, input.quorum);
  const settled = await Promise.all(
    Array.from({ length: input.samples }, (_, index) =>
      resolveSample(index + 1, input.source, input.resolve),
    ),
  );
  const groups = new Map<string, SemanticConsensusSample[]>();
  for (const sample of settled) {
    if (!sample.eligible || sample.signature === null || sample.outcome === "error") continue;
    const key = `${sample.outcome}:${sample.signature}`;
    groups.set(key, [...(groups.get(key) ?? []), sample]);
  }
  const ranked = [...groups.values()].sort((left, right) =>
    right.length - left.length ||
    (left[0]?.signature ?? "").localeCompare(right[0]?.signature ?? ""),
  );
  const winner = ranked[0];
  const tied = winner !== undefined && ranked[1]?.length === winner.length;
  const reached = winner !== undefined && winner.length >= input.quorum && !tied;
  const selected = reached ? winner[0] : undefined;
  const auditVotes = settled.map(({ resolution: _resolution, ...sample }) => sample);
  const rawOutput = {
    method: "type-aware-consensus-v1",
    samples: input.samples,
    quorum: input.quorum,
    reached,
    selectedOutcome: selected?.outcome ?? null,
    selectedSignature: selected?.signature ?? null,
    supportingSamples: reached ? winner.map((sample) => sample.sample) : [],
    votes: auditVotes,
    rawOutputs: settled.map((sample) => ({
      sample: sample.sample,
      output: sample.resolution?.rawOutput ?? null,
    })),
  };
  let resolution: SemanticResolution;
  if (selected === undefined || selected.resolution === null) {
    resolution = unresolvedResolution(
      [`consensus not reached: ${describeGroups(ranked)}; required ${input.quorum}/${input.samples}`],
      rawOutput,
    );
  } else if (selected.outcome === "unresolved") {
    resolution = unresolvedResolution(selected.diagnostics, rawOutput);
  } else {
    resolution = { ...selected.resolution, rawOutput };
  }
  return {
    resolution,
    samples: input.samples,
    quorum: input.quorum,
    reached,
    selectedOutcome: selected?.outcome === "error" ? null : selected?.outcome ?? null,
    selectedSignature: selected?.signature ?? null,
    supportingSamples: reached ? winner.map((sample) => sample.sample) : [],
    votes: auditVotes,
  };
}

export function assertConsensusParameters(samples: number, quorum: number): void {
  if (!Number.isInteger(samples) || samples < 1 || samples > 9) {
    throw new Error("consensus samples must be an integer between 1 and 9");
  }
  if (!Number.isInteger(quorum) || quorum < 1 || quorum > samples) {
    throw new Error("consensus quorum must be an integer between 1 and samples");
  }
  if (samples > 1 && quorum <= samples / 2) {
    throw new Error("consensus quorum must be a strict majority");
  }
}

async function resolveSample(
  sample: number,
  source: SemanticSource,
  resolve: () => Promise<SemanticResolution>,
): Promise<SemanticConsensusSample> {
  try {
    const resolution = await resolve();
    if (resolution.elaboration.outcome === "unresolved") {
      return {
        sample,
        outcome: "unresolved",
        eligible: true,
        signature: "unresolved",
        rewrites: [],
        diagnostics: resolution.elaboration.diagnostics,
        error: null,
        resolution,
      };
    }
    validatePredicateContext(resolution.elaboration.body, source);
    const semantic = predicateSemanticSignature(
      resolution.elaboration.body,
      source.concept.typeSchema,
    );
    return {
      sample,
      outcome: "resolved",
      eligible: true,
      signature: semantic.signature,
      rewrites: semantic.rewrites,
      diagnostics: resolution.elaboration.diagnostics,
      error: null,
      resolution,
    };
  } catch (error) {
    return {
      sample,
      outcome: "error",
      eligible: false,
      signature: null,
      rewrites: [],
      diagnostics: [],
      error: error instanceof Error ? error.message : String(error),
      resolution: null,
    };
  }
}

function unresolvedResolution(
  diagnostics: string[],
  rawOutput: unknown,
): SemanticResolution {
  return {
    elaboration: { outcome: "unresolved", body: null, diagnostics },
    response: null,
    rawOutput,
  };
}

function describeGroups(groups: SemanticConsensusSample[][]): string {
  if (groups.length === 0) return "no eligible votes";
  return groups
    .map((group) => `${group[0]?.outcome ?? "unknown"}=${group.length}`)
    .join(", ");
}
