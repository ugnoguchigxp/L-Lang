import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { activateRelease, invokeActive, runLifecycle } from "./run";

test("requirement repair, moved package, replay, promotion and rollback", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "capability-lifecycle-"));
  try {
    const output = resolve(root, "demo");
    const report = await runLifecycle(output);
    expect(report.behavior).toEqual([true, false, true]);
    expect(report.attempts).toMatchObject([
      { status: "fail" },
      { status: "pass" },
    ]);
    const active = await readFile(resolve(output, "active.json"), "utf8");
    await writeFile(resolve(output, "releases/v2/tests.json"), "{}");
    await expect(activateRelease(output, "v2")).rejects.toThrow(
      "release rejected",
    );
    expect(await readFile(resolve(output, "active.json"), "utf8")).toBe(active);
    expect(await invokeActive(output, { enabled: true, suspended: true })).toBe(
      true,
    );
    await writeFile(resolve(output, "releases/v1/tests.json"), "{}");
    await expect(
      invokeActive(output, { enabled: true, suspended: true }),
    ).rejects.toThrow("active package changed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
