import {
  assertFiveCollectionDifferentialLanes,
  COLLECTION_DIFFERENTIAL_LANES,
  CollectionDifferentialHarnessError,
  type CollectionDifferentialHarnessStage,
  type CollectionDifferentialHashes,
  type CollectionDifferentialOutcomes,
  runCollectionDifferentialLanes,
  sameCollectionDifferentialOutcome,
} from "./llang-collection-differential-harness";
import {
  type CollectionDifferentialCaseModel,
  type CollectionDifferentialFamily,
  evaluateCollectionOracle,
} from "./llang-collection-differential-oracle";
import type {
  CollectionExpression,
  CollectionModuleSource,
  CollectionStatement,
  CollectionTypeDeclaration,
  CollectionTypeUse,
} from "./llang-module-collection-ir";

export const COLLECTION_DIFFERENTIAL_FORMAT =
  "llang-collection-differential-v1";
export const COLLECTION_DIFFERENTIAL_DEFAULT_SEED = 20_260_923;

export {
  type CollectionDifferentialCaseModel,
  type CollectionDifferentialFamily,
  type CollectionOracleMutation,
  evaluateCollectionOracle,
} from "./llang-collection-differential-oracle";

export type GeneratedCollectionDifferentialCase = Readonly<{
  format: typeof COLLECTION_DIFFERENTIAL_FORMAT;
  version: 1;
  seed: number;
  caseIndex: number;
  family: CollectionDifferentialFamily;
  mode: string;
  model: CollectionDifferentialCaseModel;
  source: CollectionModuleSource;
  inputs: readonly Readonly<Record<string, unknown>>[];
}>;

export type CollectionDifferentialReproduction = Readonly<{
  format: typeof COLLECTION_DIFFERENTIAL_FORMAT;
  version: 1;
  seed: number;
  caseIndex: number;
  inputIndex: number;
  family: CollectionDifferentialFamily;
  mode: string;
  model: CollectionDifferentialCaseModel;
  source: CollectionModuleSource;
  input: Readonly<Record<string, unknown>>;
  hashes: CollectionDifferentialHashes;
  outcomes: CollectionDifferentialOutcomes;
  replay: Readonly<{
    seed: number;
    startCase: number;
    cases: 1;
    inputIndex: number;
  }>;
}>;

export type CollectionDifferentialRunnerReproduction = Readonly<{
  format: typeof COLLECTION_DIFFERENTIAL_FORMAT;
  version: 1;
  kind: "runner-error";
  seed: number;
  caseIndex: number;
  inputIndex?: number;
  family: CollectionDifferentialFamily;
  mode: string;
  model: CollectionDifferentialCaseModel;
  source: CollectionModuleSource;
  inputs: readonly Readonly<Record<string, unknown>>[];
  stage: CollectionDifferentialHarnessStage | "case-runner";
  error: string;
}>;

export class CollectionDifferentialMismatch extends Error {
  readonly reproduction: CollectionDifferentialReproduction;
  constructor(reproduction: CollectionDifferentialReproduction) {
    super(
      `COLLECTION_DIFFERENTIAL_MISMATCH seed=${reproduction.seed} case=${reproduction.caseIndex} input=${reproduction.inputIndex}`,
    );
    this.name = "CollectionDifferentialMismatch";
    this.reproduction = reproduction;
  }
}

export class CollectionDifferentialRunnerError extends Error {
  readonly reproduction: CollectionDifferentialRunnerReproduction;
  constructor(reproduction: CollectionDifferentialRunnerReproduction) {
    super(
      `COLLECTION_DIFFERENTIAL_RUNNER_ERROR seed=${reproduction.seed} case=${reproduction.caseIndex}${reproduction.inputIndex === undefined ? "" : ` input=${reproduction.inputIndex}`}: ${reproduction.error}`,
    );
    this.name = "CollectionDifferentialRunnerError";
    this.reproduction = reproduction;
  }
}

type Random = () => number;

const I32_MIN = -2_147_483_648;
const I32_MAX = 2_147_483_647;
const FAMILIES = [
  "transform-reduce",
  "stable-record-sort",
  "persistent-update",
  "snapshot-iteration",
  "returned-closure",
] as const;

function mixedSeed(seed: number, caseIndex: number): number {
  let value = (seed ^ Math.imul(caseIndex + 1, 0x9e37_79b9)) >>> 0;
  value ^= value >>> 16;
  value = Math.imul(value, 0x21f0_aaad) >>> 0;
  value ^= value >>> 15;
  value = Math.imul(value, 0x735a_2d97) >>> 0;
  return (value ^ (value >>> 15)) >>> 0;
}

function randomFor(seed: number, caseIndex: number): Random {
  let state = mixedSeed(seed, caseIndex);
  return () => {
    state = (state + 0x6d2b_79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const local = (name: string): CollectionExpression => ({ kind: "local", name });
const field = (
  base: CollectionExpression,
  name: string,
): CollectionExpression => ({
  kind: "field",
  base,
  name,
});
const inputField = (name: string) => field(local("input"), name);
const i32 = (value: number): CollectionExpression => ({
  kind: "literal",
  type: "i32",
  value,
});
const binary = (
  op: string,
  left: CollectionExpression,
  right: CollectionExpression,
): CollectionExpression => ({ kind: "binary", op, left, right });
const intrinsic = (
  name:
    | "at"
    | "set"
    | "append"
    | "map"
    | "filter"
    | "fold"
    | "stableSort"
    | "length",
  args: CollectionExpression[],
): CollectionExpression => ({
  kind: "intrinsic",
  name,
  typeArguments: [],
  arguments: args,
});
const lambda = (
  parameters: { name: string; type: CollectionTypeUse }[],
  returns: CollectionTypeUse,
  result: CollectionExpression,
): CollectionExpression => ({
  kind: "lambda",
  parameters,
  returns,
  body: { statements: [], result },
});
const record = (
  type: string,
  fields: { name: string; value: CollectionExpression }[],
): CollectionExpression => ({
  kind: "record",
  type,
  typeArguments: [],
  fields,
});

function typeDeclaration(
  name: string,
  fields: { name: string; type: CollectionTypeUse }[],
): CollectionTypeDeclaration {
  return {
    name,
    export: true,
    kind: "record",
    typeParameters: [],
    fields,
  };
}

function sourceWith(
  description: string,
  types: CollectionTypeDeclaration[],
  functions: CollectionModuleSource["functions"],
): CollectionModuleSource {
  return {
    language: "l-lang",
    version: 4,
    kind: "module",
    profile: "module-collection-v1",
    description,
    imports: [],
    types,
    functions,
  };
}

function transformSource(
  model: CollectionDifferentialCaseModel,
): CollectionModuleSource {
  const offset = binary("+", inputField("offset"), i32(model.bias)),
    selected = {
      kind: "if" as const,
      condition: binary(">=", inputField("selector"), i32(0)),
      whenTrue: binary("+", local("value"), offset),
      whenFalse: binary("/", local("value"), inputField("divisor")),
    } satisfies CollectionExpression,
    foldBody = binary("+", binary("*", local("sum"), i32(3)), local("value"));
  return sourceWith(
    `Generated transform-reduce Collection differential case ${model.marker}.`,
    [
      typeDeclaration("Input", [
        { name: "values", type: { list: "i32" } },
        { name: "threshold", type: "i32" },
        { name: "offset", type: "i32" },
        { name: "divisor", type: "i32" },
        { name: "selector", type: "i32" },
      ]),
      typeDeclaration("Output", [
        { name: "values", type: { list: "i32" } },
        { name: "total", type: "i32" },
        { name: "marker", type: "i32" },
      ]),
    ],
    [
      {
        name: "evaluate",
        export: true,
        typeParameters: [],
        parameters: [{ name: "input", type: { ref: "Input" } }],
        returns: { ref: "Output" },
        body: {
          statements: [
            {
              kind: "const",
              name: "mapped",
              type: { list: "i32" },
              value: intrinsic("map", [
                inputField("values"),
                lambda([{ name: "value", type: "i32" }], "i32", selected),
              ]),
            },
            {
              kind: "const",
              name: "filtered",
              type: { list: "i32" },
              value: intrinsic("filter", [
                local("mapped"),
                lambda(
                  [{ name: "value", type: "i32" }],
                  "boolean",
                  binary(">=", local("value"), inputField("threshold")),
                ),
              ]),
            },
            {
              kind: "const",
              name: "total",
              type: "i32",
              value: intrinsic("fold", [
                local("filtered"),
                i32(model.bias),
                lambda(
                  [
                    { name: "sum", type: "i32" },
                    { name: "value", type: "i32" },
                  ],
                  "i32",
                  foldBody,
                ),
              ]),
            },
          ],
          result: record("Output", [
            { name: "values", value: local("filtered") },
            { name: "total", value: local("total") },
            { name: "marker", value: i32(model.marker) },
          ]),
        },
      },
    ],
  );
}

function sortSource(
  model: CollectionDifferentialCaseModel,
): CollectionModuleSource {
  const leftKey = field(local("left"), "key"),
    rightKey = field(local("right"), "key"),
    comparator = model.descending
      ? binary("-", rightKey, leftKey)
      : binary("-", leftKey, rightKey);
  return sourceWith(
    `Generated stable-record-sort Collection differential case ${model.marker}.`,
    [
      typeDeclaration("Item", [
        { name: "key", type: "i32" },
        { name: "ordinal", type: "i32" },
      ]),
      typeDeclaration("Input", [
        { name: "items", type: { list: { ref: "Item" } } },
      ]),
      typeDeclaration("Output", [
        { name: "items", type: { list: { ref: "Item" } } },
        { name: "marker", type: "i32" },
      ]),
    ],
    [
      {
        name: "evaluate",
        export: true,
        typeParameters: [],
        parameters: [{ name: "input", type: { ref: "Input" } }],
        returns: { ref: "Output" },
        body: {
          statements: [
            {
              kind: "const",
              name: "sorted",
              type: { list: { ref: "Item" } },
              value: intrinsic("stableSort", [
                inputField("items"),
                lambda(
                  [
                    { name: "left", type: { ref: "Item" } },
                    { name: "right", type: { ref: "Item" } },
                  ],
                  "i32",
                  comparator,
                ),
              ]),
            },
          ],
          result: record("Output", [
            { name: "items", value: local("sorted") },
            { name: "marker", value: i32(model.marker) },
          ]),
        },
      },
    ],
  );
}

function persistentSource(
  model: CollectionDifferentialCaseModel,
): CollectionModuleSource {
  return sourceWith(
    `Generated persistent-update Collection differential case ${model.marker}.`,
    [
      typeDeclaration("Input", [
        { name: "values", type: { list: "i32" } },
        { name: "index", type: "i32" },
        { name: "replacement", type: "i32" },
        { name: "appended", type: "i32" },
      ]),
      typeDeclaration("Output", [
        { name: "original", type: { list: "i32" } },
        { name: "updated", type: { list: "i32" } },
        { name: "extended", type: { list: "i32" } },
        { name: "selected", type: "i32" },
        { name: "marker", type: "i32" },
      ]),
    ],
    [
      {
        name: "evaluate",
        export: true,
        typeParameters: [],
        parameters: [{ name: "input", type: { ref: "Input" } }],
        returns: { ref: "Output" },
        body: {
          statements: [
            {
              kind: "const",
              name: "original",
              type: { list: "i32" },
              value: inputField("values"),
            },
            {
              kind: "const",
              name: "updated",
              type: { list: "i32" },
              value: intrinsic("set", [
                local("original"),
                inputField("index"),
                inputField("replacement"),
              ]),
            },
            {
              kind: "const",
              name: "extended",
              type: { list: "i32" },
              value: intrinsic("append", [
                local("updated"),
                binary("+", inputField("appended"), i32(model.bias)),
              ]),
            },
          ],
          result: record("Output", [
            { name: "original", value: local("original") },
            { name: "updated", value: local("updated") },
            { name: "extended", value: local("extended") },
            {
              name: "selected",
              value: intrinsic("at", [local("updated"), inputField("index")]),
            },
            { name: "marker", value: i32(model.marker) },
          ]),
        },
      },
    ],
  );
}

function snapshotSource(
  model: CollectionDifferentialCaseModel,
): CollectionModuleSource {
  const statements: CollectionStatement[] = [
    {
      kind: "let",
      name: "working",
      type: { list: "i32" },
      value: inputField("values"),
    },
    { kind: "let", name: "count", type: "i32", value: i32(0) },
    {
      kind: "forEach",
      name: "item",
      type: "i32",
      value: local("working"),
      body: [
        {
          kind: "assign",
          name: "working",
          value: intrinsic("append", [
            local("working"),
            binary("+", local("item"), i32(model.bias)),
          ]),
        },
        {
          kind: "assign",
          name: "count",
          value: binary("+", local("count"), i32(1)),
        },
      ],
    },
  ];
  return sourceWith(
    `Generated snapshot-iteration Collection differential case ${model.marker}.`,
    [
      typeDeclaration("Input", [{ name: "values", type: { list: "i32" } }]),
      typeDeclaration("Output", [
        { name: "values", type: { list: "i32" } },
        { name: "count", type: "i32" },
        { name: "marker", type: "i32" },
      ]),
    ],
    [
      {
        name: "evaluate",
        export: true,
        typeParameters: [],
        parameters: [{ name: "input", type: { ref: "Input" } }],
        returns: { ref: "Output" },
        body: {
          statements,
          result: record("Output", [
            { name: "values", value: local("working") },
            { name: "count", value: local("count") },
            { name: "marker", value: i32(model.marker) },
          ]),
        },
      },
    ],
  );
}

function closureSource(
  model: CollectionDifferentialCaseModel,
): CollectionModuleSource {
  const functionType: CollectionTypeUse = {
    function: { parameters: ["i32"], returns: "i32" },
  };
  return sourceWith(
    `Generated returned-closure Collection differential case ${model.marker}.`,
    [
      typeDeclaration("Input", [
        { name: "values", type: { list: "i32" } },
        { name: "base", type: "i32" },
      ]),
      typeDeclaration("Output", [
        { name: "values", type: { list: "i32" } },
        { name: "marker", type: "i32" },
      ]),
    ],
    [
      {
        name: "makeAdder",
        export: false,
        typeParameters: [],
        parameters: [{ name: "base", type: "i32" }],
        returns: functionType,
        body: {
          statements: [],
          result: lambda(
            [{ name: "value", type: "i32" }],
            "i32",
            binary(
              "+",
              binary("+", local("base"), local("value")),
              i32(model.bias),
            ),
          ),
        },
      },
      {
        name: "evaluate",
        export: true,
        typeParameters: [],
        parameters: [{ name: "input", type: { ref: "Input" } }],
        returns: { ref: "Output" },
        body: {
          statements: [
            {
              kind: "const",
              name: "adder",
              type: functionType,
              value: {
                kind: "call",
                callee: "makeAdder",
                typeArguments: [],
                arguments: [inputField("base")],
              },
            },
            {
              kind: "const",
              name: "mapped",
              type: { list: "i32" },
              value: intrinsic("map", [inputField("values"), local("adder")]),
            },
          ],
          result: record("Output", [
            { name: "values", value: local("mapped") },
            { name: "marker", value: i32(model.marker) },
          ]),
        },
      },
    ],
  );
}

function sourceFor(
  model: CollectionDifferentialCaseModel,
): CollectionModuleSource {
  if (model.family === "transform-reduce") return transformSource(model);
  if (model.family === "stable-record-sort") return sortSource(model);
  if (model.family === "persistent-update") return persistentSource(model);
  if (model.family === "snapshot-iteration") return snapshotSource(model);
  return closureSource(model);
}

function small(random: Random): number {
  return Math.floor(random() * 17) - 8;
}

function generatedInputs(
  model: CollectionDifferentialCaseModel,
  random: Random,
): readonly Readonly<Record<string, unknown>>[] {
  if (model.family === "transform-reduce")
    return Object.freeze([
      { values: [], threshold: 0, offset: 0, divisor: 0, selector: 1 },
      { values: [1, 2, 3], threshold: -20, offset: 1, divisor: 1, selector: 1 },
      { values: [3, -2, 4], threshold: 0, offset: 0, divisor: 2, selector: 1 },
      {
        values: [2, 2, 1],
        threshold: -20,
        offset: -1,
        divisor: 1,
        selector: 1,
      },
      {
        values: [I32_MAX],
        threshold: I32_MIN,
        offset: 1,
        divisor: 1,
        selector: 1,
      },
      { values: [1], threshold: I32_MIN, offset: 0, divisor: 0, selector: -1 },
      {
        values: [small(random), small(random), small(random)],
        threshold: small(random),
        offset: small(random),
        divisor: 1,
        selector: 1,
      },
      {
        values: [small(random), small(random)],
        threshold: -20,
        offset: small(random),
        divisor: 2,
        selector: -1,
      },
    ]);
  if (model.family === "stable-record-sort")
    return Object.freeze([
      { items: [] },
      { items: [{ key: 1, ordinal: 0 }] },
      {
        items: [
          { key: 2, ordinal: 0 },
          { key: 1, ordinal: 1 },
          { key: 2, ordinal: 2 },
          { key: 1, ordinal: 3 },
        ],
      },
      {
        items: [
          { key: 0, ordinal: 0 },
          { key: 0, ordinal: 1 },
          { key: 0, ordinal: 2 },
        ],
      },
      {
        items: [
          { key: I32_MAX, ordinal: 0 },
          { key: I32_MIN, ordinal: 1 },
        ],
      },
      {
        items: [
          { key: -2, ordinal: 0 },
          { key: 3, ordinal: 1 },
          { key: -2, ordinal: 2 },
        ],
      },
      {
        items: [
          { key: small(random), ordinal: 0 },
          { key: small(random), ordinal: 1 },
          { key: small(random), ordinal: 2 },
        ],
      },
      {
        items: [
          { key: 4, ordinal: 7 },
          { key: 4, ordinal: 6 },
        ],
      },
    ]);
  if (model.family === "persistent-update")
    return Object.freeze([
      { values: [1], index: 0, replacement: 9, appended: 4 },
      { values: [1, 2, 3], index: 1, replacement: -5, appended: 6 },
      { values: [], index: 0, replacement: 1, appended: 2 },
      { values: [1], index: -1, replacement: 2, appended: 3 },
      { values: [1, 2], index: 2, replacement: 3, appended: 4 },
      { values: [I32_MIN, I32_MAX], index: 1, replacement: 0, appended: 0 },
      {
        values: [small(random), small(random)],
        index: 0,
        replacement: small(random),
        appended: small(random),
      },
      {
        values: [small(random), small(random), small(random)],
        index: 2,
        replacement: small(random),
        appended: small(random),
      },
    ]);
  if (model.family === "snapshot-iteration")
    return Object.freeze([
      { values: [] },
      { values: [1] },
      { values: [1, 2, 3] },
      { values: [-1, 0, 1] },
      { values: [I32_MAX] },
      { values: [I32_MIN] },
      { values: [small(random), small(random)] },
      { values: [small(random), small(random), small(random)] },
    ]);
  return Object.freeze([
    { values: [], base: 0 },
    { values: [1], base: 2 },
    { values: [1, 2, 3], base: -1 },
    { values: [-2, 0, 2], base: 4 },
    { values: [I32_MAX], base: 1 },
    { values: [I32_MIN], base: -1 },
    { values: [small(random), small(random)], base: small(random) },
    {
      values: [small(random), small(random), small(random)],
      base: small(random),
    },
  ]);
}

export function generateCollectionDifferentialCase(
  seed: number,
  caseIndex: number,
): GeneratedCollectionDifferentialCase {
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffff_ffff)
    throw new Error("collection differential seed must be a uint32");
  if (!Number.isInteger(caseIndex) || caseIndex < 0 || caseIndex > 0xffff_ffff)
    throw new Error("collection differential case index must be a uint32");
  const family = FAMILIES[caseIndex % FAMILIES.length];
  if (!family) throw new Error("collection differential family is invalid");
  const random = randomFor(seed, caseIndex),
    marker = (caseIndex % 2_000_000_001) - 1_000_000_000,
    model: CollectionDifferentialCaseModel = Object.freeze({
      family,
      marker,
      bias: Math.floor(random() * 9) - 4,
      descending: Math.floor(caseIndex / FAMILIES.length) % 2 === 1,
    }),
    mode =
      family === "stable-record-sort"
        ? model.descending
          ? "descending"
          : "ascending"
        : "mixed-value-fault";
  return Object.freeze({
    format: COLLECTION_DIFFERENTIAL_FORMAT,
    version: 1,
    seed,
    caseIndex,
    family,
    mode,
    model,
    source: sourceFor(model),
    inputs: generatedInputs(model, random),
  });
}

export function assertCollectionDifferentialOutcomes(
  generated: GeneratedCollectionDifferentialCase,
  inputIndex: number,
  outcomes: CollectionDifferentialOutcomes,
  hashes: CollectionDifferentialHashes,
): void {
  const input = generated.inputs[inputIndex];
  if (!input) throw new Error("collection differential input index is invalid");
  assertFiveCollectionDifferentialLanes(outcomes);
  if (
    COLLECTION_DIFFERENTIAL_LANES.every((lane) =>
      sameCollectionDifferentialOutcome(outcomes.oracle, outcomes[lane]),
    )
  )
    return;
  throw new CollectionDifferentialMismatch({
    format: COLLECTION_DIFFERENTIAL_FORMAT,
    version: 1,
    seed: generated.seed,
    caseIndex: generated.caseIndex,
    inputIndex,
    family: generated.family,
    mode: generated.mode,
    model: generated.model,
    source: generated.source,
    input,
    hashes,
    outcomes,
    replay: {
      seed: generated.seed,
      startCase: generated.caseIndex,
      cases: 1,
      inputIndex,
    },
  });
}

export async function runCollectionDifferentialCase(
  generated: GeneratedCollectionDifferentialCase,
  inputIndex?: number,
): Promise<
  Readonly<{
    programHash: string;
    interfaceHash: string;
    wasmHash: string;
    inputs: number;
  }>
> {
  if (
    inputIndex !== undefined &&
    (!Number.isInteger(inputIndex) ||
      inputIndex < 0 ||
      inputIndex >= generated.inputs.length)
  )
    throw new Error("collection differential input index is invalid");
  const indexes =
      inputIndex === undefined
        ? generated.inputs.map((_, index) => index)
        : [inputIndex],
    inputs = indexes.map((index) => {
      const input = generated.inputs[index];
      if (!input)
        throw new Error("collection differential input index is invalid");
      return input;
    });
  return runCollectionDifferentialLanes({
    source: generated.source,
    inputs,
    oracle: (input) =>
      evaluateCollectionOracle(
        generated.model,
        input as Readonly<Record<string, unknown>>,
      ),
    assertOutcomes: (localIndex, outcomes, hashes) => {
      const originalIndex = indexes[localIndex];
      if (originalIndex === undefined)
        throw new Error("collection differential input index is invalid");
      assertCollectionDifferentialOutcomes(
        generated,
        originalIndex,
        outcomes,
        hashes,
      );
    },
    temporaryPrefix: "llang-collection-differential-",
  });
}

export async function runCollectionDifferential(options: {
  seed: number;
  cases: number;
  startCase?: number;
  inputIndex?: number;
}): Promise<
  Readonly<{
    format: typeof COLLECTION_DIFFERENTIAL_FORMAT;
    version: 1;
    seed: number;
    startCase: number;
    cases: number;
    inputs: number;
    programHashes: readonly string[];
    interfaceHashes: readonly string[];
    wasmHashes: readonly string[];
  }>
> {
  const startCase = options.startCase ?? 0;
  if (
    !Number.isSafeInteger(options.cases) ||
    options.cases < 1 ||
    options.cases > 512
  )
    throw new Error("collection differential cases must be between 1 and 512");
  if (
    !Number.isInteger(options.seed) ||
    options.seed < 0 ||
    options.seed > 0xffff_ffff
  )
    throw new Error("collection differential seed must be a uint32");
  if (
    !Number.isInteger(startCase) ||
    startCase < 0 ||
    startCase > 0xffff_ffff ||
    startCase + options.cases - 1 > 0xffff_ffff
  )
    throw new Error("collection differential case range must fit uint32");
  if (options.inputIndex !== undefined && options.cases !== 1)
    throw new Error(
      "collection differential input index requires exactly one case",
    );
  const programHashes: string[] = [],
    interfaceHashes: string[] = [],
    wasmHashes: string[] = [];
  let inputs = 0;
  for (let offset = 0; offset < options.cases; offset++) {
    const generated = generateCollectionDifferentialCase(
      options.seed,
      startCase + offset,
    );
    try {
      const result = await runCollectionDifferentialCase(
        generated,
        options.inputIndex,
      );
      programHashes.push(result.programHash);
      interfaceHashes.push(result.interfaceHash);
      wasmHashes.push(result.wasmHash);
      inputs += result.inputs;
    } catch (error) {
      if (
        error instanceof CollectionDifferentialMismatch ||
        error instanceof CollectionDifferentialRunnerError
      )
        throw error;
      const harnessError =
          error instanceof CollectionDifferentialHarnessError
            ? error
            : undefined,
        failedInputIndex = options.inputIndex ?? harnessError?.inputIndex;
      throw new CollectionDifferentialRunnerError({
        format: COLLECTION_DIFFERENTIAL_FORMAT,
        version: 1,
        kind: "runner-error",
        seed: generated.seed,
        caseIndex: generated.caseIndex,
        ...(failedInputIndex === undefined
          ? {}
          : { inputIndex: failedInputIndex }),
        family: generated.family,
        mode: generated.mode,
        model: generated.model,
        source: generated.source,
        inputs: generated.inputs,
        stage: harnessError?.stage ?? "case-runner",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return Object.freeze({
    format: COLLECTION_DIFFERENTIAL_FORMAT,
    version: 1,
    seed: options.seed,
    startCase,
    cases: options.cases,
    inputs,
    programHashes: Object.freeze(programHashes),
    interfaceHashes: Object.freeze(interfaceHashes),
    wasmHashes: Object.freeze(wasmHashes),
  });
}
