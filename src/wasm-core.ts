import { parsePredicateExpression } from "./ir";
import {
  parseCanonicalPredicateType,
  type CanonicalPredicateType,
} from "./canonical-type-ir";
import type { TypeSchema } from "./semantic-source";
import {
  contractSlots,
  parseContract,
  type WasmContract,
  WasmError,
  type WasmField,
} from "./wasm-contract";

export type WasmCore =
  | { kind: "constant"; value: boolean }
  | { kind: "compare"; slot: number; value: number }
  | { kind: "not"; body: WasmCore }
  | { kind: "all" | "any"; bodies: WasmCore[] };

export function contractFromType(schema: TypeSchema): WasmContract {
  if (schema.kind !== "object")
    throw new WasmError("UNSUPPORTED_TYPE", "expected top-level record");
  const fields = schema.properties
    .map((p): WasmField => {
      const parts = p.type.kind === "union" ? p.type.types : [p.type];
      const actual = parts.filter(
        (t) => t.kind !== "null" && t.kind !== "undefined",
      );
      let kind: WasmField["kind"];
      let values: string[] = [];
      if (actual.length === 1 && actual[0]?.kind === "boolean")
        kind = "boolean";
      else if (
        actual.length === 2 &&
        actual.every(
          (t) => t.kind === "literal" && typeof t.value === "boolean",
        ) &&
        new Set(actual.map((t) => (t.kind === "literal" ? t.value : null)))
          .size === 2
      )
        kind = "boolean";
      else if (actual.length === 1 && actual[0]?.kind === "string")
        kind = "string";
      else if (
        actual.length &&
        actual.every((t) => t.kind === "literal" && typeof t.value === "string")
      ) {
        kind = "enum";
        values = actual
          .map((t) => (t.kind === "literal" ? String(t.value) : ""))
          .sort();
      } else
        throw new WasmError("UNSUPPORTED_TYPE", `unsupported field ${p.name}`);
      return {
        name: p.name,
        kind,
        values,
        nullable: parts.some((t) => t.kind === "null"),
        undefinable: parts.some((t) => t.kind === "undefined"),
        optional: p.optional,
      };
    })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return parseContract({ version: 1, fields });
}

export function contractFromCanonicalType(
  input: CanonicalPredicateType,
): WasmContract {
  const type = parseCanonicalPredicateType(input);
  return parseContract({
    version: 1,
    fields: type.fields.map((field): WasmField => {
      const base = {
        name: field.name,
        nullable: field.nullability === "nullable",
        undefinable: field.undefinedValue === "allowed",
        optional: field.presence === "optional",
      };
      switch (field.value.kind) {
        case "boolean":
          return { ...base, kind: "boolean", values: [] };
        case "open-string":
          return { ...base, kind: "string", values: [] };
        case "closed-string-enum":
          return {
            ...base,
            kind: "enum",
            values: [...field.value.values],
          };
        default:
          throw new WasmError(
            "UNSUPPORTED_TYPE",
            "unsupported canonical field kind",
          );
      }
    }),
  });
}

export function lowerPredicate(
  input: unknown,
  contractInput: WasmContract,
): WasmCore {
  const contract = parseContract(contractInput);
  const slots = contractSlots(contract);
  const expression = parsePredicateExpression(input);
  function lower(e: typeof expression): WasmCore {
    if ("conditions" in e)
      return { kind: e.kind, bodies: e.conditions.map(lower) };
    if (e.kind === "not") return { kind: "not", body: lower(e.condition) };
    if (e.property.length !== 1)
      throw new WasmError("UNSUPPORTED_TYPE", "nested paths are unsupported");
    const field = contract.fields.find((f) => f.name === e.property[0]);
    if (!field) throw new WasmError("INVALID_IR", "unknown field");
    const state = slots.findIndex(
      (s) => s.field === field.name && s.kind === "state",
    );
    const value = slots.findIndex(
      (s) => s.field === field.name && s.kind === "value",
    );
    if (e.kind === "present") {
      if (!(field.nullable || field.undefinable || field.optional))
        throw new WasmError("INVALID_IR", "present requires nullish field");
      return { kind: "compare", slot: state, value: 2 };
    }
    if (e.value === null) {
      if (!field.nullable)
        throw new WasmError("INVALID_IR", "null is not allowed");
      return { kind: "compare", slot: state, value: 1 };
    }
    const literal =
      field.kind === "boolean" && typeof e.value === "boolean"
        ? Number(e.value)
        : field.kind === "enum" && typeof e.value === "string"
          ? field.values.indexOf(e.value)
          : -1;
    if (literal < 0 || value < 0)
      throw new WasmError("UNSUPPORTED_TYPE", "unsupported equality literal");
    const equal: WasmCore = { kind: "compare", slot: value, value: literal };
    return state < 0
      ? equal
      : {
          kind: "all",
          bodies: [{ kind: "compare", slot: state, value: 2 }, equal],
        };
  }
  return lower(expression);
}
