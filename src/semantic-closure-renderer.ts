import type { SemanticClosureReport } from "./semantic-closure";

export function renderSemanticClosure(report: SemanticClosureReport): string {
  const lines = [
    "semantic closure",
    `status: ${report.status}`,
    `scope: ${report.scope}`,
    `approval: ${report.approval}`,
    `manifest: ${report.manifest}`,
    `summary: ${report.summary.current}/${report.summary.total} current, ${report.summary.stale} stale, ${report.summary.unlocked} unlocked, ${report.summary.integrityError} integrity-error`,
    "",
    "nodes:",
  ];

  for (const node of report.nodes) {
    lines.push(
      `  - ${node.id} [${node.kind}] ${node.status}`,
      `    source: ${node.source}#${node.symbol}`,
      `    concept: ${node.conceptId}`,
      `    depends on: ${node.dependsOn.length === 0 ? "none" : node.dependsOn.join(", ")}`,
      `    generated: ${node.generated === null ? "not checked" : `${node.generated.path} (${node.generated.state})`}`,
    );
  }

  lines.push("", "blockers:");
  if (report.blockers.length === 0) {
    lines.push("  none");
  } else {
    lines.push(
      ...report.blockers.map(
        (blocker) =>
          `  - ${blocker.nodeId}: ${blocker.code} (${blocker.message})`,
      ),
    );
  }

  lines.push(
    "",
    "limitations:",
    ...report.limitations.map((limitation) => `  - ${limitation}`),
  );
  return lines.join("\n");
}
