declare const conceptInput: unique symbol;
declare const conceptDefinitionBrand: unique symbol;
declare const staticValueBrand: unique symbol;

export type ConceptDefinition = {
  readonly [conceptDefinitionBrand]: true;
};

export type Concept<T> = {
  readonly [conceptInput]?: T;
};

export type Predicate<T> = (value: T) => boolean;

export type NonEmptyReadonlyArray<T> = readonly [T, ...T[]];

export type SemanticExpected = "accepted" | "rejected";

export type SemanticNamedCase<T> = {
  name: string;
  input: T;
  expected: SemanticExpected;
};

export type SemanticTestCases<T> = {
  accept: NonEmptyReadonlyArray<T>;
  reject: NonEmptyReadonlyArray<T>;
  boundary?: readonly SemanticNamedCase<T>[];
  counterfactual?: readonly {
    name: string;
    base: {
      input: T;
      expected: SemanticExpected;
    };
    variants: NonEmptyReadonlyArray<SemanticNamedCase<T>>;
  }[];
  invariance?: readonly {
    name: string;
    expected: SemanticExpected;
    inputs: NonEmptyReadonlyArray<T>;
  }[];
};

export type StaticValue = {
  readonly [staticValueBrand]: true;
};

function compileTimeOnly(name: string): never {
  throw new Error(
    `${name} is a semantic compiler form and cannot run directly`,
  );
}

export function concept<T>(
  _strings: TemplateStringsArray,
  ..._values: never[]
): Concept<T> {
  return compileTimeOnly("concept");
}

export function defineConcept(
  _id: string,
): (strings: TemplateStringsArray, ...values: never[]) => ConceptDefinition {
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
  _cases: SemanticTestCases<T>,
): void {
  compileTimeOnly("semanticTest");
}

export function benchmarkProbe<T>(_predicate: Predicate<T>): void {
  compileTimeOnly("benchmarkProbe");
}

export function staticValue(_value: string): StaticValue {
  return compileTimeOnly("staticValue");
}

export function judgeStatic(
  _value: StaticValue,
  _concept: ConceptDefinition,
): boolean {
  return compileTimeOnly("judgeStatic");
}
