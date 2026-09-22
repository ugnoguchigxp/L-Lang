import {
  decodeEffectValue,
  type EffectValueType,
  encodeEffectValue,
} from "./llang-effects-ir";
import type {
  EffectsTraceEvent,
  EffectsTraceJson,
  EffectsTraceScenario,
} from "./llang-effects-trace-differential-oracle";
import type { CheckedEffectsGraph } from "./llang-module-effects-graph";

export function evaluateEffectsTraceReference(
  graph: CheckedEffectsGraph,
  scenario: EffectsTraceScenario,
): readonly EffectsTraceEvent[] {
  const granted = new Set(scenario.granted),
    trace: EffectsTraceEvent[] = [];
  let result: EffectsTraceJson | undefined;
  for (const [index, node] of graph.program.nodes.entries()) {
    if (node.kind !== "await")
      throw new Error("effects trace reference only supports await nodes");
    const definition = graph.registry.get(node.operation, node.version);
    if (!definition)
      throw new Error("effects trace reference missing operation");
    const sequence = index + 1,
      key = `${definition.id}@${definition.version}`;
    if (!granted.has(key)) {
      trace.push({
        kind: "permission-denied",
        sequence,
        operation: definition.id,
        version: definition.version,
        code: "PERMISSION_DENIED",
      });
      trace.push({ kind: "terminal", status: "permission-denied" });
      return Object.freeze(trace);
    }
    trace.push({
      kind: "request",
      sequence,
      operation: definition.id,
      version: definition.version,
      value: encodeEffectValue(
        node.requestType,
        node.request,
      ) as EffectsTraceJson,
    });
    if (scenario.failureIndex === index) {
      trace.push({
        kind: "host-failure",
        sequence,
        operation: definition.id,
        version: definition.version,
        code: "HOST_FAILURE",
      });
      trace.push({ kind: "terminal", status: "host-failure" });
      return Object.freeze(trace);
    }
    const encoded = scenario.responses[index];
    if (encoded === undefined)
      throw new Error(`effects trace reference missing response ${index}`);
    result = encodeEffectValue(
      node.responseType,
      decodeEffectValue(node.responseType, encoded),
    ) as EffectsTraceJson;
    trace.push({
      kind: "response",
      sequence,
      operation: definition.id,
      version: definition.version,
      value: result,
    });
  }
  if (result === undefined)
    throw new Error("effects trace reference did not produce a result");
  const finalType = graph.program.resultType as EffectValueType;
  decodeEffectValue(finalType, result);
  trace.push({ kind: "terminal", status: "completed", result });
  return Object.freeze(trace);
}
