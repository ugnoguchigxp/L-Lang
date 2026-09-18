import { Decimal, finiteF64, i64, LBytes } from "./llang-effects-values";
import type { OperationDefinition } from "./llang-effects-contract";

export type EffectValueType =
  | Readonly<{ kind: "i32" }>
  | Readonly<{ kind: "i64" }>
  | Readonly<{ kind: "f64" }>
  | Readonly<{ kind: "bytes" }>
  | Readonly<{ kind: "decimal"; scale: number }>
  | Readonly<{ kind: "string" }>
  | Readonly<{ kind: "bool" }>
  | Readonly<{
      kind: "record";
      fields: Readonly<Record<string, EffectValueType>>;
    }>
  | Readonly<{ kind: "list"; element: EffectValueType }>;

export interface EffectValueRecord {
  readonly [key: string]: EffectValue;
}
export interface EffectValueList extends ReadonlyArray<EffectValue> {}
export type EffectValue =
  | number
  | bigint
  | string
  | boolean
  | LBytes
  | Decimal
  | EffectValueList
  | EffectValueRecord;

export type TypedAwait = Readonly<{
  kind: "await";
  operation: string;
  version: number;
  requestType: EffectValueType;
  responseType: EffectValueType;
  request: EffectValue;
}>;
export type TypedTask = Readonly<{
  kind: "task";
  tasks: readonly TypedAwait[];
  responseType: Readonly<{ kind: "list"; element: EffectValueType }>;
}>;
export type TypedStream = Readonly<{
  kind: "stream";
  operation: string;
  version: number;
  requestType: EffectValueType;
  responseType: EffectValueType;
  request: EffectValue;
  maximumChunks: number;
}>;
export type TypedEffectNode = TypedAwait | TypedTask | TypedStream;
export type TypedEffectsProgram = Readonly<{
  nodes: readonly TypedEffectNode[];
  resultType: EffectValueType;
}>;

export const TYPE_TAG = Object.freeze({
  i32: 1,
  i64: 2,
  f64: 3,
  bytes: 4,
  decimal: 5,
  string: 6,
  bool: 7,
  record: 8,
  list: 9,
});

export const MAX_EFFECT_WIRE_BYTES = 2 * 1024 * 1024;

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

export function typeTag(type: EffectValueType): number {
  return TYPE_TAG[type.kind];
}

export function parseEffectValueType(value: unknown): EffectValueType {
  if (typeof value === "string") {
    if (["i32", "i64", "f64", "bytes", "string", "bool"].includes(value))
      return Object.freeze({ kind: value }) as EffectValueType;
    throw new Error("INVALID_EFFECT_VALUE_TYPE");
  }
  if (!object(value) || typeof value.kind !== "string")
    throw new Error("INVALID_EFFECT_VALUE_TYPE");
  if (value.kind === "decimal") {
    if (
      !Number.isInteger(value.scale) ||
      Number(value.scale) < 0 ||
      Number(value.scale) > 18
    )
      throw new Error("INVALID_EFFECT_VALUE_TYPE");
    return Object.freeze({ kind: "decimal", scale: Number(value.scale) });
  }
  if (value.kind === "list")
    return Object.freeze({
      kind: "list",
      element: parseEffectValueType(value.element),
    });
  if (value.kind === "record" && object(value.fields)) {
    const fields: Record<string, EffectValueType> = Object.create(
      null,
    ) as Record<string, EffectValueType>;
    for (const key of Object.keys(value.fields).sort()) {
      if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key))
        throw new Error("INVALID_EFFECT_VALUE_TYPE");
      fields[key] = parseEffectValueType(value.fields[key]);
    }
    return Object.freeze({ kind: "record", fields: Object.freeze(fields) });
  }
  throw new Error("INVALID_EFFECT_VALUE_TYPE");
}

export function effectValueTypeJson(type: EffectValueType): unknown {
  switch (type.kind) {
    case "i32":
    case "i64":
    case "f64":
    case "bytes":
    case "string":
    case "bool":
      return type.kind;
    case "decimal":
      return { kind: "decimal", scale: type.scale };
    case "list":
      return { kind: "list", element: effectValueTypeJson(type.element) };
    case "record":
      return {
        kind: "record",
        fields: Object.fromEntries(
          Object.keys(type.fields)
            .sort()
            .map((key) => [
              key,
              effectValueTypeJson(type.fields[key] as EffectValueType),
            ]),
        ),
      };
  }
}

const i32Value = (value: unknown): number => {
  if (
    !Number.isInteger(value) ||
    Number(value) < -2147483648 ||
    Number(value) > 2147483647
  )
    throw new Error("INVALID_I32");
  return Number(value);
};

export function decodeEffectValue(
  type: EffectValueType,
  value: unknown,
): EffectValue {
  switch (type.kind) {
    case "i32":
      return i32Value(value);
    case "i64": {
      const text =
        object(value) && Object.keys(value).length === 1
          ? value.i64
          : undefined;
      if (typeof text !== "string") throw new Error("INVALID_I64");
      return i64.parse(text);
    }
    case "f64":
      if (typeof value !== "number") throw new Error("INVALID_F64");
      return finiteF64(value);
    case "bytes": {
      const text =
        object(value) && Object.keys(value).length === 1
          ? value.bytes
          : undefined;
      if (typeof text !== "string") throw new Error("INVALID_BYTES");
      return LBytes.fromBase64(text);
    }
    case "decimal": {
      const decimal =
        object(value) &&
        Object.keys(value).length === 1 &&
        object(value.decimal)
          ? value.decimal
          : undefined;
      if (
        !decimal ||
        Object.keys(decimal).length !== 2 ||
        typeof decimal.coefficient !== "string" ||
        decimal.scale !== type.scale
      )
        throw new Error("INVALID_DECIMAL");
      return new Decimal(i64.parse(decimal.coefficient), type.scale);
    }
    case "string":
      if (typeof value !== "string") throw new Error("INVALID_STRING");
      return value;
    case "bool":
      if (typeof value !== "boolean") throw new Error("INVALID_BOOL");
      return value;
    case "list":
      if (!Array.isArray(value)) throw new Error("INVALID_LIST");
      return Object.freeze(
        value.map((item) => decodeEffectValue(type.element, item)),
      );
    case "record": {
      if (
        !object(value) ||
        Object.keys(value).sort().join() !==
          Object.keys(type.fields).sort().join()
      )
        throw new Error("INVALID_RECORD");
      return Object.freeze(
        Object.fromEntries(
          Object.keys(type.fields)
            .sort()
            .map((key) => [
              key,
              decodeEffectValue(
                type.fields[key] as EffectValueType,
                value[key],
              ),
            ]),
        ),
      );
    }
  }
}

export function encodeEffectValue(
  type: EffectValueType,
  value: EffectValue,
): unknown {
  switch (type.kind) {
    case "i32":
      return i32Value(value);
    case "i64":
      if (typeof value !== "bigint") throw new Error("INVALID_I64");
      return { i64: i64.decode(i64.encode(value)).toString() };
    case "f64":
      if (typeof value !== "number") throw new Error("INVALID_F64");
      return finiteF64(value);
    case "bytes":
      if (!(value instanceof LBytes)) throw new Error("INVALID_BYTES");
      return { bytes: value.toBase64() };
    case "decimal":
      if (!(value instanceof Decimal) || value.scale !== type.scale)
        throw new Error("INVALID_DECIMAL");
      return { decimal: value.toJSON() };
    case "string":
      if (typeof value !== "string") throw new Error("INVALID_STRING");
      return value;
    case "bool":
      if (typeof value !== "boolean") throw new Error("INVALID_BOOL");
      return value;
    case "list":
      if (!Array.isArray(value)) throw new Error("INVALID_LIST");
      return value.map((item) => encodeEffectValue(type.element, item));
    case "record": {
      if (
        !object(value) ||
        Object.keys(value).sort().join() !==
          Object.keys(type.fields).sort().join()
      )
        throw new Error("INVALID_RECORD");
      return Object.fromEntries(
        Object.keys(type.fields)
          .sort()
          .map((key) => [
            key,
            encodeEffectValue(
              type.fields[key] as EffectValueType,
              value[key] as EffectValue,
            ),
          ]),
      );
    }
  }
}

export function encodeEffectWire(
  type: EffectValueType,
  value: EffectValue,
): Uint8Array {
  const body = new TextEncoder().encode(
    JSON.stringify(encodeEffectValue(type, value)),
  );
  if (body.length > MAX_EFFECT_WIRE_BYTES)
    throw new Error("RESOURCE_LIMIT: wireBytes");
  return body;
}

export function decodeEffectWire(
  type: EffectValueType,
  bytes: Uint8Array,
): EffectValue {
  if (bytes.length > MAX_EFFECT_WIRE_BYTES)
    throw new Error("RESOURCE_LIMIT: wireBytes");
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("INVALID_EFFECT_WIRE");
  }
  return decodeEffectValue(type, value);
}

const FILE_READ_TYPE = Object.freeze({
  kind: "record",
  fields: Object.freeze({ path: Object.freeze({ kind: "string" }) }),
}) as EffectValueType;
const FILE_WRITE_TYPE = Object.freeze({
  kind: "record",
  fields: Object.freeze({
    path: Object.freeze({ kind: "string" }),
    bytes: Object.freeze({ kind: "bytes" }),
    replace: Object.freeze({ kind: "bool" }),
  }),
}) as EffectValueType;
const HTTP_REQUEST_TYPE = Object.freeze({
  kind: "record",
  fields: Object.freeze({
    url: Object.freeze({ kind: "string" }),
    method: Object.freeze({ kind: "string" }),
    headers: Object.freeze({
      kind: "list",
      element: Object.freeze({
        kind: "record",
        fields: Object.freeze({
          name: Object.freeze({ kind: "string" }),
          value: Object.freeze({ kind: "string" }),
        }),
      }),
    }),
    body: Object.freeze({ kind: "bytes" }),
  }),
}) as EffectValueType;

export const BUILTIN_IO_OPERATIONS: readonly OperationDefinition[] =
  Object.freeze([
    Object.freeze({
      id: "file.read",
      version: 1,
      requestType: effectValueTypeJson(FILE_READ_TYPE),
      responseType: "bytes",
      errorType: { code: "string" },
      effect: "file",
      resource: "none",
      cancellable: true,
      idempotent: true,
    }),
    Object.freeze({
      id: "file.write",
      version: 1,
      requestType: effectValueTypeJson(FILE_WRITE_TYPE),
      responseType: "i64",
      errorType: { code: "string", outcome: "string" },
      effect: "file",
      resource: "none",
      cancellable: true,
      idempotent: false,
    }),
    Object.freeze({
      id: "http.request",
      version: 1,
      requestType: effectValueTypeJson(HTTP_REQUEST_TYPE),
      responseType: "bytes",
      errorType: { code: "string", outcome: "string" },
      effect: "http",
      resource: "http-body",
      cancellable: true,
      idempotent: false,
    }),
  ] satisfies readonly OperationDefinition[]);

export const BUILTIN_IO_TYPES = Object.freeze({
  fileRead: FILE_READ_TYPE,
  fileWrite: FILE_WRITE_TYPE,
  httpRequest: HTTP_REQUEST_TYPE,
});

export function checkTypedEffectsProgram(
  program: TypedEffectsProgram,
): TypedEffectsProgram {
  if (!program.nodes.length || program.nodes.length > 1024)
    throw new Error("INVALID_TYPED_EFFECTS_PROGRAM");
  for (const node of program.nodes) {
    if (node.kind === "task") {
      if (!node.tasks.length || node.tasks.length > 1024)
        throw new Error("INVALID_TASK_GROUP");
      for (const task of node.tasks) {
        if (
          !task.operation ||
          !Number.isInteger(task.version) ||
          task.version < 1
        )
          throw new Error("INVALID_EFFECT_NODE");
        encodeEffectWire(task.requestType, task.request);
        if (
          JSON.stringify(effectValueTypeJson(task.responseType)) !==
          JSON.stringify(effectValueTypeJson(node.responseType.element))
        )
          throw new Error("INVALID_TASK_GROUP");
      }
    } else {
      if (
        !node.operation ||
        !Number.isInteger(node.version) ||
        node.version < 1
      )
        throw new Error("INVALID_EFFECT_NODE");
      encodeEffectWire(node.requestType, node.request);
      if (
        node.kind === "stream" &&
        (!Number.isInteger(node.maximumChunks) ||
          node.maximumChunks < 1 ||
          node.maximumChunks > 1024)
      )
        throw new Error("INVALID_STREAM_LIMIT");
    }
  }
  const final = program.nodes.at(-1);
  if (
    !final ||
    JSON.stringify(effectValueTypeJson(final.responseType)) !==
      JSON.stringify(effectValueTypeJson(program.resultType))
  )
    throw new Error("INVALID_PROGRAM_RESULT_TYPE");
  return program;
}
