// @ts-nocheck -- llang:core is resolved by the L-Lang collection frontend.
import type { List } from "llang:core";
import { map } from "llang:core";
export type Input = { values: List<number> };
export type Output = { values: List<number> };
export function evaluate(input: Input): Output {
  return { values: map(input.values, (value: number): number => value + 1) } as Output;
}
