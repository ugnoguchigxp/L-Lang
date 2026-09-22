export type EffectsTraceJson =
  | null
  | boolean
  | number
  | string
  | readonly EffectsTraceJson[]
  | Readonly<{ [key: string]: EffectsTraceJson }>;

export type EffectsTraceFamily =
  | "scalar-chain"
  | "wide-number-chain"
  | "bytes-chain"
  | "record-chain"
  | "list-chain"
  | "mixed-chain";

export type EffectsTraceOperationModel = Readonly<{
  id: string;
  version: number;
  requestType: EffectsTraceJson;
  responseType: EffectsTraceJson;
  request: EffectsTraceJson;
  cancellable: boolean;
  idempotent: boolean;
}>;

export type EffectsTraceCaseModel = Readonly<{
  family: EffectsTraceFamily;
  operations: readonly EffectsTraceOperationModel[];
  resultType: EffectsTraceJson;
}>;

export type EffectsTraceScenario = Readonly<{
  id: string;
  responses: readonly EffectsTraceJson[];
  granted: readonly string[];
  failureIndex?: number;
}>;

export type EffectsTraceEvent =
  | Readonly<{
      kind: "request";
      sequence: number;
      operation: string;
      version: number;
      value: EffectsTraceJson;
    }>
  | Readonly<{
      kind: "response";
      sequence: number;
      operation: string;
      version: number;
      value: EffectsTraceJson;
    }>
  | Readonly<{
      kind: "host-failure" | "permission-denied";
      sequence: number;
      operation: string;
      version: number;
      code: "HOST_FAILURE" | "PERMISSION_DENIED";
    }>
  | Readonly<{
      kind: "terminal";
      status: "completed" | "host-failure" | "permission-denied";
      result?: EffectsTraceJson;
    }>;

export type EffectsTraceOracleMutation = Readonly<{
  reverseRequests?: boolean;
  duplicateFirst?: boolean;
  dropMiddle?: boolean;
  ignoreGrant?: boolean;
  continueAfterFailure?: boolean;
  firstResult?: boolean;
  coerceTagged?: boolean;
}>;

const operationKey = (operation: EffectsTraceOperationModel) =>
  `${operation.id}@${operation.version}`;

const coerced = (value: EffectsTraceJson): EffectsTraceJson => {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Readonly<Record<string, EffectsTraceJson>>;
    if (typeof record.i64 === "string") return Number(record.i64);
    if (typeof record.bytes === "string") return record.bytes;
    if (record.decimal && typeof record.decimal === "object")
      return Number(
        (record.decimal as Readonly<Record<string, EffectsTraceJson>>)
          .coefficient,
      );
  }
  return value;
};

export function evaluateEffectsTraceOracle(
  model: EffectsTraceCaseModel,
  scenario: EffectsTraceScenario,
  mutation: EffectsTraceOracleMutation = {},
): readonly EffectsTraceEvent[] {
  const operations = [...model.operations];
  if (mutation.reverseRequests) operations.reverse();
  if (mutation.duplicateFirst && operations[0])
    operations.splice(1, 0, operations[0]);
  if (mutation.dropMiddle && operations.length > 1)
    operations.splice(Math.floor(operations.length / 2), 1);
  const granted = new Set(scenario.granted),
    trace: EffectsTraceEvent[] = [];
  let firstResponse: EffectsTraceJson | undefined,
    finalResponse: EffectsTraceJson | undefined;
  for (const [index, operation] of operations.entries()) {
    const sequence = index + 1,
      sourceIndex = model.operations.indexOf(operation);
    if (sourceIndex < 0)
      throw new Error("effects trace oracle unknown operation");
    if (!mutation.ignoreGrant && !granted.has(operationKey(operation))) {
      trace.push({
        kind: "permission-denied",
        sequence,
        operation: operation.id,
        version: operation.version,
        code: "PERMISSION_DENIED",
      });
      trace.push({ kind: "terminal", status: "permission-denied" });
      return Object.freeze(trace);
    }
    trace.push({
      kind: "request",
      sequence,
      operation: operation.id,
      version: operation.version,
      value: operation.request,
    });
    if (scenario.failureIndex === sourceIndex) {
      trace.push({
        kind: "host-failure",
        sequence,
        operation: operation.id,
        version: operation.version,
        code: "HOST_FAILURE",
      });
      if (!mutation.continueAfterFailure) {
        trace.push({ kind: "terminal", status: "host-failure" });
        return Object.freeze(trace);
      }
      continue;
    }
    const response = scenario.responses[sourceIndex];
    if (response === undefined)
      throw new Error(`effects trace oracle missing response ${sourceIndex}`);
    const value = mutation.coerceTagged ? coerced(response) : response;
    firstResponse ??= value;
    finalResponse = value;
    trace.push({
      kind: "response",
      sequence,
      operation: operation.id,
      version: operation.version,
      value,
    });
  }
  if (finalResponse === undefined)
    throw new Error("effects trace oracle did not produce a result");
  const result = mutation.firstResult ? firstResponse : finalResponse;
  if (result === undefined)
    throw new Error("effects trace oracle did not produce a selected result");
  trace.push({
    kind: "terminal",
    status: "completed",
    result,
  });
  return Object.freeze(trace);
}
