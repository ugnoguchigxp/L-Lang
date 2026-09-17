import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { canonicalJson } from "../../src/hybrid-artifact-values";
import { compileWorldClock, type CompiledWorldClock } from "./compiler";

const directory = import.meta.dir;

export interface WorldClockDemo {
  artifact: CompiledWorldClock;
  fetch(request: Request): Promise<Response>;
}

export async function createWorldClockDemo(): Promise<WorldClockDemo> {
  const [requestText, html, css, browserBuild] = await Promise.all([
    readFile(resolve(directory, "request.json"), "utf8"),
    readFile(resolve(directory, "index.html"), "utf8"),
    readFile(resolve(directory, "styles.css"), "utf8"),
    Bun.build({
      entrypoints: [resolve(directory, "app.ts")],
      target: "browser",
      minify: true,
      sourcemap: "none",
    }),
  ]);
  if (!browserBuild.success || browserBuild.outputs.length !== 1) {
    throw new Error("could not build browser application");
  }
  const browserJavaScript = await browserBuild.outputs[0]?.text();
  if (browserJavaScript === undefined) {
    throw new Error("browser application output is missing");
  }
  const artifact = compileWorldClock(JSON.parse(requestText));
  return {
    artifact,
    async fetch(request: Request): Promise<Response> {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("method not allowed\n", {
          status: 405,
          headers: { Allow: "GET, HEAD" },
        });
      }
      const path = new URL(request.url).pathname;
      const response = route(path, {
        html,
        css,
        browserJavaScript,
        artifact,
      });
      return request.method === "HEAD"
        ? new Response(null, {
            status: response.status,
            headers: response.headers,
          })
        : response;
    },
  };
}

function route(
  path: string,
  content: {
    html: string;
    css: string;
    browserJavaScript: string;
    artifact: CompiledWorldClock;
  },
): Response {
  const headers = { "Cache-Control": "no-store" };
  if (path === "/") {
    return new Response(content.html, {
      headers: { ...headers, "Content-Type": "text/html; charset=utf-8" },
    });
  }
  if (path === "/styles.css") {
    return new Response(content.css, {
      headers: { ...headers, "Content-Type": "text/css; charset=utf-8" },
    });
  }
  if (path === "/app.js") {
    return new Response(content.browserJavaScript, {
      headers: {
        ...headers,
        "Content-Type": "text/javascript; charset=utf-8",
      },
    });
  }
  if (path === "/capability.json") {
    return new Response(canonicalJson(content.artifact.manifest), {
      headers: {
        ...headers,
        "Content-Type": "application/json; charset=utf-8",
      },
    });
  }
  if (path === "/world-clock.wasm") {
    const wasm = new Uint8Array(content.artifact.wasm.byteLength);
    wasm.set(content.artifact.wasm);
    return new Response(wasm.buffer, {
      headers: { ...headers, "Content-Type": "application/wasm" },
    });
  }
  return new Response("not found\n", { status: 404, headers });
}

function demoPort(value: string | undefined): number {
  if (value === undefined) return 4173;
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("WORLD_CLOCK_PORT must be an integer from 1 to 65535");
  }
  return port;
}

if (import.meta.main) {
  const demo = await createWorldClockDemo();
  const port = demoPort(process.env.WORLD_CLOCK_PORT);
  Bun.serve({ port, fetch: demo.fetch });
  console.log(`SAAA World Clock: http://localhost:${port}`);
  console.log(
    `${demo.artifact.manifest.profile} · ${demo.artifact.manifest.wasmBytes} bytes · ${demo.artifact.manifest.wasmHash.slice(0, 12)}`,
  );
}
