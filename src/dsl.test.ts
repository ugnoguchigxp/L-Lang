import { expect, test } from "bun:test";

import type { SemanticTestCases } from "./dsl";

type State = { state: "ready" | "waiting" };

const validCases = {
  accept: [{ state: "ready" }],
  reject: [{ state: "waiting" }],
} as const satisfies SemanticTestCases<State>;

const emptyAccept: SemanticTestCases<State> = {
  // @ts-expect-error accept must contain at least one case.
  accept: [],
  reject: [{ state: "waiting" }],
};

const emptyReject: SemanticTestCases<State> = {
  accept: [{ state: "ready" }],
  // @ts-expect-error reject must contain at least one case.
  reject: [],
};

test("SemanticTestCases requires non-empty accept and reject cases", () => {
  expect(validCases.accept).toHaveLength(1);
  expect(validCases.reject).toHaveLength(1);
  expect(emptyAccept.accept).toHaveLength(0);
  expect(emptyReject.reject).toHaveLength(0);
});
