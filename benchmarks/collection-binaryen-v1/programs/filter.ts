// @ts-nocheck -- llang:core is resolved by the L-Lang collection frontend.
import type { List } from "llang:core";
import { filter } from "llang:core";
export type Input = { values: List<number>; threshold: number };
export type Output = { values: List<number> };
export function evaluate(input: Input): Output {
  return {
    values: filter(input.values, (value: number): boolean => value >= input.threshold),
  } as Output;
}
