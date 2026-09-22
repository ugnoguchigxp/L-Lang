export type CollectionDifferentialFamily =
  | "transform-reduce"
  | "stable-record-sort"
  | "persistent-update"
  | "snapshot-iteration"
  | "returned-closure";

export type CollectionDifferentialCaseModel = Readonly<{
  family: CollectionDifferentialFamily;
  marker: number;
  bias: number;
  descending: boolean;
}>;

export type CollectionOracleMutation = Readonly<{
  reverseCallbacks?: boolean;
  duplicateCallbacks?: boolean;
  dropLastCallback?: boolean;
  rightFold?: boolean;
  ignoreFoldInitial?: boolean;
  unstableSort?: boolean;
  reverseComparator?: boolean;
  mutateSetInput?: boolean;
  mutateAppendInput?: boolean;
  wrongCapture?: boolean;
  liveIteration?: boolean;
  looseAt?: boolean;
  eagerInactive?: boolean;
}>;

export type CollectionOracleValue =
  | null
  | boolean
  | number
  | string
  | readonly CollectionOracleValue[]
  | Readonly<{ [key: string]: CollectionOracleValue }>;

type Item = Readonly<{ key: number; ordinal: number }>;

const I32_MIN = -2_147_483_648;
const I32_MAX = 2_147_483_647;

function collectionFault(
  code: "ARITHMETIC_OVERFLOW" | "DIVISION_BY_ZERO" | "INDEX_OUT_OF_BOUNDS",
): never {
  throw Object.assign(new Error(code), { code });
}

function checked(value: bigint): number {
  if (value < BigInt(I32_MIN) || value > BigInt(I32_MAX))
    return collectionFault("ARITHMETIC_OVERFLOW");
  return Number(value);
}

const add = (left: number, right: number) =>
  checked(BigInt(left) + BigInt(right));
const subtract = (left: number, right: number) =>
  checked(BigInt(left) - BigInt(right));
const multiply = (left: number, right: number) =>
  checked(BigInt(left) * BigInt(right));
const divide = (left: number, right: number) => {
  if (right === 0) return collectionFault("DIVISION_BY_ZERO");
  return checked(BigInt(left) / BigInt(right));
};

function numbers(
  input: Readonly<Record<string, unknown>>,
  name: string,
): number[] {
  const value = input[name];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "number"))
    throw new Error(`collection oracle invalid ${name}`);
  return [...(value as number[])];
}

function numberField(
  input: Readonly<Record<string, unknown>>,
  name: string,
): number {
  const value = input[name];
  if (typeof value !== "number")
    throw new Error(`collection oracle invalid ${name}`);
  return value;
}

function evaluateTransform(
  model: CollectionDifferentialCaseModel,
  input: Readonly<Record<string, unknown>>,
  mutation: CollectionOracleMutation,
): CollectionOracleValue {
  let source = mutation.reverseCallbacks
    ? numbers(input, "values").reverse()
    : numbers(input, "values");
  if (mutation.duplicateCallbacks)
    source = source.flatMap((value) => [value, value]);
  if (mutation.dropLastCallback) source = source.slice(0, -1);
  const offset = add(
      numberField(input, "offset"),
      model.bias + (mutation.wrongCapture ? 1 : 0),
    ),
    selector = numberField(input, "selector"),
    divisor = numberField(input, "divisor");
  const mapped = source.map((value) => {
    if (mutation.eagerInactive && selector >= 0) divide(value, divisor);
    return selector >= 0 ? add(value, offset) : divide(value, divisor);
  });
  const threshold = numberField(input, "threshold"),
    filtered = mapped.filter((value) => value >= threshold);
  let total = mutation.ignoreFoldInitial ? 0 : model.bias;
  if (mutation.rightFold)
    for (let index = filtered.length - 1; index >= 0; index--)
      total = add(multiply(total, 3), filtered[index] as number);
  else for (const value of filtered) total = add(multiply(total, 3), value);
  return { values: filtered, total, marker: model.marker };
}

function items(input: Readonly<Record<string, unknown>>): Item[] {
  const value = input.items;
  if (!Array.isArray(value)) throw new Error("collection oracle invalid items");
  return value.map((item) => {
    if (
      !item ||
      typeof item !== "object" ||
      typeof (item as Item).key !== "number" ||
      typeof (item as Item).ordinal !== "number"
    )
      throw new Error("collection oracle invalid item");
    return { key: (item as Item).key, ordinal: (item as Item).ordinal };
  });
}

function evaluateSort(
  model: CollectionDifferentialCaseModel,
  input: Readonly<Record<string, unknown>>,
  mutation: CollectionOracleMutation,
): CollectionOracleValue {
  const indexed = items(input).map((item, index) => ({ item, index })),
    descending = mutation.reverseComparator
      ? !model.descending
      : model.descending;
  const compare = (left: Item, right: Item) =>
    descending ? subtract(right.key, left.key) : subtract(left.key, right.key);
  for (let index = 1; index < indexed.length; index++) {
    const current = indexed[index];
    if (!current) continue;
    let position = index;
    while (position > 0) {
      const previous = indexed[position - 1];
      if (!previous) break;
      const order = compare(previous.item, current.item);
      if (
        order < 0 ||
        (order === 0 &&
          (mutation.unstableSort
            ? previous.index > current.index
            : previous.index < current.index))
      )
        break;
      indexed[position] = previous;
      position--;
    }
    indexed[position] = current;
  }
  return { items: indexed.map((entry) => entry.item), marker: model.marker };
}

function evaluatePersistent(
  model: CollectionDifferentialCaseModel,
  input: Readonly<Record<string, unknown>>,
  mutation: CollectionOracleMutation,
): CollectionOracleValue {
  const original = numbers(input, "values"),
    index = numberField(input, "index"),
    valid = index >= 0 && index < original.length;
  if (!valid && !(mutation.looseAt && index === original.length))
    return collectionFault("INDEX_OUT_OF_BOUNDS");
  if (!valid)
    return {
      original,
      updated: original,
      extended: original,
      selected: 0,
      marker: model.marker,
    };
  const replacement = numberField(input, "replacement"),
    updated = mutation.mutateSetInput ? original : [...original];
  updated[index] = replacement;
  const appended = add(numberField(input, "appended"), model.bias),
    extended = mutation.mutateAppendInput ? updated : [...updated];
  extended.push(appended);
  return {
    original,
    updated,
    extended,
    selected: updated[index] as number,
    marker: model.marker,
  };
}

function evaluateSnapshot(
  model: CollectionDifferentialCaseModel,
  input: Readonly<Record<string, unknown>>,
  mutation: CollectionOracleMutation,
): CollectionOracleValue {
  const working = numbers(input, "values"),
    snapshot = [...working],
    visits = mutation.liveIteration ? [...snapshot, ...snapshot] : snapshot;
  for (const item of visits) working.push(add(item, model.bias));
  return { values: working, count: visits.length, marker: model.marker };
}

function evaluateClosure(
  model: CollectionDifferentialCaseModel,
  input: Readonly<Record<string, unknown>>,
  mutation: CollectionOracleMutation,
): CollectionOracleValue {
  const base = numberField(input, "base") + (mutation.wrongCapture ? 1 : 0),
    source = mutation.reverseCallbacks
      ? numbers(input, "values").reverse()
      : numbers(input, "values"),
    values = source.map((value) => add(add(base, value), model.bias));
  return { values, marker: model.marker };
}

export function evaluateCollectionOracle(
  model: CollectionDifferentialCaseModel,
  input: Readonly<Record<string, unknown>>,
  mutation: CollectionOracleMutation = {},
): CollectionOracleValue {
  if (model.family === "transform-reduce")
    return evaluateTransform(model, input, mutation);
  if (model.family === "stable-record-sort")
    return evaluateSort(model, input, mutation);
  if (model.family === "persistent-update")
    return evaluatePersistent(model, input, mutation);
  if (model.family === "snapshot-iteration")
    return evaluateSnapshot(model, input, mutation);
  return evaluateClosure(model, input, mutation);
}
