// @ts-nocheck -- llang:core is resolved by the L-Lang collection frontend.
import type { List } from "llang:core";
import { map } from "llang:core";
export type Input = { values: List<number>; delta: number };
export type Output = { values: List<number> };
export function evaluate(input: Input): Output {
  return {
    values: map(input.values, (value: number): number => value + input.delta),
  } as Output;
}
