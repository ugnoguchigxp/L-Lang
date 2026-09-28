import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { reproducePaper, runPaperProcess } from "./paper-reproduce";
import { saveInventory } from "./paper-evidence";
import { createPaperTestRun } from "./paper-test-fixture";

test("saved access run replays without model and yields four equal Wasm binaries", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "paper-reproduce-"));
  try {
    await createPaperTestRun(resolve(root, "source"));
    await saveInventory(
      resolve(root, "source"),
      resolve(root, "inventory"),
      "fixture",
    );
    const result = await reproducePaper(
      resolve(root, "inventory/inventory.json"),
      resolve(root, "out"),
    );
    expect(result.status).toBe("pass");
    expect((result.steps.comparison as { byteEqual: boolean }).byteEqual).toBe(
      true,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("child failures and timeouts are explicit", async () => {
  expect(
    (await runPaperProcess([process.execPath, "-e", "process.exit(4)"]))
      .exitCode,
  ).toBe(4);
  const timed = await runPaperProcess(
    [process.execPath, "-e", "await Bun.sleep(1000)"],
    1,
  );
  expect(timed.timedOut).toBe(true);
});
