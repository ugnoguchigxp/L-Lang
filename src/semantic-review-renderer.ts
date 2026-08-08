import type { PredicateExpression } from "./ir";
import { classifySemanticChange, renderSemanticDiff } from "./semantic-diff";
import type { TypeSchema } from "./semantic-source";

export function renderPredicateReviewDiff(input: {
  previous: PredicateExpression | null;
  candidate: PredicateExpression;
  typeSchema: TypeSchema;
}): string {
  if (input.previous === null) {
    return [
      "NEW PREDICATE",
      "",
      JSON.stringify(input.candidate, null, 2),
      "",
    ].join("\n");
  }

  return renderSemanticDiff(
    classifySemanticChange({
      previous: input.previous,
      candidate: input.candidate,
      diagnostics: [],
      validationPassed: true,
      validationError: null,
      typeSchema: input.typeSchema,
    }),
  );
}

export function renderStaticJudgmentReviewDiff(input: {
  previous: boolean | null;
  candidate: boolean;
}): string {
  if (input.previous === null) {
    return `NEW STATIC JUDGMENT\n\nafter: ${input.candidate}\n`;
  }
  return `before: ${input.previous}\nafter: ${input.candidate}\n`;
}
