import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCollectionModuleBuildManifest } from "../../src/llang-module-collection-build";
import { instantiateCollectionModule } from "../../src/llang-module-collection-runtime";
import { buildReversi } from "./build";
import { createNativeRuntime } from "./wasm-runtime.js";
let root, native, browser, manifest;
const empty = () => ({
  board: [],
  player: 1,
  last: -1,
  passed: 0,
  history: [],
});
const start = () => browser.evaluate({ state: empty(), action: -4 });
function step(view, action) {
  const input = { state: view.state, action };
  const actual = browser.evaluate(input);
  expect(actual).toEqual(native.evaluate(input));
  return actual;
}
function drain(view) {
  let count = 0;
  while (view.pendingAction !== -99 && count++ < 128)
    view = step(view, view.pendingAction);
  expect(count).toBeLessThan(128);
  return view;
}
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "reversi-ir-session-"));
  const buildDir = join(root, "dist");
  await buildReversi(buildDir);
  const saved = await readCollectionModuleBuildManifest(
    join(buildDir, "module-build.json"),
  );
  manifest = saved.manifest;
  const wasm = manifest.wasm,
    bytes = saved.artifactBytes.get(wasm.path);
  native = instantiateCollectionModule(wasm.contract, bytes);
  browser = createNativeRuntime(wasm.contract, bytes);
});
afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});
test("build is JSON IR to Wasm only; browser bridge and canonical ABI agree", () => {
  expect(manifest.targets).toEqual(["wasm"]);
  expect(manifest.sources.map((source) => source.path)).toEqual([
    "reversi.semantic.llang.jsonc",
  ]);
  expect(start()).toEqual(native.evaluate({ state: empty(), action: -4 }));
  expect(start().cells.flatMap((cell, i) => (cell.enabled ? [i] : []))).toEqual(
    [19, 26, 37, 44],
  );
  expect(start().status).toBe("あなたの番です");
});
test("Wasm records only human turns and undo removes following AI moves", () => {
  const before = start();
  let view = step(before, 19);
  expect(view.state.history.length).toBe(1);
  expect(view.pendingAction).toBe(-2);
  expect(view.canUndo).toBe(true);
  view = drain(view);
  expect(view.state.history.length).toBe(1);
  expect(view.state.last).toBeGreaterThanOrEqual(0);
  const undone = step(view, -3);
  expect(undone).toEqual(before);
});
test("undo before pending AI restores initial state; reset discards all history", () => {
  const first = step(start(), 19);
  expect(step(first, -3)).toEqual(start());
  expect(step(first, -4)).toEqual(start());
});
test("invalid, occupied, out-of-turn moves and AI on human turn preserve history", () => {
  const initial = start();
  for (const action of [0, 27, 64, 999, -2])
    expect(step(initial, action)).toEqual(initial);
  const white = step(initial, 19);
  expect(step(white, 20)).toEqual(white);
});
test("Wasm decides automatic passes and winner even on non-full terminal board", () => {
  const board = Array(64).fill(1);
  board[0] = 0;
  board[1] = 2;
  const state = { board, player: 2, last: 5, passed: 0, history: [] };
  let view = browser.evaluate({ state, action: -99 });
  expect(view.pendingAction).toBe(-1);
  view = step(view, -1);
  expect(view.state.player).toBe(1);
  expect(view.state.last).toBe(5);
  expect(view.status).toContain("白は置けない");
  view = step(view, 0);
  expect(view.over).toBe(true);
  expect(view.winner).toBe(1);
  expect(view.pendingAction).toBe(-99);
  expect(view.cells.every((cell) => !cell.enabled)).toBe(true);
  const terminal = step(view, -2);
  expect(terminal).toEqual(view);
});
test("cell view and score come from Wasm and last move survives passes", () => {
  const view = step(start(), 19);
  expect(view.black).toBe(4);
  expect(view.white).toBe(1);
  expect(view.cells[19]).toEqual({
    enabled: false,
    label: "黒",
    last: true,
    stone: 1,
  });
  expect(view.cells.every((cell) => !cell.enabled)).toBe(true);
});
test.each([101, 2026, 99991])(
  "full browser-Wasm game %i stays within limits and undo restores last human state",
  (seed) => {
    let view = start(),
      previous = view,
      turns = 0;
    while (!view.over && turns++ < 64) {
      expect(view.pendingAction).toBe(-99);
      expect(view.state.player).toBe(1);
      const moves = view.cells.flatMap((cell, i) => (cell.enabled ? [i] : []));
      expect(moves.length).toBeGreaterThan(0);
      previous = view;
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      view = drain(step(view, moves[seed % moves.length]));
      expect(view.black + view.white).toBe(
        view.state.board.filter((cell) => cell !== 0).length,
      );
      expect(view.state.history.length).toBe(turns);
    }
    expect(turns).toBeLessThan(64);
    expect(view.over).toBe(true);
    expect(step(view, -3)).toEqual(previous);
  },
);
test("bad ABI inputs are rejected before entering Wasm", () => {
  expect(() => browser.evaluate({ state: empty(), action: 1.5 })).toThrow();
  expect(() =>
    browser.evaluate({ state: empty(), action: -4, extra: true }),
  ).toThrow();
});
