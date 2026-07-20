import type { SemanticExplanation } from "./semantic-explain";

export function renderSemanticExplanation(
  explanation: SemanticExplanation,
): string {
  const lines = [
    "semantic explain",
    `status: ${explanation.status}`,
    `kind: ${explanation.kind}`,
    `source: ${explanation.source}`,
  ];

  if (explanation.kind === "predicate") {
    lines.push(
      `predicate: ${explanation.symbol}(${explanation.input.parameterName}: ${explanation.input.typeName})`,
    );
  } else {
    lines.push(`judgment: ${explanation.symbol}`);
  }

  lines.push(
    `concept: ${explanation.concept.id}`,
    `concept source: ${explanation.concept.source}`,
    `concept hash: ${explanation.concept.hash}`,
  );

  if (explanation.kind === "predicate") {
    lines.push(
      `source hash: ${explanation.input.hashes.sourceHash}`,
      `type hash: ${explanation.input.hashes.typeHash}`,
      `semantic test hash: ${explanation.input.hashes.testHash}`,
      `prompt hash: ${explanation.input.hashes.promptHash}`,
    );
  } else {
    lines.push(
      `static value hash: ${explanation.input.hashes.valueHash}`,
      `prompt hash: ${explanation.input.hashes.promptHash}`,
      `result: ${explanation.resolution === null ? "unavailable (no matching lock history)" : explanation.resolution.value}`,
    );
  }

  if (explanation.lock === null) {
    lines.push("lock: none");
  } else {
    lines.push(
      `lock: ${explanation.lock.fingerprint}`,
      `provider/model: ${explanation.lock.provider}/${explanation.lock.model}`,
      `created at: ${explanation.lock.createdAt}`,
      `response: ${explanation.lock.response === null ? "not recorded" : explanation.lock.response.id}`,
    );
  }

  if (explanation.generated === null) {
    lines.push("generated: not checked");
  } else {
    lines.push(
      `generated: ${explanation.generated.path}`,
      `generated integrity: ${renderIntegrity(explanation.generated.state)}`,
      `expected generated hash: ${explanation.generated.expectedHash}`,
      `actual generated hash: ${explanation.generated.actualHash ?? "missing"}`,
    );
  }

  if (explanation.staleReasons.length > 0) {
    lines.push(
      "",
      "stale reasons:",
      ...explanation.staleReasons.map((reason) => `  - ${reason}`),
    );
  }

  if (explanation.kind === "predicate") {
    lines.push("", "resolution:");
    if (explanation.resolution === null) {
      lines.push("  unavailable (no matching lock history)");
    } else {
      lines.push(
        ...explanation.resolution.interpreted
          .split("\n")
          .map((line) => `  ${line}`),
      );
    }
  }

  lines.push(
    "",
    "limitations:",
    ...explanation.limitations.map((limitation) => `  - ${limitation}`),
  );

  return lines.join("\n");
}

function renderIntegrity(
  state: "verified" | "missing" | "mismatch",
): string {
  return state === "verified" ? "verified" : `ERROR (${state})`;
}
