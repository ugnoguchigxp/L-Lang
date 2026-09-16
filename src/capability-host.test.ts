import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { packageCapability } from "./capability-package";
import {
  HOST_PROTOCOL,
  parseHostRequest,
  runHostRequest,
} from "./capability-host";
import { readJson } from "./prompt-source";
let root: string, manifest: string, hash: string;
beforeAll(async () => {
  root = await mkdtemp(resolve(tmpdir(), "cap-host-"));
  const example = "examples/capability-access";
  const result = await packageCapability(
    `${example}/access.prompt.json`,
    `${example}/tests.json`,
    await readJson(`${example}/metadata.json`),
    resolve(root, "candidate"),
  );
  manifest = result.manifest;
  hash = result.packageHash;
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});
function request(operation = "invoke") {
  return {
    protocol: HOST_PROTOCOL,
    requestId: "case-1",
    operation,
    packageHash: hash,
    ...(operation === "invoke"
      ? {
          input: { enabled: true, suspended: false },
          undefinedFields: [],
          timeoutMs: 10000,
        }
      : {}),
  };
}
test("host inspect/verify are pinned to package hash; acceptance stays not-run", async () => {
  expect(await runHostRequest(manifest, request("inspect"))).toMatchObject({
    status: "ok",
    packageHash: hash,
    result: { acceptance: "not-run" },
  });
  expect(await runHostRequest(manifest, request("verify"))).toMatchObject({
    status: "ok",
    result: { status: "pass", acceptance: "not-run" },
  });
  expect(
    await runHostRequest(manifest, {
      ...request(),
      packageHash: "0".repeat(64),
    }),
  ).toMatchObject({ status: "error", error: "package-mismatch" });
});
test("actual Wasm true/false and invalid input have distinct responses", async () => {
  for (const enabled of [true, false])
    for (const suspended of [true, false]) {
      expect(
        await runHostRequest(manifest, {
          ...request(),
          input: { enabled, suspended },
        }),
      ).toMatchObject({
        status: "ok",
        apiCalls: 0,
        result: { value: enabled && !suspended },
      });
    }
  expect(
    await runHostRequest(manifest, {
      ...request(),
      input: { enabled: "true" },
    }),
  ).toMatchObject({ status: "error", error: "invalid-input" });
});
test("host rejects malformed envelopes and altered packages", async () => {
  for (const raw of [
    null,
    { ...request(), extra: true },
    { ...request(), protocol: "v0" },
    { ...request(), timeoutMs: 10001 },
    { ...request(), undefinedFields: ["enabled"] },
    { ...request(), undefinedFields: ["x", "x"] },
    { ...request("inspect"), input: {} },
  ]) {
    expect(() => parseHostRequest(raw)).toThrow();
    expect(await runHostRequest(manifest, raw)).toMatchObject({
      status: "error",
      error: "invalid-request",
    });
  }
  const text = await readFile(manifest, "utf8");
  await writeFile(manifest, text.replace('"predicate-i32-v1"', '"invalid"'));
  expect(await runHostRequest(manifest, request())).toMatchObject({
    status: "error",
    error: "execution-error",
  });
  await writeFile(manifest, text);
});
test("one-shot CLI emits one JSON; malformed and oversized transport fails", async () => {
  for (const [body, expected] of [
    [JSON.stringify(request()), 0],
    ["{", 2],
    ["x".repeat(65537), 2],
  ] as const) {
    const child = Bun.spawn(
      [process.execPath, "src/capability-host-cli.ts", manifest],
      { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
    );
    child.stdin.write(body);
    child.stdin.end();
    const [stdout, , code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(code).toBe(expected);
    if (expected === 0)
      expect(JSON.parse(stdout)).toMatchObject({
        status: "ok",
        result: { value: true },
      });
    else expect(stdout).toBe("");
  }
});

test("portable kit runs outside the repository with shared schemas and expected vectors", async () => {
  const { createHostKit } = await import("./capability-host-kit");
  const { default: Ajv2020 } = await import("ajv/dist/2020");
  const { cp } = await import("node:fs/promises");
  const kit = resolve(root, "kit");
  await createHostKit(kit);
  const moved = resolve(root, "copied kit with spaces");
  await cp(kit, moved, { recursive: true });
  const ajv = new Ajv2020();
  const validateRequest = ajv.compile(
    (await readJson(resolve(moved, "request.schema.json"))) as object,
  );
  const validateResponse = ajv.compile(
    (await readJson(resolve(moved, "response.schema.json"))) as object,
  );
  const vectors = (await readJson(resolve(moved, "vectors.json"))) as {
    request: unknown;
    expected: object;
  }[];
  for (const vector of vectors) {
    expect(validateRequest(vector.request)).toBe(true);
    const child = Bun.spawn(
      [
        process.execPath,
        resolve(moved, "runtime/capability-host-cli.ts"),
        resolve(moved, "candidate/capability.json"),
      ],
      { cwd: moved, env: {}, stdin: "pipe", stdout: "pipe", stderr: "pipe" },
    );
    child.stdin.write(JSON.stringify(vector.request));
    child.stdin.end();
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(code).toBe(0);
    expect(stderr).toBe("");
    const response = JSON.parse(stdout);
    expect(validateResponse(response)).toBe(true);
    expect(response).toMatchObject(vector.expected);
  }
  expect(validateRequest({ ...request(), protocol: "wrong" })).toBe(false);
  expect(validateRequest({ ...request(), timeoutMs: 0 })).toBe(false);
  await expect(createHostKit(kit)).rejects.toThrow();
});

test("single invocation terminates an unbounded Wasm worker and rejects runtime failures", async () => {
  const { readCapability } = await import("./capability-package");
  const { invokeSnapshot } = await import("./capability-host");
  const { digest } = await import("./wasm-contract");
  const binaryen = (await import("binaryen")).default;
  for (const loop of [true, false]) {
    const snapshot = await readCapability(manifest);
    const module = binaryen.parseText(
      `(module (func (export "evaluate") (param i32 i32) (result i32) ${loop ? "(loop $forever (br $forever))" : ""} (i32.const 2)))`,
    );
    module.addCustomSection(
      "llang.contract",
      new TextEncoder().encode(digest(JSON.stringify(snapshot.build.contract))),
    );
    snapshot.bytes = new Uint8Array(module.emitBinary());
    module.dispose();
    snapshot.build.wasmHash = digest(snapshot.bytes);
    await expect(
      invokeSnapshot(
        snapshot,
        { enabled: true, suspended: false },
        loop ? 100 : 10000,
      ),
    ).rejects.toThrow(loop ? "timed out" : "invalid worker result");
  }
});
