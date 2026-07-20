import type { Literal, PredicateExpression } from "./ir";
import { normalizePredicateOnType } from "./predicate-equivalence";
import type { TypeSchema } from "./semantic-source";

export type SemanticChangeClassification =
  | "compatible"
  | "breaking"
  | "unresolved";

export type SemanticLeafChange = {
  before: {
    kind: "equals" | "present";
    property: string[];
    value?: Literal;
  } | null;
  after: {
    kind: "equals" | "present";
    property: string[];
    value?: Literal;
  } | null;
  changes: Array<"operator" | "property" | "value" | "added" | "removed">;
};

export type SemanticDiff = {
  classification: SemanticChangeClassification;
  summary: string;
  previousIr: PredicateExpression;
  candidateIr: PredicateExpression | null;
  logicalShapeChanged: boolean;
  leafChanges: SemanticLeafChange[];
  diagnostics: string[];
};

export function classifySemanticChange(input: {
  previous: PredicateExpression;
  candidate: PredicateExpression | null;
  diagnostics?: string[];
  validationPassed?: boolean;
  validationError?: string | null;
  typeSchema?: TypeSchema;
}): SemanticDiff {
  const previousForShape = input.typeSchema
    ? normalizePredicateOnType(input.previous, input.typeSchema)
    : { expression: input.previous, rewrites: [] };
  const candidateForShape = input.candidate !== null && input.typeSchema
    ? normalizePredicateOnType(input.candidate, input.typeSchema)
    : { expression: input.candidate, rewrites: [] };
  const diagnostics = [
    ...(input.diagnostics ?? []),
    ...(input.validationError ? [input.validationError] : []),
    ...previousForShape.rewrites,
    ...candidateForShape.rewrites,
  ];
  if (input.candidate === null) {
    return {
      classification: "unresolved",
      summary: "The changed schema no longer represents every required semantic role unambiguously.",
      previousIr: input.previous,
      candidateIr: null,
      logicalShapeChanged: true,
      leafChanges: compareLeaves(input.previous, null),
      diagnostics,
    };
  }

  const previousSignature = expressionSignature(input.previous);
  const candidateSignature = expressionSignature(input.candidate);
  const logicalShapeChanged =
    logicalShapeSignature(previousForShape.expression) !==
    logicalShapeSignature(candidateForShape.expression!);
  const validationPassed = input.validationPassed ?? true;
  const classification =
    validationPassed && !logicalShapeChanged ? "compatible" : "breaking";
  const summary = !validationPassed
    ? "The candidate failed local type or semantic validation."
    : previousSignature === candidateSignature
      ? "The Predicate IR is unchanged."
      : logicalShapeChanged
        ? "The predicate's logical structure changed and requires explicit review."
        : "The logical structure is preserved; property or representation mappings changed."

  return {
    classification,
    summary,
    previousIr: input.previous,
    candidateIr: input.candidate,
    logicalShapeChanged,
    leafChanges: compareLeaves(
      previousForShape.expression,
      candidateForShape.expression,
    ),
    diagnostics,
  };
}

export function renderSemanticDiff(diff: SemanticDiff): string {
  const lines = [
    `Semantic change: ${diff.classification.toUpperCase()}`,
    "",
    diff.summary,
  ];
  for (const [index, change] of diff.leafChanges.entries()) {
    if (change.changes.length === 0) continue;
    lines.push(
      "",
      `condition ${index + 1}: ${change.changes.join(", ")}`,
      `  before: ${renderLeaf(change.before)}`,
      `  after:  ${renderLeaf(change.after)}`,
    );
  }
  if (diff.diagnostics.length > 0) {
    lines.push("", "diagnostics:");
    for (const diagnostic of diff.diagnostics) lines.push(`  - ${diagnostic}`);
  }
  return `${lines.join("\n")}\n`;
}

function compareLeaves(
  previous: PredicateExpression,
  candidate: PredicateExpression | null,
): SemanticLeafChange[] {
  const before = flattenLeaves(previous);
  const after = candidate === null ? [] : flattenLeaves(candidate);
  const pairs = alignLeaves(before, after);
  const changes: SemanticLeafChange[] = [];
  for (const [left, right] of pairs) {
    const kinds: SemanticLeafChange["changes"] = [];
    if (left === null) kinds.push("added");
    else if (right === null) kinds.push("removed");
    else {
      if (left.kind !== right.kind) kinds.push("operator");
      if (left.property.join(".") !== right.property.join(".")) {
        kinds.push("property");
      }
      if (
        left.kind === "equals" &&
        right.kind === "equals" &&
        !Object.is(left.value, right.value)
      ) {
        kinds.push("value");
      }
    }
    changes.push({ before: left, after: right, changes: kinds });
  }
  return changes;
}

type Leaf = Exclude<SemanticLeafChange["before"], null>;

function flattenLeaves(expression: PredicateExpression): Leaf[] {
  switch (expression.kind) {
    case "all":
    case "any":
      return expression.conditions.flatMap(flattenLeaves);
    case "not":
      return flattenLeaves(expression.condition);
    case "equals":
      return [{ kind: "equals", property: expression.property, value: expression.value }];
    case "present":
      return [{ kind: "present", property: expression.property }];
  }
}

function logicalShapeSignature(expression: PredicateExpression): string {
  switch (expression.kind) {
    case "all":
    case "any":
      return `${expression.kind}(${expression.conditions
        .map(logicalShapeSignature)
        .sort()
        .join(",")})`;
    case "not":
      return `not(${logicalShapeSignature(expression.condition)})`;
    case "equals":
      return "equals";
    case "present":
      return "present";
  }
}

function expressionSignature(expression: PredicateExpression): string {
  switch (expression.kind) {
    case "all":
    case "any":
      return `${expression.kind}(${expression.conditions
        .map(expressionSignature)
        .sort()
        .join(",")})`;
    case "not":
      return `not(${expressionSignature(expression.condition)})`;
    case "equals":
      return `equals(${expression.property.join(".")},${JSON.stringify(expression.value)})`;
    case "present":
      return `present(${expression.property.join(".")})`;
  }
}

function alignLeaves(before: Leaf[], after: Leaf[]): Array<[Leaf | null, Leaf | null]> {
  const remainingBefore = before.map((leaf, index) => ({ leaf, index }));
  const remainingAfter = after.map((leaf, index) => ({ leaf, index }));
  const matched: Array<{ before: Leaf; after: Leaf; beforeIndex: number }> = [];
  while (remainingBefore.length > 0 && remainingAfter.length > 0) {
    let bestLeft = 0;
    let bestRight = 0;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (const [leftIndex, left] of remainingBefore.entries()) {
      for (const [rightIndex, right] of remainingAfter.entries()) {
        const score = leafSimilarity(left.leaf, right.leaf);
        if (score > bestScore) {
          bestLeft = leftIndex;
          bestRight = rightIndex;
          bestScore = score;
        }
      }
    }
    const [left] = remainingBefore.splice(bestLeft, 1);
    const [right] = remainingAfter.splice(bestRight, 1);
    matched.push({
      before: left!.leaf,
      after: right!.leaf,
      beforeIndex: left!.index,
    });
  }
  matched.sort((left, right) => left.beforeIndex - right.beforeIndex);
  return [
    ...matched.map(({ before: left, after: right }) => [left, right] as [Leaf, Leaf]),
    ...remainingBefore
      .sort((left, right) => left.index - right.index)
      .map(({ leaf }) => [leaf, null] as [Leaf, null]),
    ...remainingAfter
      .sort((left, right) => left.index - right.index)
      .map(({ leaf }) => [null, leaf] as [null, Leaf]),
  ];
}

function leafSimilarity(left: Leaf, right: Leaf): number {
  let score = left.kind === right.kind ? 20 : 0;
  if (left.property.join(".") === right.property.join(".")) score += 60;
  if (
    left.kind === "equals" &&
    right.kind === "equals" &&
    Object.is(left.value, right.value)
  ) {
    score += 40;
  }
  return score;
}

function renderLeaf(leaf: Leaf | null): string {
  if (leaf === null) return "(none)";
  return leaf.kind === "equals"
    ? `${leaf.property.join(".")} EQUALS ${JSON.stringify(leaf.value)}`
    : `${leaf.property.join(".")} IS PRESENT`;
}
