// @ts-nocheck -- llang:core is resolved by the L-Lang collection frontend.
import type { Input, Output } from "../domain/types.ts";
import { fold } from "llang:core";

export function evaluate(input: Input): Output {
  const total: number = fold(
    input.values,
    0,
    (sum: number, value: number): number => sum + value,
  );
  return { total: total } as Output;
}
