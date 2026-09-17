import { expect, test } from "bun:test";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createHostKit } from "./capability-host-kit";
import { HOST_PROTOCOL, runHostRequest } from "./capability-host";

test("JSONC v2 host kit supports inspect, verify, invoke after relocation", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "llang-host-v2-"));
  try {
    const original = resolve(root, "original"),
      moved = resolve(root, "moved kit");
    const kit = await createHostKit(original, 2);
    expect(kit.packageVersion).toBe(2);
    await cp(original, moved, { recursive: true });
    await rm(original, { recursive: true });
    const manifest = resolve(moved, "candidate/capability.json");
    const base = {
      protocol: HOST_PROTOCOL,
      requestId: "v2",
      packageHash: kit.packageHash,
    };
    for (const operation of ["inspect", "verify", "invoke"] as const) {
      const request = {
        ...base,
        operation,
        ...(operation === "invoke"
          ? {
              input: { enabled: true, suspended: false },
              undefinedFields: [],
              timeoutMs: 10000,
            }
          : {}),
      };
      const child = Bun.spawn(
        [
          process.execPath,
          resolve(moved, "runtime/capability-host-cli.ts"),
          manifest,
        ],
        { cwd: moved, env: {}, stdin: "pipe", stdout: "pipe", stderr: "pipe" },
      );
      child.stdin.write(JSON.stringify(request));
      child.stdin.end();
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(code).toBe(0);
      expect(stderr).toBe("");
      expect(JSON.parse(stdout)).toMatchObject({
        status: "ok",
        result:
          operation === "verify"
            ? { status: "pass" }
            : operation === "invoke"
              ? { value: true }
              : { manifest: { version: 2 } },
      });
    }
    const runtime = await readFile(
      resolve(moved, "runtime/capability-host-cli.ts"),
      "utf8",
    );
    expect(runtime).not.toContain("binaryen");
    expect(
      await runHostRequest(manifest, {
        ...base,
        operation: "inspect",
        packageHash: "0".repeat(64),
      }),
    ).toMatchObject({ error: "package-mismatch" });
    expect(
      await runHostRequest(manifest, {
        ...base,
        operation: "invoke",
        input: { enabled: true, suspended: true },
        undefinedFields: [],
        timeoutMs: 10000,
      }),
    ).toMatchObject({ result: { value: false } });
    expect(
      await runHostRequest(manifest, {
        ...base,
        operation: "invoke",
        input: {},
        undefinedFields: [],
        timeoutMs: 10000,
      }),
    ).toMatchObject({ error: "invalid-input" });
    await writeFile(resolve(moved, "candidate/tests.json"), "{}");
    expect(
      await runHostRequest(manifest, { ...base, operation: "inspect" }),
    ).toMatchObject({ status: "error" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
