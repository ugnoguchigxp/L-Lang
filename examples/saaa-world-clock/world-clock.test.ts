import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { compileWorldClock, parseWorldClockRequest } from "./compiler";
import { createWorldClockDemo } from "./server";

const requestPath = resolve(import.meta.dir, "request.json");

async function requestFixture(): Promise<unknown> {
  return JSON.parse(await readFile(requestPath, "utf8"));
}

describe("SAAA World Clock Wasm demo", () => {
  test("compiles the request deterministically into a closed Wasm ABI", async () => {
    const request = await requestFixture();
    const first = compileWorldClock(request);
    const second = compileWorldClock(request);

    expect(first.manifest).toEqual(second.manifest);
    expect(first.wasm).toEqual(second.wasm);
    expect(first.manifest).toMatchObject({
      version: 1,
      profile: "world-clock-i32-v1",
      compiler: "l-lang-world-clock-demo@1",
      request: { title: "Orbit Clock" },
    });
    expect(first.manifest.requestHash).toMatch(/^[a-f0-9]{64}$/);
    expect(first.manifest.wasmHash).toMatch(/^[a-f0-9]{64}$/);
    expect(WebAssembly.validate(first.wasm)).toBe(true);

    const wasmBytes = new Uint8Array(first.wasm.byteLength);
    wasmBytes.set(first.wasm);
    const module = new WebAssembly.Module(wasmBytes.buffer);
    expect(WebAssembly.Module.imports(module)).toEqual([]);
    expect(WebAssembly.Module.exports(module)).toEqual([
      { name: "abi_version", kind: "function" },
      { name: "local_seconds", kind: "function" },
      { name: "day_delta", kind: "function" },
    ]);
  });

  test("computes local time and date boundaries in Wasm", async () => {
    const artifact = compileWorldClock(await requestFixture());
    const wasmBytes = new Uint8Array(artifact.wasm.byteLength);
    wasmBytes.set(artifact.wasm);
    const instantiated = await WebAssembly.instantiate(wasmBytes.buffer, {});
    const wasm = instantiated.instance.exports as {
      abi_version(): number;
      local_seconds(utcSeconds: number, offsetMinutes: number): number;
      day_delta(utcSeconds: number, offsetMinutes: number): number;
    };

    expect(wasm.abi_version()).toBe(1);
    expect(wasm.local_seconds(23 * 3_600 + 30 * 60, 9 * 60)).toBe(
      8 * 3_600 + 30 * 60,
    );
    expect(wasm.day_delta(23 * 3_600 + 30 * 60, 9 * 60)).toBe(1);
    expect(wasm.local_seconds(15 * 60, -5 * 60)).toBe(19 * 3_600 + 15 * 60);
    expect(wasm.day_delta(15 * 60, -5 * 60)).toBe(-1);
    expect(wasm.local_seconds(12 * 3_600, 0)).toBe(12 * 3_600);
    expect(wasm.day_delta(12 * 3_600, 0)).toBe(0);
  });

  test("serves the UI, generated manifest, and valid Wasm without an API", async () => {
    const demo = await createWorldClockDemo();
    const html = await demo.fetch(new Request("http://demo.local/"));
    expect(html.status).toBe(200);
    expect(html.headers.get("content-type")).toContain("text/html");
    expect(await html.text()).toContain("SAAA GENERATED CAPABILITY");

    const capability = await demo.fetch(
      new Request("http://demo.local/capability.json"),
    );
    const capabilityJson = (await capability.json()) as {
      profile: string;
      request: { cities: Array<{ timeZone: string }> };
    };
    expect(capabilityJson.profile).toBe("world-clock-i32-v1");
    expect(
      capabilityJson.request.cities.some(
        ({ timeZone }) => timeZone === "Asia/Tokyo",
      ),
    ).toBe(true);

    const wasm = await demo.fetch(
      new Request("http://demo.local/world-clock.wasm"),
    );
    expect(wasm.headers.get("content-type")).toBe("application/wasm");
    expect(WebAssembly.validate(await wasm.arrayBuffer())).toBe(true);

    const app = await demo.fetch(new Request("http://demo.local/app.js"));
    expect(app.headers.get("content-type")).toContain("text/javascript");
    expect((await app.text()).length).toBeGreaterThan(1_000);
    expect(
      (await demo.fetch(new Request("http://demo.local/missing"))).status,
    ).toBe(404);
  });

  test("rejects ambiguous or unsafe generated requests", async () => {
    const request = (await requestFixture()) as Record<string, unknown>;
    expect(() => parseWorldClockRequest({ ...request, extra: true })).toThrow(
      "must contain exactly",
    );
    expect(() =>
      parseWorldClockRequest({
        ...request,
        accent: "#12GG00",
      }),
    ).toThrow("six-digit hex color");
    expect(() =>
      parseWorldClockRequest({
        ...request,
        cities: [
          { id: "bad", label: "Bad", timeZone: "Not/AZone", group: "X" },
        ],
      }),
    ).toThrow("timeZone is invalid");
  });
});
