import {
  parseCanonicalPredicateType,
  type CanonicalPredicateField,
  type CanonicalPredicateType,
} from "./canonical-type-ir";
import type { JsonSchemaProjection } from "./canonical-type-json-schema";
import type { PredicateExpression } from "./ir";
import { renderInterpretedJudgement } from "./judgement-renderer";
import { sha256 } from "./stable-hash";

export const HYBRID_SPECIFICATION_RENDERER = "hybrid-specification-v1" as const;

export type ImplementationSpecificationProjection = {
  version: 1;
  renderer: typeof HYBRID_SPECIFICATION_RENDERER;
  format: "markdown";
  status: "implementation-description";
  content: string;
  hash: string;
};

export function renderImplementationSpecification(input: {
  functionName: string;
  parameterName: string;
  canonicalType: CanonicalPredicateType;
  expression: PredicateExpression;
  jsonSchema: JsonSchemaProjection;
}): ImplementationSpecificationProjection {
  const type = parseCanonicalPredicateType(input.canonicalType);
  const diagnostics =
    input.jsonSchema.diagnostics.length === 0
      ? ["- None"]
      : input.jsonSchema.diagnostics.map(
          (diagnostic) =>
            `- \`${diagnostic.code}\` at \`${diagnostic.path.join(".")}\`: ${diagnostic.message}`,
        );
  const content = [
    `# Implementation-derived specification: ${input.functionName}`,
    "",
    `- Renderer: \`${HYBRID_SPECIFICATION_RENDERER}\``,
    `- Input parameter: \`${input.parameterName}\``,
    `- JSON Schema mapping: \`${input.jsonSchema.status}\``,
    "",
    "> This document mechanically describes the inspected implementation. It does not prove that the implementation matches the intended business requirements.",
    "",
    "## Input contract",
    "",
    "| Field | Value | Presence | Null | Undefined |",
    "| --- | --- | --- | --- | --- |",
    ...type.fields.map(renderField),
    "",
    "## Decision",
    "",
    "```text",
    renderInterpretedJudgement({
      predicateName: input.functionName,
      parameterName: input.parameterName,
      expression: input.expression,
    }),
    "```",
    "",
    "## Projection diagnostics",
    "",
    ...diagnostics,
    "",
    "## Limitation",
    "",
    "This projection contains no inferred intent, requirement IDs, acceptance decision, or domain-correctness claim.",
    "",
  ].join("\n");
  return {
    version: 1,
    renderer: HYBRID_SPECIFICATION_RENDERER,
    format: "markdown",
    status: "implementation-description",
    content,
    hash: sha256(content),
  };
}

function renderField(field: CanonicalPredicateField): string {
  return [
    escapeCell(field.name),
    escapeCell(renderValue(field)),
    field.presence,
    field.nullability === "nullable" ? "allowed" : "forbidden",
    field.undefinedValue,
  ]
    .map((value) => ` ${value} `)
    .join("|")
    .replace(/^/, "|")
    .replace(/$/, "|");
}

function renderValue(field: CanonicalPredicateField): string {
  switch (field.value.kind) {
    case "boolean":
      return "boolean";
    case "open-string":
      return `string (${field.value.encoding})`;
    case "closed-string-enum":
      return `enum ${field.value.values.map((value) => JSON.stringify(value)).join(", ")}`;
  }
}

function escapeCell(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("|", "\\|")
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r");
}
