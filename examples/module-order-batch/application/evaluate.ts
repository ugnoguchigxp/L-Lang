// @ts-nocheck -- llang:core is resolved by the L-Lang collection frontend.
import type { Input, Output } from "../domain/order.ts";
import type { List } from "llang:core";
import { filter, fold, stableSort } from "llang:core";

export function evaluate(input: Input): Output {
  const filtered: List<number> = filter(
    input.values,
    (value: number): boolean => value >= input.threshold,
  );
  const sorted: List<number> = stableSort(
    filtered,
    (left: number, right: number): number => left - right,
  );
  const total: number = fold(
    sorted,
    0,
    (sum: number, value: number): number => sum + value,
  );
  return { values: sorted, total: total } as Output;
}
