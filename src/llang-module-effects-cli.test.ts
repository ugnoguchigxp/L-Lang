import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLlangCli } from "./llang-cli";

const source = {
  language: "l-lang",
  version: 5,
  kind: "module",
  profile: "module-effects-v1",
  module: "example/cli-effects",
  entry: "main",
  operations: [
    {
      id: "host.increment",
      version: 1,
      requestType: { value: "i32" },
      responseType: { value: "i32" },
      errorType: { code: "string" },
      effect: "host",
      resource: "none",
      cancellable: true,
      idempotent: true,
    },
  ],
  initial: 0,
  steps: [
    {
      operation: "host.increment",
      version: 1,
      payload: 1,
      combine: "replace",
    },
  ],
};

describe("module-effects-v1 CLI", () => {
  test("lints and builds all targets", async () => {
    const root = await mkdtemp(join(tmpdir(), "llang-effects-cli-"));
    try {
      const entry = join(root, "main.llang.jsonc"),
        out = join(root, "out");
      await writeFile(entry, JSON.stringify(source));
      const lint = await runLlangCli([
        "module",
        "lint",
        entry,
        "--root",
        root,
        "--entry",
        "main",
        "--profile",
        "module-effects-v1",
      ]);
      expect(lint.exitCode).toBe(0);
      const interfaceHash = (lint.output as { interfaceHash: string })
          .interfaceHash,
        suite = join(root, "suite.json");
      await writeFile(
        suite,
        JSON.stringify({
          format: "llang-module-suite",
          version: 5,
          profile: "module-effects-v1",
          interfaceHash,
          cases: [
            {
              id: "success",
              events: [
                {
                  request: {
                    generation: 0,
                    sequence: 1,
                    operation: 0,
                    payload: 1,
                  },
                  response: { ok: true, value: 7 },
                },
              ],
              expected: 7,
            },
          ],
        }),
      );
      const tested = await runLlangCli([
        "module",
        "test",
        entry,
        "--root",
        root,
        "--entry",
        "main",
        "--suite",
        suite,
        "--profile",
        "module-effects-v1",
      ]);
      expect(tested.exitCode).toBe(0);
      const build = await runLlangCli([
        "module",
        "build",
        entry,
        "--root",
        root,
        "--entry",
        "main",
        "--target",
        "all",
        "--out-dir",
        out,
        "--profile",
        "module-effects-v1",
      ]);
      expect(build.exitCode).toBe(0);
      expect(
        JSON.parse(await readFile(join(out, "module-build.json"), "utf8"))
          .profile,
      ).toBe("module-effects-v1");
      const verified = await runLlangCli([
        "module",
        "verify",
        join(out, "module-build.json"),
        "--suite",
        suite,
      ]);
      expect(verified.exitCode).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
