import { sha256, stableJson } from "./semantic-fingerprint";
import type { SemanticSource } from "./semantic-source";

export const SEMANTIC_CONTRACT_VERSION = 1;

export type SemanticContractClause = {
  id: string;
  section:
    | "definition"
    | "requirements"
    | "exclusions"
    | "outOfScope"
    | "unresolvedWhen";
  text: string;
  normative: boolean;
};

export type SemanticContract = {
  version: 1;
  conceptId: string;
  conceptName: string;
  typeName: string;
  clauses: SemanticContractClause[];
  typeSchema: SemanticSource["concept"]["typeSchema"];
};

export type CompiledSemanticContract = {
  contract: SemanticContract;
  contractHash: string;
};

export function compileSemanticContract(
  source: SemanticSource,
): CompiledSemanticContract {
  const structure = source.concept.structure;
  const clauses: SemanticContractClause[] = [
    {
      id: "definition",
      section: "definition",
      text: structure.definition,
      normative: false,
    },
    ...renderListClauses("requirements", structure.requirements ?? [], true),
    ...renderListClauses("exclusions", structure.exclusions ?? [], true),
    ...renderListClauses("outOfScope", structure.outOfScope ?? [], false),
    ...renderListClauses(
      "unresolvedWhen",
      structure.unresolvedWhen ?? [],
      false,
    ),
  ];
  const contract: SemanticContract = {
    version: SEMANTIC_CONTRACT_VERSION,
    conceptId: source.concept.id,
    conceptName: source.concept.name,
    typeName: source.concept.typeName,
    clauses,
    typeSchema: source.concept.typeSchema,
  };
  return {
    contract,
    contractHash: sha256(stableJson(contract)),
  };
}

export function normativeClauseIds(contract: SemanticContract): string[] {
  return contract.clauses
    .filter((clause) => clause.normative)
    .map((clause) => clause.id);
}

function renderListClauses(
  section: Exclude<SemanticContractClause["section"], "definition">,
  items: string[],
  normative: boolean,
): SemanticContractClause[] {
  return items.map((text, index) => ({
    id: `${section}[${index}]`,
    section,
    text,
    normative,
  }));
}
