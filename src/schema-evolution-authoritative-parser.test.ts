import { beforeAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { parseSchemaEvolutionAuthoritativeManifest } from "./schema-evolution-authoritative-parser";

let fixture: Record<string, unknown>;

beforeAll(async () => {
  fixture = JSON.parse(
    await readFile(
      resolve("benchmarks/schema-evolution/benchmark.json"),
      "utf8",
    ),
  ) as Record<string, unknown>;
});

describe("authoritative schema evolution parser", () => {
  test("parses the complete protected manifest", () => {
    expect(parseSchemaEvolutionAuthoritativeManifest(fixture)).toMatchObject({
      version: 2,
      trials: 3,
      concepts: expect.arrayContaining([
        expect.objectContaining({
          id: "benchmark.ticket.actionable",
          exportName: "ActionableTicket",
        }),
      ]),
    });
  });

  test("rejects malformed top-level and nested fields", () => {
    const cases: Array<{
      mutate: (manifest: Record<string, unknown>) => void;
      message: string;
    }> = [
      {
        mutate: (manifest) => {
          manifest.unexpected = true;
        },
        message: "contains unknown field unexpected",
      },
      {
        mutate: (manifest) => {
          (
            manifest.thresholds as Record<string, unknown>
          ).minimumConsensusCaseRate = Number.NaN;
        },
        message:
          "minimumConsensusCaseRate must be a finite number between 0 and 1",
      },
      {
        mutate: (manifest) => {
          delete firstCases(manifest).ambiguity;
        },
        message: "cases is missing ambiguity",
      },
      {
        mutate: (manifest) => {
          firstField(manifest).path = [".."];
        },
        message: "path[0] must be a TypeScript identifier",
      },
      {
        mutate: (manifest) => {
          const field = firstField(manifest);
          delete field.negative;
        },
        message: "condition requires negative",
      },
      {
        mutate: (manifest) => {
          firstField(manifest).optional = "yes";
        },
        message: "optional must be a boolean",
      },
      {
        mutate: (manifest) => {
          const baseline = firstBaseline(manifest);
          const fields = baseline.fields as Array<Record<string, unknown>>;
          const first = fields[0];
          if (first === undefined) throw new Error("fixture field is missing");
          fields.push(structuredClone(first));
        },
        message: "field paths must be unique",
      },
    ];

    for (const testCase of cases) {
      const manifest = structuredClone(fixture);
      testCase.mutate(manifest);
      expect(() => parseSchemaEvolutionAuthoritativeManifest(manifest)).toThrow(
        testCase.message,
      );
    }
  });
});

function firstConcept(
  manifest: Record<string, unknown>,
): Record<string, unknown> {
  const concept = (manifest.concepts as Array<Record<string, unknown>>)[0];
  if (concept === undefined) throw new Error("fixture concept is missing");
  return concept;
}

function firstCases(
  manifest: Record<string, unknown>,
): Record<string, unknown> {
  return firstConcept(manifest).cases as Record<string, unknown>;
}

function firstBaseline(
  manifest: Record<string, unknown>,
): Record<string, unknown> {
  return firstConcept(manifest).baseline as Record<string, unknown>;
}

function firstField(
  manifest: Record<string, unknown>,
): Record<string, unknown> {
  const field = (
    firstBaseline(manifest).fields as Array<Record<string, unknown>>
  )[0];
  if (field === undefined) throw new Error("fixture field is missing");
  return field;
}
