import {
  COLLECTION_LIMITS,
  containsFunctionType,
  type CheckedCollectionFunction,
  type CheckedCollectionProgram,
  type CollectionBody,
  type CollectionExpression,
  type CollectionStatement,
  type CollectionType,
} from "./llang-module-collection-ir";
import { encodeCollectionToMemory } from "./llang-collection-abi";

export type CollectionFaultCode =
  | "ARITHMETIC_OVERFLOW"
  | "DIVISION_BY_ZERO"
  | "RESOURCE_LIMIT"
  | "INDEX_OUT_OF_BOUNDS"
  | "INVALID_ARTIFACT";
export class CollectionFault extends Error {
  constructor(
    readonly code: CollectionFaultCode,
    message: string = code,
  ) {
    super(message);
  }
}
type Closure = {
  __closure: true;
  fn?: CheckedCollectionFunction;
  owner?: CheckedCollectionFunction;
  lambda?: Extract<CollectionExpression, { kind: "lambda" }>;
  captures: Map<string, unknown>;
};
type Cell = { value: unknown; mutable: boolean };
type Signal =
  | { kind: "return"; value: unknown }
  | { kind: "break" | "continue" };
type State = {
  fuel: number;
  arena: number;
  depth: number;
  program: CheckedCollectionProgram;
  functions: Map<string, CheckedCollectionFunction>;
};
const isEnumerableData = (
  descriptor: PropertyDescriptor | undefined,
): descriptor is PropertyDescriptor & { value: unknown } =>
  !!descriptor && descriptor.enumerable === true && "value" in descriptor;

const charge = (s: State, amount = 1) => {
  if (amount < 0 || s.fuel < amount)
    throw new CollectionFault("RESOURCE_LIMIT", "fuel exhausted");
  s.fuel -= amount;
};
const allocate = (s: State, bytes: number) => {
  if (
    !Number.isSafeInteger(bytes) ||
    bytes < 0 ||
    s.arena + bytes > COLLECTION_LIMITS.arenaBytes
  )
    throw new CollectionFault("RESOURCE_LIMIT", "arena exhausted");
  s.arena += bytes;
};
const checked = (n: number): number => {
  if (!Number.isInteger(n) || n < -2147483648 || n > 2147483647)
    throw new CollectionFault("ARITHMETIC_OVERFLOW");
  return n;
};
function cloneValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneValue);
  if (value && typeof value === "object" && !(value as Closure).__closure)
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, cloneValue(v)]),
    );
  return value;
}
function assertWireSize(type: CollectionType, value: unknown, label: string) {
  try {
    encodeCollectionToMemory(
      new Uint8Array(COLLECTION_LIMITS.wireBytes),
      type,
      value,
      0,
      COLLECTION_LIMITS.wireBytes,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith("RESOURCE_LIMIT:"))
      throw new CollectionFault(
        "RESOURCE_LIMIT",
        `${label} wire exceeds limit`,
      );
    throw new CollectionFault("INVALID_ARTIFACT", `${label} is not encodable`);
  }
}
function validate(
  type: CollectionType,
  value: unknown,
  state: { elements: number },
  path = "value",
  depth = 0,
  seen = new WeakSet<object>(),
): void {
  if (depth > COLLECTION_LIMITS.typeDepth)
    throw new CollectionFault("RESOURCE_LIMIT", "value depth exceeded");
  if (type.kind === "boolean" || type.kind === "string") {
    if (typeof value !== type.kind)
      throw new CollectionFault(
        "INVALID_ARTIFACT",
        `${path} must be ${type.kind}`,
      );
    if (type.kind === "string") {
      const text = value as string;
      if (new TextEncoder().encode(text).length > COLLECTION_LIMITS.stringBytes)
        throw new CollectionFault("RESOURCE_LIMIT", "string exceeds limit");
      for (let index = 0; index < text.length; index++) {
        const unit = text.charCodeAt(index);
        if (unit >= 0xd800 && unit <= 0xdbff) {
          const next = text.charCodeAt(++index);
          if (!(next >= 0xdc00 && next <= 0xdfff))
            throw new CollectionFault(
              "INVALID_ARTIFACT",
              "string contains lone surrogate",
            );
        } else if (unit >= 0xdc00 && unit <= 0xdfff)
          throw new CollectionFault(
            "INVALID_ARTIFACT",
            "string contains lone surrogate",
          );
      }
    }
    return;
  }
  if (type.kind === "i32") {
    if (
      !Number.isInteger(value) ||
      Number(value) < -2147483648 ||
      Number(value) > 2147483647
    )
      throw new CollectionFault("INVALID_ARTIFACT", `${path} must be i32`);
    return;
  }
  if (
    type.kind === "parameter" ||
    type.kind === "function" ||
    containsFunctionType(type)
  )
    throw new CollectionFault(
      "INVALID_ARTIFACT",
      "function or unresolved type on wire",
    );
  if (type.kind === "list") {
    if (!Array.isArray(value))
      throw new CollectionFault("INVALID_ARTIFACT", `${path} must be List`);
    if (seen.has(value))
      throw new CollectionFault("INVALID_ARTIFACT", "cyclic value");
    seen.add(value);
    state.elements += value.length;
    if (
      value.length > COLLECTION_LIMITS.listElements ||
      state.elements > COLLECTION_LIMITS.totalListElements
    )
      throw new CollectionFault(
        "RESOURCE_LIMIT",
        "List element limit exceeded",
      );
    value.forEach((x, i) => {
      validate(type.element, x, state, `${path}[${i}]`, depth + 1, seen);
    });
    seen.delete(value);
    return;
  }
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  )
    throw new CollectionFault("INVALID_ARTIFACT", `${path} must be object`);
  if (seen.has(value))
    throw new CollectionFault("INVALID_ARTIFACT", "cyclic value");
  seen.add(value);
  if (type.kind !== "record" && type.kind !== "union")
    throw new CollectionFault("INVALID_ARTIFACT", "invalid wire type");
  const object = value as Record<string, unknown>;
  const fields =
    type.kind === "record"
      ? type.fields
      : type.variants.find((v) => v.tag === object.tag)?.fields;
  if (!fields)
    throw new CollectionFault("INVALID_ARTIFACT", `${path} has invalid tag`);
  const expected = [
    ...fields.map((f) => f.name),
    ...(type.kind === "union" ? ["tag"] : []),
  ];
  const descriptors = Object.getOwnPropertyDescriptors(object);
  if (
    Object.keys(descriptors).length !== expected.length ||
    Object.keys(descriptors).some((x) => !expected.includes(x)) ||
    expected.some((key) => !isEnumerableData(descriptors[key]))
  )
    throw new CollectionFault("INVALID_ARTIFACT", `${path} has invalid fields`);
  fields.forEach((f) => {
    validate(
      f.type,
      descriptors[f.name]?.value,
      state,
      `${path}.${f.name}`,
      depth + 1,
      seen,
    );
  });
  seen.delete(value);
}

function callClosure(closure: Closure, args: unknown[], state: State): unknown {
  charge(state);
  if (++state.depth > COLLECTION_LIMITS.callDepth) {
    state.depth--;
    throw new CollectionFault("RESOURCE_LIMIT", "call depth exceeded");
  }
  try {
    const env = new Map<string, Cell>();
    for (const [k, v] of closure.captures)
      env.set(k, { value: cloneValue(v), mutable: false });
    const fn = closure.fn,
      lambda = closure.lambda;
    if (!fn && !lambda)
      throw new CollectionFault("INVALID_ARTIFACT", "invalid closure");
    const parameters = fn?.parameters ?? lambda?.parameters ?? [];
    parameters.forEach((p, i) => {
      env.set(p.name, { value: cloneValue(args[i]), mutable: false });
    });
    const body = fn?.body ?? lambda?.body;
    if (!body)
      throw new CollectionFault("INVALID_ARTIFACT", "invalid closure body");
    const signal = evaluateBody(body, env, state, fn ?? closure.owner);
    if (signal?.kind !== "return")
      throw new CollectionFault(
        "INVALID_ARTIFACT",
        "function completed without value",
      );
    return signal.value;
  } finally {
    state.depth--;
  }
}
function evaluateExpression(
  expr: CollectionExpression,
  env: Map<string, Cell>,
  state: State,
  current: CheckedCollectionFunction,
): unknown {
  charge(state);
  if (expr.kind === "literal") return expr.value;
  if (expr.kind === "param" || expr.kind === "local") {
    const cell = env.get(expr.name);
    if (!cell)
      throw new CollectionFault(
        "INVALID_ARTIFACT",
        `unknown binding ${expr.name}`,
      );
    return cell.value;
  }
  if (expr.kind === "list") {
    allocate(state, 8 + expr.elements.length * 8);
    const values = expr.elements.map((x) =>
      evaluateExpression(x, env, state, current),
    );
    return values;
  }
  if (expr.kind === "field")
    return (
      evaluateExpression(expr.base, env, state, current) as Record<
        string,
        unknown
      >
    )[expr.name];
  if (expr.kind === "unary") {
    const v = evaluateExpression(expr.operand, env, state, current);
    return expr.op === "not" ? !v : checked(-Number(v));
  }
  if (expr.kind === "binary") {
    const a = evaluateExpression(expr.left, env, state, current);
    if (expr.op === "&&" && !a) return false;
    if (expr.op === "||" && a) return true;
    const b = evaluateExpression(expr.right, env, state, current);
    if (expr.op === "+") return checked(Number(a) + Number(b));
    if (expr.op === "-") return checked(Number(a) - Number(b));
    if (expr.op === "*") return checked(Number(a) * Number(b));
    if (expr.op === "/" || expr.op === "%") {
      if (b === 0) throw new CollectionFault("DIVISION_BY_ZERO");
      if (a === -2147483648 && b === -1)
        throw new CollectionFault("ARITHMETIC_OVERFLOW");
      return expr.op === "/"
        ? Math.trunc(Number(a) / Number(b))
        : Number(a) % Number(b);
    }
    if (expr.op === "<") return Number(a) < Number(b);
    if (expr.op === "<=") return Number(a) <= Number(b);
    if (expr.op === ">") return Number(a) > Number(b);
    if (expr.op === ">=") return Number(a) >= Number(b);
    if (expr.op === "===") return a === b;
    if (expr.op === "!==") return a !== b;
    if (expr.op === "&&") return Boolean(b);
    if (expr.op === "||") return Boolean(b);
    throw new CollectionFault(
      "INVALID_ARTIFACT",
      `unknown operator ${expr.op}`,
    );
  }
  if (expr.kind === "if")
    return evaluateExpression(expr.condition, env, state, current)
      ? evaluateExpression(expr.whenTrue, env, state, current)
      : evaluateExpression(expr.whenFalse, env, state, current);
  if (expr.kind === "record" || expr.kind === "variant") {
    allocate(state, 8 + expr.fields.length * 8);
    const out: Record<string, unknown> = {};
    if (expr.kind === "variant") out.tag = expr.tag;
    for (const f of expr.fields)
      out[f.name] = evaluateExpression(f.value, env, state, current);
    return out;
  }
  if (expr.kind === "lambda") {
    const captures = new Map<string, unknown>(),
      own = new Set(expr.parameters.map((x) => x.name)),
      refs = new Set<string>();
    const scan = (value: unknown): void => {
      if (!value || typeof value !== "object") return;
      const item = value as Record<string, unknown>;
      if (
        (item.kind === "local" || item.kind === "param") &&
        typeof item.name === "string" &&
        !own.has(item.name)
      )
        refs.add(item.name);
      Object.values(item).forEach(scan);
    };
    scan(expr.body);
    for (const ref of refs) {
      const cell = env.get(ref);
      if (cell) captures.set(ref, cloneValue(cell.value));
    }
    allocate(state, 16 + captures.size * 8);
    return {
      __closure: true,
      owner: current,
      lambda: expr,
      captures,
    } satisfies Closure;
  }
  if (expr.kind === "call") {
    const target = state.functions.get(current.callees[expr.callee] ?? "");
    if (!target)
      throw new CollectionFault(
        "INVALID_ARTIFACT",
        `unknown call ${expr.callee}`,
      );
    return callClosure(
      { __closure: true, fn: target, captures: new Map() },
      expr.arguments.map((x) => evaluateExpression(x, env, state, current)),
      state,
    );
  }
  if (expr.kind === "invoke")
    return callClosure(
      evaluateExpression(expr.callee, env, state, current) as Closure,
      expr.arguments.map((x) => evaluateExpression(x, env, state, current)),
      state,
    );
  if (expr.kind !== "intrinsic")
    throw new CollectionFault("INVALID_ARTIFACT", "invalid expression");
  const args = expr.arguments.map((x) =>
    evaluateExpression(x, env, state, current),
  );
  if (expr.name === "concat") {
    const value = String(args[0]) + String(args[1]);
    const bytes = new TextEncoder().encode(value).length;
    if (bytes > COLLECTION_LIMITS.stringBytes)
      throw new CollectionFault("RESOURCE_LIMIT", "string exceeds limit");
    allocate(state, bytes);
    return value;
  }
  if (expr.name === "scalarLength") return [...String(args[0])].length;
  const input = args[0] as unknown[];
  if (expr.name === "length") return input.length;
  if (expr.name === "at") {
    const i = Number(args[1]);
    if (i < 0 || i >= input.length)
      throw new CollectionFault("INDEX_OUT_OF_BOUNDS");
    return cloneValue(input[i]);
  }
  if (expr.name === "set") {
    const i = Number(args[1]);
    if (i < 0 || i >= input.length)
      throw new CollectionFault("INDEX_OUT_OF_BOUNDS");
    allocate(state, 8 + input.length * 8);
    const out = input.map(cloneValue);
    out[i] = cloneValue(args[2]);
    return out;
  }
  if (expr.name === "append") {
    if (input.length >= COLLECTION_LIMITS.listElements)
      throw new CollectionFault("RESOURCE_LIMIT", "List exceeds limit");
    allocate(state, 8 + (input.length + 1) * 8);
    const out = [...input.map(cloneValue), cloneValue(args[1])];
    return out;
  }
  const cb = args.at(-1) as Closure;
  if (expr.name === "map") {
    allocate(state, 8 + input.length * 8);
    const out = input.map((x) => callClosure(cb, [x], state));
    return out;
  }
  if (expr.name === "filter") {
    allocate(state, 8 + input.length * 8);
    const out: unknown[] = [];
    for (const x of input)
      if (callClosure(cb, [x], state)) out.push(cloneValue(x));
    return out;
  }
  if (expr.name === "fold") {
    let acc = args[1];
    for (const x of input) acc = callClosure(cb, [acc, x], state);
    return acc;
  }
  if (expr.name === "stableSort") {
    let source = input.map(cloneValue),
      target = new Array(source.length);
    allocate(state, 16 + source.length * 16);
    for (let width = 1; width < source.length; width *= 2) {
      for (let start = 0; start < source.length; start += width * 2) {
        let a = start,
          b = Math.min(start + width, source.length),
          ae = b,
          be = Math.min(start + width * 2, source.length),
          out = start;
        while (a < ae || b < be) {
          charge(state);
          if (
            b >= be ||
            (a < ae &&
              Number(callClosure(cb, [source[a], source[b]], state)) <= 0)
          )
            target[out++] = source[a++];
          else target[out++] = source[b++];
        }
      }
      const swap = source;
      source = target;
      target = swap;
    }
    return source;
  }
  throw new CollectionFault(
    "INVALID_ARTIFACT",
    `unknown intrinsic ${expr.name}`,
  );
}
function evaluateStatements(
  statements: CollectionStatement[],
  env: Map<string, Cell>,
  state: State,
  current: CheckedCollectionFunction,
): Signal | undefined {
  for (const statement of statements) {
    charge(state);
    if (statement.kind === "const" || statement.kind === "let")
      env.set(statement.name, {
        value: evaluateExpression(statement.value, env, state, current),
        mutable: statement.kind === "let",
      });
    else if (statement.kind === "assign") {
      const cell = env.get(statement.name);
      if (!cell?.mutable)
        throw new CollectionFault(
          "INVALID_ARTIFACT",
          "assignment to immutable binding",
        );
      cell.value = evaluateExpression(statement.value, env, state, current);
    } else if (statement.kind === "return")
      return {
        kind: "return",
        value: evaluateExpression(statement.value, env, state, current),
      };
    else if (statement.kind === "break" || statement.kind === "continue")
      return { kind: statement.kind };
    else if (statement.kind === "if") {
      const branch = evaluateExpression(
          statement.condition,
          env,
          state,
          current,
        )
          ? statement.whenTrue
          : statement.whenFalse,
        signal = evaluateStatements(branch, new Map(env), state, current);
      if (signal) return signal;
    } else if (statement.kind === "match") {
      const value = evaluateExpression(
          statement.value,
          env,
          state,
          current,
        ) as Record<string, unknown>,
        selected = statement.cases.find((item) => item.tag === value.tag);
      if (!selected)
        throw new CollectionFault("INVALID_ARTIFACT", "invalid match tag");
      const signal = evaluateStatements(
        selected.body,
        new Map(env),
        state,
        current,
      );
      if (signal) return signal;
    } else if (statement.kind === "while") {
      while (true) {
        charge(state);
        if (!evaluateExpression(statement.condition, env, state, current))
          break;
        const signal = evaluateStatements(
          statement.body,
          new Map(env),
          state,
          current,
        );
        if (signal?.kind === "return") return signal;
        if (signal?.kind === "break") break;
      }
    } else if (statement.kind === "forEach") {
      const snapshot = (
        evaluateExpression(statement.value, env, state, current) as unknown[]
      ).map(cloneValue);
      for (const item of snapshot) {
        charge(state);
        const nested = new Map(env);
        nested.set(statement.name, { value: item, mutable: false });
        const signal = evaluateStatements(
          statement.body,
          nested,
          state,
          current,
        );
        if (signal?.kind === "return") return signal;
        if (signal?.kind === "break") break;
      }
    }
  }
}
function evaluateBody(
  body: CollectionBody,
  env: Map<string, Cell>,
  state: State,
  current?: CheckedCollectionFunction,
): Signal | undefined {
  const fn =
    current ?? [...state.functions.values()].find((x) => x.body === body);
  if (!fn) throw new CollectionFault("INVALID_ARTIFACT");
  const signal = evaluateStatements(body.statements, env, state, fn);
  if (signal) return signal;
  return body.result
    ? { kind: "return", value: evaluateExpression(body.result, env, state, fn) }
    : undefined;
}
export function evaluateCollectionProgram(
  program: CheckedCollectionProgram,
  input: unknown,
): unknown {
  validate(program.entryInput, input, { elements: 0 }, "input");
  assertWireSize(program.entryInput, input, "input");
  const functions = new Map(program.functions.map((x) => [x.symbol, x])),
    entry = functions.get(program.entry);
  if (!entry)
    throw new CollectionFault("INVALID_ARTIFACT", "entry function missing");
  const state: State = {
    fuel: COLLECTION_LIMITS.fuel,
    arena: 0,
    depth: 0,
    program,
    functions,
  };
  const result = callClosure(
    { __closure: true, fn: entry, captures: new Map() },
    [cloneValue(input)],
    state,
  );
  validate(program.entryOutput, result, { elements: 0 }, "output");
  assertWireSize(program.entryOutput, result, "output");
  return cloneValue(result);
}
