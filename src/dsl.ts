declare const conceptInput: unique symbol;
declare const conceptDefinitionBrand: unique symbol;

export type ConceptDefinition = {
  readonly [conceptDefinitionBrand]: true;
};

export type Concept<T> = {
  readonly [conceptInput]?: T;
};

export type Predicate<T> = (value: T) => boolean;

function compileTimeOnly(name: string): never {
  throw new Error(`${name} is a semantic compiler form and cannot run directly`);
}

export function concept<T>(
  _strings: TemplateStringsArray,
  ..._values: never[]
): Concept<T> {
  return compileTimeOnly("concept");
}

export function defineConcept(
  _id: string,
): (
  strings: TemplateStringsArray,
  ...values: never[]
) => ConceptDefinition {
  return (_strings: TemplateStringsArray, ..._values: never[]) =>
    compileTimeOnly("defineConcept");
}

export function bindConcept<T>(_definition: ConceptDefinition): Concept<T> {
  return compileTimeOnly("bindConcept");
}

export function generatePredicate<T>(_concept: Concept<T>): Predicate<T> {
  return compileTimeOnly("generatePredicate");
}

export function semanticTest<T>(
  _predicate: Predicate<T>,
  _cases: {
    accept: readonly T[];
    reject: readonly T[];
  },
): void {
  compileTimeOnly("semanticTest");
}
