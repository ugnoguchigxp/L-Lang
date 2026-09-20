import type { BaselineInput } from "../../../../../src/effects-adversarial-benchmark";

export async function EffectsBenchmarkBaseline(input: BaselineInput): Promise<string> {
  return input.host.perform(input.task.operation, input.task.target, input.task.result);
}
