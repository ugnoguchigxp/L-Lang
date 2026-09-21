// @ts-nocheck -- llang:core is resolved by the L-Lang collection frontend.
import type { List } from "llang:core";
import { fold } from "llang:core";
export type Input = { values: List<number> };
export type Output = { total: number };
export function evaluate(input: Input): Output {
  return {
    total: fold(input.values, 0, (sum: number, value: number): number => sum + value),
  } as Output;
}
