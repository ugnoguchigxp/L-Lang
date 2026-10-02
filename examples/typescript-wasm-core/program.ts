import type { Input, Output } from "./types.ts";

function multiply(value: number, multiplier: number): number {
  return value * multiplier;
}

export function evaluate(input: Input): Output {
  let total: number = 0;
  for (let index: number = 0; index < input.values.length; index++) {
    const value: number = input.values[index] as number;
    if (value < 0) continue;
    if (value === 99) break;
    total += multiply(value, input.settings.multiplier);
  }
  const selected: number[] = input.values
    .filter((value: number): boolean => value >= input.settings.threshold)
    .map((value: number): number => multiply(value, input.settings.multiplier));
  return { total, selected };
}
