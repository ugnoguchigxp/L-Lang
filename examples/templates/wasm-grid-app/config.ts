import { join } from "node:path";
export type GridConfig = {
  version: 1;
  entry: "game.semantic.llang.jsonc";
  title: string;
  subtitle: string;
  board: { width: number; height: number };
  preview: { width: number; height: number };
  initialState: Record<string, unknown>;
  resetAction: number;
  idleAction: number;
  tickAction: number;
  keyActions: Record<string, number>;
  repeatActions?: number[];
  controls: { label: string; action: number }[];
  tests: {
    entry: "tests.semantic.llang.jsonc";
    cases: string[];
    sequence?: {
      entryName: "checkTransition";
      id: string;
      action: number;
      maxSteps: number;
    };
  };
};
export async function readGridConfig(root: string): Promise<GridConfig> {
  const c = await Bun.file(join(root, "app.json")).json();
  const i32 = (n: unknown) =>
    Number.isInteger(n) &&
    (n as number) >= -2147483648 &&
    (n as number) <= 2147483647;
  const grid = (g: GridConfig["board"]) =>
    g &&
    Number.isInteger(g.width) &&
    Number.isInteger(g.height) &&
    g.width >= 1 &&
    g.width <= 32 &&
    g.height >= 1 &&
    g.height <= 32;
  if (
    c.version !== 1 ||
    c.entry !== "game.semantic.llang.jsonc" ||
    typeof c.title !== "string" ||
    typeof c.subtitle !== "string" ||
    !grid(c.board) ||
    !grid(c.preview) ||
    !c.initialState ||
    typeof c.initialState !== "object" ||
    Array.isArray(c.initialState) ||
    ![c.resetAction, c.idleAction, c.tickAction].every(i32) ||
    !c.keyActions ||
    typeof c.keyActions !== "object" ||
    Array.isArray(c.keyActions) ||
    !Object.values(c.keyActions).every(i32) ||
    !Array.isArray(c.controls) ||
    c.controls.length > 32 ||
    c.controls.some(
      (v: GridConfig["controls"][number]) =>
        !v || typeof v.label !== "string" || !i32(v.action),
    ) ||
    (c.repeatActions !== undefined &&
      (!Array.isArray(c.repeatActions) || !c.repeatActions.every(i32))) ||
    c.tests?.entry !== "tests.semantic.llang.jsonc" ||
    !Array.isArray(c.tests.cases) ||
    !c.tests.cases.length ||
    c.tests.cases.length > 256 ||
    c.tests.cases.some((s: unknown) => typeof s !== "string" || !s) ||
    new Set(c.tests.cases).size !== c.tests.cases.length ||
    (c.tests.sequence !== undefined &&
      (c.tests.sequence.entryName !== "checkTransition" ||
        typeof c.tests.sequence.id !== "string" ||
        !c.tests.sequence.id ||
        !i32(c.tests.sequence.action) ||
        !Number.isInteger(c.tests.sequence.maxSteps) ||
        c.tests.sequence.maxSteps < 1 ||
        c.tests.sequence.maxSteps > 256))
  )
    throw new Error("Invalid grid app configuration");
  return c;
}
