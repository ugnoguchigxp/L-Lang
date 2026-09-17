import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { LoopbackHttpAdapter } from "./llang-io-http-adapter";

let server: Server | undefined;
afterEach(
  () =>
    new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve()),
);

const listen = async () => {
  server = createServer((request, response) => {
    if (request.url === "/redirect") {
      response.writeHead(302, { location: "/secret" });
      response.end();
    } else if (request.url === "/slow") {
      setTimeout(() => response.end("late"), 50);
    } else {
      response.writeHead(404, { "x-test": "value" });
      response.end("not-found-body");
    }
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server failed");
  return `http://127.0.0.1:${address.port}`;
};

describe("loopback HTTP effects adapter", () => {
  test("returns HTTP errors as responses and pulls the body", async () => {
    const origin = await listen(),
      adapter = new LoopbackHttpAdapter(new Set([origin])),
      response = await adapter.request({
        url: `${origin}/missing`,
        method: "GET",
      });
    expect(response.status).toBe(404);
    let text = "";
    while (true) {
      const chunk = await adapter.readChunk(response.body, 4);
      if (chunk.eof) break;
      text += chunk.bytes.decodeUtf8();
    }
    expect(text).toBe("not-found-body");
    await adapter.close(response.body);
  });

  test("does not follow redirects and distinguishes timeout", async () => {
    const origin = await listen(),
      adapter = new LoopbackHttpAdapter(new Set([origin])),
      redirect = await adapter.request({
        url: `${origin}/redirect`,
        method: "GET",
      });
    expect(redirect.status).toBe(302);
    await adapter.close(redirect.body);
    expect(
      adapter.request({ url: `${origin}/slow`, method: "GET", timeoutMs: 5 }),
    ).rejects.toThrow("TIMEOUT");
    expect(
      adapter.request({ url: "http://example.com/", method: "GET" }),
    ).rejects.toThrow("PERMISSION_DENIED");
  });
});
