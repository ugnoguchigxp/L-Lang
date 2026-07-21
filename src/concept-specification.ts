const SECTIONS = [
  { heading: "Definition:", key: "definition", kind: "text" },
  { heading: "Requirements:", key: "requirements", kind: "list" },
  { heading: "Exclusions:", key: "exclusions", kind: "list" },
  { heading: "Out of scope:", key: "outOfScope", kind: "list" },
  {
    heading: "Leave unresolved when:",
    key: "unresolvedWhen",
    kind: "list",
  },
] as const;

export type StructuredConceptSpecification = {
  definition: string;
  requirements: string[];
  exclusions: string[];
  outOfScope: string[];
  unresolvedWhen: string[];
};

export type ParsedConceptSpecification = {
  syntax: "sections";
  specification: string;
  structure: StructuredConceptSpecification;
};

/**
 * Parses the mandatory, fixed-section Concept syntax. This function is called
 * while scanning the TypeScript source, before any resolver or LLM can run.
 */
export function parseConceptSpecification(
  input: string,
): ParsedConceptSpecification {
  const lines = dedent(input);
  if (lines.length === 0) {
    throw new Error("Concept specification must not be empty");
  }

  rejectUnknownHeadings(lines);
  const positions = SECTIONS.map(({ heading }) => {
    const matches = lines.flatMap((line, index) =>
      line === heading ? [index] : [],
    );
    if (matches.length === 0) {
      throw new Error(`Concept specification is missing required section ${heading}`);
    }
    if (matches.length > 1) {
      throw new Error(`Concept specification contains duplicate section ${heading}`);
    }
    return matches[0]!;
  });

  if (positions[0] !== 0) {
    throw new Error("Concept specification must start with Definition:");
  }
  for (let index = 1; index < positions.length; index += 1) {
    if (positions[index]! < positions[index - 1]!) {
      throw new Error(
        `Concept sections must appear in this order: ${SECTIONS.map(({ heading }) => heading).join(" ")}`,
      );
    }
  }

  const structure = {} as StructuredConceptSpecification;
  for (let index = 0; index < SECTIONS.length; index += 1) {
    const section = SECTIONS[index]!;
    const body = lines.slice(
      positions[index]! + 1,
      positions[index + 1] ?? lines.length,
    );
    if (section.kind === "text") {
      structure[section.key] = parseTextSection(body, section.heading);
    } else {
      structure[section.key] = parseListSection(body, section.heading);
    }
  }
  assertNoDuplicateItems(structure);

  return {
    syntax: "sections",
    specification: renderStructuredConceptSpecification(structure),
    structure,
  };
}

export function renderStructuredConceptSpecification(
  concept: StructuredConceptSpecification,
): string {
  return [
    "Definition:",
    concept.definition,
    "",
    "Requirements:",
    ...concept.requirements.map((item) => `- ${item}`),
    "",
    "Exclusions:",
    ...concept.exclusions.map((item) => `- ${item}`),
    "",
    "Out of scope:",
    ...concept.outOfScope.map((item) => `- ${item}`),
    "",
    "Leave unresolved when:",
    ...concept.unresolvedWhen.map((item) => `- ${item}`),
  ].join("\n");
}

function dedent(input: string): string[] {
  const lines = input.replaceAll("\r\n", "\n").split("\n");
  while (lines[0]?.trim() === "") lines.shift();
  while (lines.at(-1)?.trim() === "") lines.pop();
  const indents = lines
    .filter((line) => line.trim().length > 0)
    .map((line) => line.match(/^\s*/)![0].length);
  const commonIndent = indents.length === 0 ? 0 : Math.min(...indents);
  return lines.map((line) => line.slice(commonIndent).trimEnd());
}

function rejectUnknownHeadings(lines: string[]): void {
  const known = new Set<string>(SECTIONS.map(({ heading }) => heading));
  for (const line of lines) {
    if (/^[A-Za-z][A-Za-z ]*:\s*$/.test(line) && !known.has(line)) {
      throw new Error(`Concept specification contains unknown section ${line}`);
    }
  }
}

function parseTextSection(lines: string[], heading: string): string {
  const value = trimBlankLines(lines).join("\n").trim();
  if (value.length === 0) {
    throw new Error(`Concept section ${heading} must not be empty`);
  }
  return value;
}

function parseListSection(lines: string[], heading: string): string[] {
  const body = trimBlankLines(lines);
  if (body.length === 0) {
    throw new Error(`Concept section ${heading} must contain at least one item`);
  }
  return body.map((line, index) => {
    if (!line.startsWith("- ") || line.slice(2).trim() !== line.slice(2)) {
      throw new Error(
        `Concept section ${heading} line ${index + 1} must be a one-line "- item"`,
      );
    }
    const item = line.slice(2);
    if (item.length === 0) {
      throw new Error(`Concept section ${heading} contains an empty item`);
    }
    return item;
  });
}

function trimBlankLines(lines: string[]): string[] {
  const result = [...lines];
  while (result[0]?.trim() === "") result.shift();
  while (result.at(-1)?.trim() === "") result.pop();
  return result;
}

function assertNoDuplicateItems(
  concept: StructuredConceptSpecification,
): void {
  const sections = [
    ["Requirements", concept.requirements],
    ["Exclusions", concept.exclusions],
    ["Out of scope", concept.outOfScope],
    ["Leave unresolved when", concept.unresolvedWhen],
  ] as const;
  const seen = new Map<string, string>();
  for (const [section, items] of sections) {
    for (const item of items) {
      const previous = seen.get(item);
      if (previous !== undefined) {
        throw new Error(
          `Concept item appears in both ${previous} and ${section}: ${JSON.stringify(item)}`,
        );
      }
      seen.set(item, section);
    }
  }
}
