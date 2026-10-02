import { join, resolve } from "node:path";
import { readCollectionModuleBuildManifest } from "../../../src/llang-module-collection-build";
import { digest } from "../../../src/wasm-contract";
import { readGridConfig } from "./config";

/** Serve shared templates directly; dist contains only compiled artifacts. */
export async function createGridApp(
  appDir: string,
  buildDir = join(appDir, "dist"),
) {
  const root = resolve(appDir);
  await readGridConfig(root);
  const saved = await readCollectionModuleBuildManifest(
    join(buildDir, "module-build.json"),
  );
  const wasm = saved.manifest.wasm;
  if (!wasm || saved.manifest.targets.join() !== "wasm")
    throw new Error("Native Wasm build required");
  const provenance = await Bun.file(join(buildDir, "provenance.json")).json();
  const names = [
    "prompt.md",
    "app.json",
    "style.css",
    "game.semantic.llang.jsonc",
    "tests.semantic.llang.jsonc",
  ];
  if (
    provenance.format !== "semantic-grid-provenance" ||
    provenance.version !== 1 ||
    !provenance.sourceHashes ||
    Object.keys(provenance.sourceHashes).sort().join() !==
      [...names].sort().join()
  )
    throw new Error("Invalid build provenance");
  const sourceBytes = new Map<string, Uint8Array>();
  for (const name of names) {
    const bytes = new Uint8Array(
      await Bun.file(join(root, name)).arrayBuffer(),
    );
    if (digest(bytes) !== provenance.sourceHashes[name])
      throw new Error(`Changed source: ${name}. Rebuild the app.`);
    sourceBytes.set(name, bytes);
  }
  if (
    saved.manifest.sources.length !== 1 ||
    saved.manifest.sources[0]?.path !== "game.semantic.llang.jsonc" ||
    saved.manifest.sources[0].hash !==
      provenance.sourceHashes["game.semantic.llang.jsonc"]
  )
    throw new Error("SemanticIR and game Wasm differ");
  const files = new Map<string, { body: Uint8Array; type: string }>();
  for (const [route, name, type] of [
    ["/", "index.html", "text/html"],
    ["/index.html", "index.html", "text/html"],
    ["/browser.js", "browser.js", "text/javascript"],
    ["/timer.js", "timer.js", "text/javascript"],
    ["/wasm-runtime.js", "wasm-runtime.js", "text/javascript"],
    ["/template.css", "template.css", "text/css"],
  ] as const)
    files.set(route, {
      body: new Uint8Array(
        await Bun.file(join(import.meta.dir, name)).arrayBuffer(),
      ),
      type,
    });
  for (const [route, name, type] of [
    ["/app.json", "app.json", "application/json"],
    ["/style.css", "style.css", "text/css"],
    ["/semantic-ir.json", "game.semantic.llang.jsonc", "application/json"],
    ["/test-ir.json", "tests.semantic.llang.jsonc", "application/json"],
    ["/prompt.md", "prompt.md", "text/plain"],
  ] as const)
    files.set(route, { body: sourceBytes.get(name) as Uint8Array, type });
  files.set("/module-build.json", {
    body: new TextEncoder().encode(JSON.stringify(saved.manifest)),
    type: "application/json",
  });
  files.set("/program.wasm", {
    body: saved.artifactBytes.get(wasm.path) as Uint8Array,
    type: "application/wasm",
  });
  return async (request: Request): Promise<Response> => {
    const file = files.get(new URL(request.url).pathname);
    const headers = { "cache-control": "no-store" };
    if (!file) return new Response("Not Found", { status: 404, headers });
    if (request.method !== "GET" && request.method !== "HEAD")
      return new Response("Method Not Allowed", {
        status: 405,
        headers: { ...headers, allow: "GET, HEAD" },
      });
    return new Response(
      request.method === "HEAD" ? null : file.body.slice().buffer,
      {
        headers: {
          ...headers,
          "content-type":
            file.type === "application/wasm"
              ? file.type
              : `${file.type}; charset=utf-8`,
        },
      },
    );
  };
}
if (import.meta.main) {
  const appDir = process.argv[2];
  if (!appDir)
    throw new Error(
      "Pass examples/<app>; build it first with the shared build.ts",
    );
  const port = Number(process.env.PORT ?? "4175");
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Invalid PORT");
  Bun.serve({
    hostname: "127.0.0.1",
    port,
    fetch: await createGridApp(resolve(appDir)),
  });
  console.log(`Grid app: http://127.0.0.1:${port}`);
}
