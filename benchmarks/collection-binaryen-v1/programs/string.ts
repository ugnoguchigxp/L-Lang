// @ts-nocheck -- llang:core is resolved by the L-Lang collection frontend.
import { scalarLength } from "llang:core";
export type Input = { value: string };
export function evaluate(input: Input): number {
  return scalarLength(input.value);
}
