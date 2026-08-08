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
  requirements?: string[];
  exclusions?: string[];
  outOfScope?: string[];
  unresolvedWhen?: string[];
};

export type ConceptSpecificationUse = "predicate" | "static-judgment";

export type ParsedConceptSpecification = {
  syntax: "sections";
  specification: string;
  structure: StructuredConceptSpecification;
};

/**
 * Parses the named-section Concept syntax. Definition is mandatory and the
 * remaining sections are optional. This function is called
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
  const positions = new Map<string, number>();
  for (const { heading } of SECTIONS) {
    const matches = lines.flatMap((line, index) =>
      line === heading ? [index] : [],
    );
    if (heading === "Definition:" && matches.length === 0) {
      throw new Error(
        `Concept specification is missing required section ${heading}`,
      );
    }
    if (matches.length > 1) {
      throw new Error(
        `Concept specification contains duplicate section ${heading}`,
      );
    }
    if (matches[0] !== undefined) positions.set(heading, matches[0]);
  }

  if (positions.get("Definition:") !== 0) {
    throw new Error("Concept specification must start with Definition:");
  }
  const present = SECTIONS.flatMap((section) => {
    const position = positions.get(section.heading);
    return position === undefined ? [] : [{ section, position }];
  });
  for (const [index, current] of present.entries()) {
    if (index === 0) continue;
    const previous = present[index - 1];
    if (previous !== undefined && current.position < previous.position) {
      throw new Error(
        `Concept sections must appear in this order: ${SECTIONS.map(({ heading }) => heading).join(" ")}`,
      );
    }
  }

  let definition = "";
  const structure: StructuredConceptSpecification = { definition };
  for (const [index, { section, position }] of present.entries()) {
    const body = lines.slice(
      position + 1,
      present[index + 1]?.position ?? lines.length,
    );
    if (section.kind === "text") {
      definition = parseTextSection(body, section.heading);
      structure.definition = definition;
    } else {
      const items = parseListSection(body, section.heading);
      if (section.key === "requirements") structure.requirements = items;
      if (section.key === "exclusions") structure.exclusions = items;
      if (section.key === "outOfScope") structure.outOfScope = items;
      if (section.key === "unresolvedWhen") structure.unresolvedWhen = items;
    }
  }
  assertNoDuplicateItems(structure);

  return {
    syntax: "sections",
    specification: renderStructuredConceptSpecification(structure),
    structure,
  };
}

export function validateConceptSpecificationForUse(
  concept: StructuredConceptSpecification,
  use: ConceptSpecificationUse,
): void {
  if (
    use === "predicate" &&
    concept.requirements === undefined &&
    concept.exclusions === undefined
  ) {
    throw new Error(
      "Predicate Concept must include Requirements: or Exclusions: with at least one operational criterion",
    );
  }
}

export function renderStructuredConceptSpecification(
  concept: StructuredConceptSpecification,
): string {
  const lines = ["Definition:", concept.definition];
  appendListSection(lines, "Requirements:", concept.requirements);
  appendListSection(lines, "Exclusions:", concept.exclusions);
  appendListSection(lines, "Out of scope:", concept.outOfScope);
  appendListSection(lines, "Leave unresolved when:", concept.unresolvedWhen);
  return lines.join("\n");
}

function appendListSection(
  lines: string[],
  heading: string,
  items: string[] | undefined,
): void {
  if (items === undefined) return;
  lines.push("", heading, ...items.map((item) => `- ${item}`));
}

function dedent(input: string): string[] {
  const lines = input.replaceAll("\r\n", "\n").split("\n");
  while (lines[0]?.trim() === "") lines.shift();
  while (lines.at(-1)?.trim() === "") lines.pop();
  const indents = lines
    .filter((line) => line.trim().length > 0)
    .map((line) => line.length - line.trimStart().length);
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
    throw new Error(
      `Concept section ${heading} must contain at least one item`,
    );
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

function assertNoDuplicateItems(concept: StructuredConceptSpecification): void {
  const sections = [
    ["Requirements", concept.requirements ?? []],
    ["Exclusions", concept.exclusions ?? []],
    ["Out of scope", concept.outOfScope ?? []],
    ["Leave unresolved when", concept.unresolvedWhen ?? []],
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
