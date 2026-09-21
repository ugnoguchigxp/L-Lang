import binaryen from "binaryen";
import type { CheckedCollectionProgram } from "./llang-module-collection-ir";
import { sha256, stableJson } from "./stable-hash";

export type CollectionBottleneckStaticMetrics = Readonly<{
  functionCount: number;
  statementCount: number;
  expressionCount: number;
  loopCount: number;
  callCount: number;
  intrinsicCount: number;
  closureCount: number;
  genericInstanceCount: number;
  watFunctionCount: number;
  watBlockCount: number;
  watLoopCount: number;
  watCallCount: number;
  watLoadCount: number;
  watStoreCount: number;
  watCopyCallCount: number;
  watAllocationCallCount: number;
  watValidationCallCount: number;
  watInstructionCount: number;
}>;

const increment = (value: Record<string, number>, key: string) => {
  value[key] = (value[key] ?? 0) + 1;
};

export function projectCollectionBottleneckMetrics(
  program: CheckedCollectionProgram,
  wat: string,
): Readonly<{
  metrics: CollectionBottleneckStaticMetrics;
  metricsHash: string;
}> {
  if (!wat.startsWith("(module") || !wat.includes('(export "evaluate"'))
    throw new Error("COLLECTION_BOTTLENECK_METRICS: invalid WAT");
  let parsed: binaryen.Module | undefined;
  try {
    parsed = binaryen.parseText(wat);
    if (!parsed.validate())
      throw new Error("COLLECTION_BOTTLENECK_METRICS: invalid WAT");
  } catch {
    throw new Error("COLLECTION_BOTTLENECK_METRICS: invalid WAT");
  } finally {
    parsed?.dispose();
  }
  const counts: Record<string, number> = {};
  const visit = (candidate: unknown): void => {
    if (!candidate || typeof candidate !== "object") return;
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item);
      return;
    }
    const value = candidate as Record<string, unknown>;
    if (typeof value.kind === "string") {
      if (
        [
          "const",
          "let",
          "assign",
          "while",
          "forEach",
          "match",
          "break",
          "continue",
          "return",
        ].includes(value.kind) ||
        (value.kind === "if" && ("whenTrue" in value || "whenFalse" in value))
      )
        increment(counts, "statement");
      else increment(counts, "expression");
      if (value.kind === "while" || value.kind === "forEach")
        increment(counts, "loop");
      if (value.kind === "call" || value.kind === "invoke")
        increment(counts, "call");
      if (value.kind === "intrinsic") increment(counts, "intrinsic");
      if (value.kind === "lambda") increment(counts, "closure");
    }
    for (const child of Object.values(value)) visit(child);
  };
  for (const fn of program.functions) visit(fn.body);
  const matches = (pattern: RegExp) => wat.match(pattern)?.length ?? 0,
    instructionPattern =
      /\b(?:call|drop|select|return|unreachable|br|br_if|local\.(?:get|set|tee)|global\.(?:get|set)|memory\.(?:copy|fill|size|grow)|i32\.(?:const|add|sub|mul|div_s|rem_s|and|or|xor|shl|shr_s|eq|ne|lt_s|lt_u|le_s|le_u|gt_s|gt_u|ge_s|ge_u|eqz|load(?:8_u)?|store(?:8)?))\b/gu,
    metrics = Object.freeze({
      functionCount: program.functions.length,
      statementCount: counts.statement ?? 0,
      expressionCount: counts.expression ?? 0,
      loopCount: counts.loop ?? 0,
      callCount: counts.call ?? 0,
      intrinsicCount: counts.intrinsic ?? 0,
      closureCount: counts.closure ?? 0,
      genericInstanceCount: program.instances.length,
      watFunctionCount: matches(/\(func\b/gu),
      watBlockCount: matches(/\b(?:block|if|loop)\b/gu),
      watLoopCount: matches(/\bloop\b/gu),
      watCallCount: matches(/\bcall\b/gu),
      watLoadCount: matches(/\bi32\.load(?:8_u)?\b/gu),
      watStoreCount: matches(/\bi32\.store(?:8)?\b/gu),
      watCopyCallCount: matches(/call \$copyBytes\b/gu),
      watAllocationCallCount: matches(/call \$alloc(?:Array)?\b/gu),
      watValidationCallCount: matches(/call \$validate[0-9]+\b/gu),
      watInstructionCount: matches(instructionPattern),
    });
  if (
    metrics.functionCount < 1 ||
    metrics.expressionCount < 1 ||
    metrics.watFunctionCount < 1 ||
    metrics.watInstructionCount < 1
  )
    throw new Error("COLLECTION_BOTTLENECK_METRICS: incomplete projection");
  return Object.freeze({ metrics, metricsHash: sha256(stableJson(metrics)) });
}
