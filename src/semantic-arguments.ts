export const semanticCommands = [
  "build",
  "replay",
  "test",
  "check",
  "diff",
  "approve",
  "explain",
  "closure",
  "verify",
  "tdd-build",
  "tdd-plan",
  "tdd-replay",
  "tdd-test",
] as const;

export type SemanticCommand = (typeof semanticCommands)[number];

export type SemanticArguments = {
  command: SemanticCommand;
  target: string;
  fixturePath?: string;
  testFixturePath?: string;
  reviewer?: string;
  review: boolean;
  json: boolean;
  samples?: number;
  quorum?: number;
};

type OptionName =
  | "--fixture"
  | "--test-fixture"
  | "--reviewer"
  | "--review"
  | "--json"
  | "--samples"
  | "--quorum";

type OptionKind = "flag" | "value";

const optionKinds: Record<OptionName, OptionKind> = {
  "--fixture": "value",
  "--test-fixture": "value",
  "--reviewer": "value",
  "--review": "flag",
  "--json": "flag",
  "--samples": "value",
  "--quorum": "value",
};

const allowedOptions: Record<SemanticCommand, readonly OptionName[]> = {
  build: ["--fixture", "--review"],
  replay: [],
  test: [],
  check: ["--fixture", "--samples", "--quorum"],
  diff: [],
  approve: ["--reviewer"],
  explain: ["--json"],
  closure: ["--json"],
  verify: ["--json"],
  "tdd-build": ["--fixture", "--test-fixture"],
  "tdd-plan": ["--test-fixture"],
  "tdd-replay": [],
  "tdd-test": ["--json"],
};

export function parseSemanticArguments(
  argv: readonly string[],
): SemanticArguments {
  const [rawCommand, target, ...rawOptions] = argv;
  if (
    !isSemanticCommand(rawCommand) ||
    target === undefined ||
    target.startsWith("--")
  ) {
    throw new Error("semantic command and target are required");
  }

  const values = new Map<OptionName, string | true>();
  const allowed = new Set(allowedOptions[rawCommand]);

  for (let index = 0; index < rawOptions.length; index += 1) {
    const token = rawOptions[index];
    if (token === undefined) {
      throw new Error("semantic option parsing ended unexpectedly");
    }
    if (!token.startsWith("--")) {
      throw new Error(
        `${rawCommand} does not accept positional argument ${token}`,
      );
    }
    if (!isOptionName(token) || !allowed.has(token)) {
      throw unsupportedOption(rawCommand, token);
    }
    if (values.has(token)) {
      throw new Error(`${rawCommand} does not accept duplicate ${token}`);
    }

    if (optionKinds[token] === "flag") {
      values.set(token, true);
      continue;
    }

    const value = rawOptions[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${token} requires a value`);
    }
    values.set(token, value);
    index += 1;
  }

  const fixturePath = optionValue(values, "--fixture");
  const testFixturePath = optionValue(values, "--test-fixture");
  const reviewer = optionValue(values, "--reviewer");
  const samples = integerOption(values, "--samples");
  const quorum = integerOption(values, "--quorum");

  if (rawCommand === "approve" && reviewer === undefined) {
    throw new Error("semantic approve requires --reviewer <id>");
  }
  if (reviewer !== undefined && reviewer.trim().length === 0) {
    throw new Error("--reviewer requires a non-empty value");
  }
  if (samples !== undefined && samples < 1) {
    throw new Error("--samples must be a positive integer");
  }
  if (samples !== undefined && samples > 9) {
    throw new Error("--samples must be between 1 and 9");
  }
  if (quorum !== undefined && quorum < 1) {
    throw new Error("--quorum must be a positive integer");
  }
  if (rawCommand === "check") {
    const effectiveSamples = samples ?? 3;
    const effectiveQuorum = quorum ?? (effectiveSamples === 1 ? 1 : 2);
    if (effectiveQuorum > effectiveSamples) {
      throw new Error("--quorum cannot exceed --samples");
    }
    if (effectiveSamples > 1 && effectiveQuorum <= effectiveSamples / 2) {
      throw new Error("--quorum must be a strict majority of --samples");
    }
  }

  return {
    command: rawCommand,
    target,
    ...(fixturePath === undefined ? {} : { fixturePath }),
    ...(testFixturePath === undefined ? {} : { testFixturePath }),
    ...(reviewer === undefined ? {} : { reviewer }),
    review: values.has("--review"),
    json: values.has("--json"),
    ...(samples === undefined ? {} : { samples }),
    ...(quorum === undefined ? {} : { quorum }),
  };
}

function isSemanticCommand(
  value: string | undefined,
): value is SemanticCommand {
  return semanticCommands.some((command) => command === value);
}

function isOptionName(value: string): value is OptionName {
  return Object.hasOwn(optionKinds, value);
}

function optionValue(
  values: ReadonlyMap<OptionName, string | true>,
  name: OptionName,
): string | undefined {
  const value = values.get(name);
  return typeof value === "string" ? value : undefined;
}

function integerOption(
  values: ReadonlyMap<OptionName, string | true>,
  name: "--samples" | "--quorum",
): number | undefined {
  const value = optionValue(values, name);
  if (value === undefined) return undefined;
  if (!/^[0-9]+$/.test(value)) {
    throw new Error(`${name} requires an integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${name} requires a safe integer`);
  }
  return parsed;
}

function unsupportedOption(command: SemanticCommand, option: string): Error {
  if (
    option === "--fixture" &&
    command !== "build" &&
    command !== "check" &&
    command !== "tdd-build"
  ) {
    return new Error(
      `${command} does not accept --fixture and never calls an API`,
    );
  }
  return new Error(`${command} does not accept ${option}`);
}
