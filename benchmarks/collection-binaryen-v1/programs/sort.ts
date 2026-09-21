// @ts-nocheck -- llang:core is resolved by the L-Lang collection frontend.
import type { List } from "llang:core";
import { stableSort } from "llang:core";
export type Input = { values: List<number> };
export type Output = { values: List<number> };
export function evaluate(input: Input): Output {
  return {
    values: stableSort(input.values, (left: number, right: number): number => left - right),
  } as Output;
}
