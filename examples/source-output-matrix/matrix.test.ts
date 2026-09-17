import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { runMatrix } from "./run";
import { loadRelease } from "./consumer";

test("both source formats produce portable TS and Wasm with the same oracle", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "source-output-matrix-"));
  try {
    const output = resolve(root, "matrix");
    const report = await runMatrix(output);
    expect(report.rows).toHaveLength(4);
    for (const target of ["typescript", "wasm"]) {
      const rows = report.rows.filter((row) => row.target === target);
      expect(rows[0]?.artifactHash).toBe(rows[1]?.artifactHash as string);
      const deployed = resolve(output, `jsonc-to-${target}`);
      const filename = resolve(
        deployed,
        target === "typescript" ? "predicate.generated.ts" : "predicate.wasm",
      );
      await writeFile(
        filename,
        Buffer.concat([await readFile(filename), Buffer.from("tampered")]),
      );
      await expect(loadRelease(deployed)).rejects.toThrow(
        "artifact hash mismatch",
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
