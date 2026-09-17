import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import {
  canShip,
  needsManualReview,
  type Order,
  type ReviewRequest,
} from "../examples/hybrid-order/can-ship";
import type { PredicateExpression } from "./ir";
import { evaluatePredicateExpression } from "./semantic-test-generator";
import {
  importTypeScriptPredicate,
  type ImportedTypeScriptPredicate,
} from "./typescript-predicate-importer";
import { encodeInput } from "./wasm-contract";
import { emitWasm } from "./wasm-emitter";

const repo = resolve(import.meta.dir, "..");
const sourcePath = resolve(repo, "examples/hybrid-order/can-ship.ts");

function instantiate(imported: ImportedTypeScriptPredicate) {
  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(emitWasm(imported.body, imported.contract)),
  );
  const evaluate = instance.exports.evaluate;
  if (typeof evaluate !== "function")
    throw new Error("missing evaluate export");
  return (input: unknown): boolean =>
    Boolean(evaluate(...encodeInput(imported.contract, input)));
}

function evaluateIr(body: PredicateExpression, input: unknown): boolean {
  return evaluatePredicateExpression(body, input as never);
}

describe("TypeScript predicate import semantic agreement", () => {
  test("canShip agrees with an independent order case table", async () => {
    const imported = await importTypeScriptPredicate({
      workspaceRoot: repo,
      sourcePath,
      functionName: "canShip",
    });
    const wasm = instantiate(imported);
    const cases: Array<{ input: Order; expected: boolean }> = [
      {
        input: { paymentStatus: "paid", inventoryReserved: true },
        expected: true,
      },
      {
        input: {
          paymentStatus: "paid",
          inventoryReserved: true,
          holdReason: undefined,
        },
        expected: true,
      },
      {
        input: {
          paymentStatus: "paid",
          inventoryReserved: true,
          holdReason: null,
        },
        expected: true,
      },
      {
        input: {
          paymentStatus: "paid",
          inventoryReserved: true,
          holdReason: "",
        },
        expected: false,
      },
      {
        input: {
          paymentStatus: "paid",
          inventoryReserved: true,
          holdReason: "fraud-check",
        },
        expected: false,
      },
      {
        input: { paymentStatus: "pending", inventoryReserved: true },
        expected: false,
      },
      {
        input: { paymentStatus: "failed", inventoryReserved: true },
        expected: false,
      },
      {
        input: { paymentStatus: "paid", inventoryReserved: false },
        expected: false,
      },
      {
        input: {
          paymentStatus: "paid",
          inventoryReserved: true,
          cancelled: true,
        },
        expected: false,
      },
      {
        input: {
          paymentStatus: "paid",
          inventoryReserved: true,
          cancelled: false,
        },
        expected: true,
      },
      {
        input: {
          paymentStatus: "paid",
          inventoryReserved: true,
          cancelled: undefined,
        },
        expected: true,
      },
    ];

    for (const item of cases) {
      expect(canShip(item.input)).toBe(item.expected);
      expect(evaluateIr(imported.body, item.input)).toBe(item.expected);
      expect(wasm(item.input)).toBe(item.expected);
    }

    const withoutCancelledCheck: PredicateExpression = {
      kind: "all",
      conditions: [
        {
          kind: "equals",
          property: ["paymentStatus"],
          value: "paid",
        },
        {
          kind: "equals",
          property: ["inventoryReserved"],
          value: true,
        },
        {
          kind: "not",
          condition: { kind: "present", property: ["holdReason"] },
        },
      ],
    };
    const cancelled = cases.find((item) => item.input.cancelled === true);
    if (cancelled === undefined) throw new Error("missing cancellation case");
    expect(evaluateIr(withoutCancelledCheck, cancelled.input)).not.toBe(
      cancelled.expected,
    );
  });

  test("needsManualReview agrees with an independent review case table", async () => {
    const imported = await importTypeScriptPredicate({
      workspaceRoot: repo,
      sourcePath,
      functionName: "needsManualReview",
    });
    const wasm = instantiate(imported);
    const cases: Array<{ input: ReviewRequest; expected: boolean }> = [
      {
        input: { priority: "normal", approved: true },
        expected: false,
      },
      {
        input: { priority: "high", approved: true },
        expected: true,
      },
      {
        input: { priority: "normal", approved: false },
        expected: true,
      },
      {
        input: { priority: "normal", approved: true, reviewer: "" },
        expected: true,
      },
      {
        input: { priority: "normal", approved: true, reviewer: "alice" },
        expected: true,
      },
      {
        input: { priority: "normal", approved: true, reviewer: null },
        expected: false,
      },
      {
        input: { priority: "normal", approved: true, reviewer: undefined },
        expected: false,
      },
      {
        input: { priority: "high", approved: false, reviewer: null },
        expected: true,
      },
    ];

    for (const item of cases) {
      expect(needsManualReview(item.input)).toBe(item.expected);
      expect(evaluateIr(imported.body, item.input)).toBe(item.expected);
      expect(wasm(item.input)).toBe(item.expected);
    }
  });
});
