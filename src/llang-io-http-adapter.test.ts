import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { HttpAdapter, LoopbackHttpAdapter } from "./llang-io-http-adapter";

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
    } else if (request.url === "/body-slow") {
      response.writeHead(200);
      response.flushHeaders();
      setTimeout(() => response.end("late-body"), 50);
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
    const slowBody = await adapter.request({
      url: `${origin}/body-slow`,
      method: "GET",
      timeoutMs: 5,
    });
    await expect(adapter.readChunk(slowBody.body)).rejects.toThrow("TIMEOUT");
    await adapter.close(slowBody.body);
    expect(
      adapter.request({ url: "http://example.com/", method: "GET" }),
    ).rejects.toThrow("PERMISSION_DENIED");
  });

  test("pins DNS to a granted address and keeps credentials host-owned", async () => {
    let observedHost = "",
      observedAuthorization = "";
    server = createServer((request, response) => {
      observedHost = request.headers.host ?? "";
      observedAuthorization = request.headers.authorization ?? "";
      response.end("network-ok");
    });
    await new Promise<void>((resolve) =>
      server?.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("server failed");
    const origin = `http://public.example.test:${address.port}`,
      adapter = new HttpAdapter(
        new Set([origin]),
        new Map([[origin, { authorization: "Bearer host-secret" }]]),
        {
          allowPublic: true,
          allowedAddresses: ["127.0.0.1"],
          resolve: async (hostname) => {
            expect(hostname).toBe("public.example.test");
            return [{ address: "127.0.0.1", family: 4 }];
          },
        },
      ),
      response = await adapter.request({ url: `${origin}/`, method: "GET" }),
      chunk = await adapter.readChunk(response.body);
    expect(chunk.bytes.decodeUtf8()).toBe("network-ok");
    expect(observedHost).toBe(`public.example.test:${address.port}`);
    expect(observedAuthorization).toBe("Bearer host-secret");
    await adapter.close(response.body);
    await expect(
      adapter.request({
        url: `${origin}/`,
        method: "GET",
        headers: { authorization: "Bearer program-secret" },
      }),
    ).rejects.toThrow("PERMISSION_DENIED: credential header");
  });

  test("denies private DNS results without an explicit address grant", async () => {
    const adapter = new HttpAdapter(
      new Set(["https://internal.example.test"]),
      new Map(),
      {
        resolve: async () => [{ address: "169.254.169.254", family: 4 }],
      },
    );
    await expect(
      adapter.request({ url: "https://internal.example.test/", method: "GET" }),
    ).rejects.toThrow("PERMISSION_DENIED: address");

    const mapped = new HttpAdapter(
      new Set(["http://mapped.example.test"]),
      new Map(),
      {
        resolve: async () => [{ address: "::ffff:127.0.0.1", family: 6 }],
      },
    );
    await expect(
      mapped.request({ url: "http://mapped.example.test/", method: "GET" }),
    ).rejects.toThrow("PERMISSION_DENIED: address");
  });
});
