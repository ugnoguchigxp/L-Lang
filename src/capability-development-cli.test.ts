import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { DevelopmentRun } from "./capability-development";
import {
  runDevelopmentCli,
  runDevelopmentObject,
} from "./capability-development-cli";
import { readJson } from "./prompt-source";

test("P4-21 object helper and CLI produce the same fixture result", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "development-object-"));
  try {
    const base = resolve("examples/capability-development/logic");
    const source = resolve(base, "source.json");
    const metadata = resolve(base, "metadata.json");
    const fixture = resolve(base, "responses.fixture.json");
    const direct = await runDevelopmentObject(
      await readJson(source),
      await readJson(metadata),
      resolve(root, "direct"),
      { mode: "fixture", fixture: await readJson(fixture) },
    );
    const cli = await runDevelopmentCli([
      "develop",
      source,
      "--metadata",
      metadata,
      "--fixtures",
      fixture,
      "--out-dir",
      resolve(root, "cli"),
    ]);
    expect(direct.exitCode).toBe(cli.exitCode);
    const a = direct.result;
    const b = cli.result as DevelopmentRun;
    expect([
      a.sourceHash,
      a.metadataHash,
      a.status,
      a.attempts.at(-1)?.packageHash,
    ]).toEqual([
      b.sourceHash,
      b.metadataHash,
      b.status,
      b.attempts.at(-1)?.packageHash,
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
