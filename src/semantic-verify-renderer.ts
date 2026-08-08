import type { SemanticVerifyReport } from "./semantic-verify";

export function renderSemanticVerify(report: SemanticVerifyReport): string {
  const lines = [
    "semantic verify",
    `status: ${report.status}`,
    `manifest: ${report.manifest}`,
    `closure: ${report.checks.closure.status}`,
    `deterministic generation: ${summary(report.checks.deterministicGeneration)}`,
    `semantic tests: ${summary(report.checks.semanticTests)}`,
    `typecheck: ${report.checks.typecheck.status}`,
    `duration ms: ${report.durationMs}`,
  ];

  const diagnostics: Array<{
    id: string;
    status: string;
    diagnostic: string;
  }> = [
    ...report.closure.blockers.map((blocker) => ({
      id: blocker.nodeId,
      status: blocker.code,
      diagnostic: blocker.message,
    })),
    ...report.checks.deterministicGeneration.nodes.flatMap((node) =>
      node.status !== "failed" || node.diagnostic === null
        ? []
        : [{ id: node.id, status: node.status, diagnostic: node.diagnostic }],
    ),
    ...report.checks.semanticTests.nodes.flatMap((node) =>
      node.status !== "failed" || node.diagnostic === null
        ? []
        : [{ id: node.id, status: node.status, diagnostic: node.diagnostic }],
    ),
  ];
  if (report.checks.typecheck.diagnostic !== null) {
    diagnostics.push({
      id: "typecheck",
      status: "failed",
      diagnostic: report.checks.typecheck.diagnostic,
    });
  }

  lines.push("", "diagnostics:");
  if (diagnostics.length === 0) {
    lines.push("  none");
  } else {
    lines.push(
      ...diagnostics.map(
        (item) => `  - ${item.id}: ${item.status} (${item.diagnostic})`,
      ),
    );
  }
  lines.push("", "remediation:");
  if (report.remediation.length === 0) {
    lines.push("  none");
  } else {
    lines.push(...report.remediation.map((item) => `  - ${item}`));
  }
  lines.push("", "api calls: 0", "persistent files written: 0");
  return lines.join("\n");
}

function summary(input: {
  status: string;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
}): string {
  return `${input.status} (${input.passed}/${input.total} passed, ${input.failed} failed, ${input.skipped} skipped)`;
}
