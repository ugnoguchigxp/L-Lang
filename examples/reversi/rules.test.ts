import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCollectionModuleProgram } from "../../src/llang-module-collection-loader";
import { instantiateCollectionModule } from "../../src/llang-module-collection-runtime";
import { emitCollectionModuleWasm } from "../../src/llang-module-collection-wasm";
import { createReversiDemo } from "./server";
import { buildReversi } from "./build";
type Result = {
  board: number[];
  legal: number[];
  player: number;
  black: number;
  white: number;
  over: boolean;
  winner: number;
  actual: number;
  applied: boolean;
  pass: boolean;
};
const initial = (): number[] =>
  Array.from({ length: 64 }, (_, i) =>
    i === 28 || i === 35 ? 1 : i === 27 || i === 36 ? 2 : 0,
  );
const dirs = [-1, 0, 1].flatMap((r) =>
  [-1, 0, 1].filter((c) => r !== 0 || c !== 0).map((c) => [r, c] as const),
);
// Independent oracle collects coordinate rays and updates a mutable board copy.
function flips(board: number[], player: number, pos: number): number[] {
  if (board[pos] !== 0) return [];
  const captured: number[] = [];
  for (const [dr, dc] of dirs) {
    let r = Math.floor(pos / 8) + dr,
      c = (pos % 8) + dc;
    const ray: number[] = [];
    while (
      r >= 0 &&
      r < 8 &&
      c >= 0 &&
      c < 8 &&
      board[r * 8 + c] === 3 - player
    ) {
      ray.push(r * 8 + c);
      r += dr;
      c += dc;
    }
    if (
      ray.length &&
      r >= 0 &&
      r < 8 &&
      c >= 0 &&
      c < 8 &&
      board[r * 8 + c] === player
    )
      captured.push(...ray);
  }
  return captured;
}
const legal = (board: number[], player: number): number[] =>
  board.flatMap((_, i) => (flips(board, player, i).length ? [i] : []));
function oracle(board: number[], player: number, move: number): number[] {
  const copy = board.slice();
  for (const i of [move, ...flips(board, player, move)]) copy[i] = player;
  return copy;
}
let evaluate: (board: number[], player: number, action: number) => Result;
let serve: Awaited<ReturnType<typeof createReversiDemo>>;
let buildRoot: string;
beforeAll(async () => {
  const program = await loadCollectionModuleProgram(
    "reversi.semantic.llang.jsonc",
    import.meta.dir,
    "rules",
  );
  const native = emitCollectionModuleWasm(program),
    runtime = instantiateCollectionModule(native.contract, native.bytes);
  evaluate = (board, player, action) =>
    runtime.evaluate({ board, player, action }) as Result;
  buildRoot = await mkdtemp(join(tmpdir(), "reversi-rules-"));
  const buildDir = join(buildRoot, "dist");
  await buildReversi(buildDir);
  serve = await createReversiDemo({ buildDir });
});
afterAll(async () => {
  if (buildRoot) await rm(buildRoot, { recursive: true, force: true });
});
function check(result: Result): void {
  expect(result.legal).toEqual(legal(result.board, result.player));
  expect(result.black).toBe(result.board.filter((v) => v === 1).length);
  expect(result.white).toBe(result.board.filter((v) => v === 2).length);
  expect(result.over).toBe(
    legal(result.board, 1).length + legal(result.board, 2).length === 0,
  );
  expect(result.winner).toBe(
    result.over
      ? result.black === result.white
        ? 0
        : result.black > result.white
          ? 1
          : 2
      : 0,
  );
}
describe("native Reversi rules", () => {
  test("initial moves and first flip", () => {
    expect(evaluate(initial(), 1, -1).legal).toEqual([19, 26, 37, 44]);
    const result = evaluate(initial(), 1, 19);
    check(result);
    expect(result.board).toEqual(oracle(initial(), 1, 19));
    expect(result.black).toBe(4);
    expect(result.white).toBe(1);
    expect(result.actual).toBe(19);
  });
  test.each(dirs)("flips direction %i %i", (dr, dc) => {
    const board = Array<number>(64).fill(0);
    board[(3 + dr) * 8 + 3 + dc] = 2;
    board[(3 + 2 * dr) * 8 + 3 + 2 * dc] = 1;
    const result = evaluate(board, 1, 27);
    check(result);
    expect(result.board).toEqual(oracle(board, 1, 27));
    expect(result.black).toBe(3);
    expect(result.white).toBe(0);
  });
  test("flips all eight directions together", () => {
    const board = Array<number>(64).fill(0);
    for (const [dr, dc] of dirs) {
      board[(3 + dr) * 8 + 3 + dc] = 2;
      board[(3 + 2 * dr) * 8 + 3 + 2 * dc] = 1;
    }
    const result = evaluate(board, 1, 27);
    expect(result.board).toEqual(oracle(board, 1, 27));
    expect(result.black).toBe(17);
    expect(result.white).toBe(0);
    check(result);
  });
  test("does not wrap board edges", () => {
    const board = Array<number>(64).fill(0);
    board[8] = 2;
    board[9] = 1;
    const result = evaluate(board, 1, 7);
    expect(result.applied).toBe(false);
    expect(result.board).toEqual(board);
    expect(result.player).toBe(1);
  });
  test.each([0, 27, 28, 63])("illegal or occupied %i is unchanged", (move) => {
    const result = evaluate(initial(), 1, move);
    expect(result.applied).toBe(false);
    expect(result.actual).toBe(-1);
    expect(result.board).toEqual(initial());
    expect(result.player).toBe(1);
  });
  test("forced pass preserves board", () => {
    const board = Array<number>(64).fill(1);
    board[0] = 0;
    board[1] = 2;
    const result = evaluate(board, 2, -1);
    expect(result.pass).toBe(true);
    expect(result.player).toBe(1);
    expect(result.legal).toEqual([0]);
    expect(result.board).toEqual(board);
    expect(result.over).toBe(false);
  });
  test("terminal with empty squares is stable", () => {
    const board = Array<number>(64).fill(1);
    board[0] = 0;
    for (const action of [-2, -1, 0]) {
      const result = evaluate(board, 2, action);
      check(result);
      expect(result.player).toBe(2);
      expect(result.over).toBe(true);
      expect(result.winner).toBe(1);
      expect(result.applied).toBe(false);
      expect(result.pass).toBe(false);
    }
  });
  test("full board draw", () => {
    const result = evaluate(
      Array.from({ length: 64 }, (_, i) => (i % 2) + 1),
      1,
      -1,
    );
    check(result);
    expect(result.winner).toBe(0);
  });
  test("AI chooses legal corner deterministically", () => {
    const board = Array<number>(64).fill(0);
    board[1] = 2;
    board[2] = 1;
    const result = evaluate(board, 1, -2);
    expect(result.actual).toBe(0);
    expect(result.board).toEqual(oracle(board, 1, 0));
    check(result);
    expect(evaluate(board, 1, -2)).toEqual(result);
  });
  test("AI avoids empty-corner diagonal, removes penalty when occupied", () => {
    const board = initial();
    board[10] = 2;
    board[11] = 1;
    expect(legal(board, 1)).toContain(9);
    expect(evaluate(board, 1, -2).actual).not.toBe(9);
    board[0] = 1;
    expect(evaluate(board, 1, -2).actual).toBe(9);
  });
  test.each([17, 2026, 99991])(
    "seeded game %i matches independent oracle through terminal",
    (seed) => {
      let board = initial(),
        player = 1,
        placements = 0,
        turns = 0;
      while (turns++ < 128) {
        const moves = legal(board, player),
          other = legal(board, 3 - player);
        if (moves.length + other.length === 0) break;
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        const move = moves.length ? (moves[seed % moves.length] ?? -1) : -1,
          before = board.filter((v) => v !== 0).length;
        const result = evaluate(board, player, move);
        check(result);
        if (move >= 0) {
          expect(result.board).toEqual(oracle(board, player, move));
          expect(result.board.filter((v) => v !== 0).length).toBe(before + 1);
          expect(result.actual).toBe(move);
          placements++;
        } else {
          expect(result.board).toEqual(board);
          expect(result.pass).toBe(true);
        }
        expect(result.player).toBe(3 - player);
        board = result.board;
        player = result.player;
      }
      expect(turns).toBeLessThan(128);
      expect(placements).toBeLessThanOrEqual(60);
      expect(evaluate(board, player, -1).over).toBe(true);
    },
  );
  test("AI self-play finishes within resource limits", () => {
    let board = initial(),
      player = 1,
      turns = 0;
    while (turns++ < 128) {
      const moves = legal(board, player),
        result = evaluate(board, player, -2);
      check(result);
      if (result.over) break;
      if (moves.length) {
        expect(moves).toContain(result.actual);
        expect(result.board).toEqual(oracle(board, player, result.actual));
      } else expect(result.pass).toBe(true);
      board = result.board;
      player = result.player;
    }
    expect(turns).toBeLessThan(128);
  });
});
describe("static Reversi server", () => {
  test.each([
    "/",
    "/index.html",
    "/style.css",
    "/bridge.js",
    "/wasm-runtime.js",
    "/module-build.json",
    "/program.wasm",
    "/semantic-ir.json",
  ])("GET/HEAD %s", async (path) => {
    const get = await serve(new Request(`http://local${path}`));
    expect(get.status).toBe(200);
    expect(get.headers.get("cache-control")).toBe("no-store");
    expect((await get.arrayBuffer()).byteLength).toBeGreaterThan(10);
    const head = await serve(
      new Request(`http://local${path}`, { method: "HEAD" }),
    );
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });
  test("server provides no gameplay API and accepts only static reads", async () => {
    expect(
      (
        await serve(
          new Request("http://local/api/evaluate", {
            method: "POST",
            body: "{}",
          }),
        )
      ).status,
    ).toBe(404);
    expect(
      (await serve(new Request("http://local/", { method: "POST" }))).status,
    ).toBe(405);
    expect((await serve(new Request("http://local/game.ts"))).status).toBe(404);
    const response = await serve(new Request("http://local/program.wasm"));
    expect(response.headers.get("content-type")).toBe("application/wasm");
    expect(WebAssembly.validate(await response.arrayBuffer())).toBe(true);
  });
});
