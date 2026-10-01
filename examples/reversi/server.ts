import { join } from "node:path";
import { readCollectionModuleBuildManifest } from "../../src/llang-module-collection-build";
import { digest } from "../../src/wasm-contract";

export async function createReversiDemo(
  options: { buildDir?: string } = {},
): Promise<(request: Request) => Promise<Response>> {
  const root = options.buildDir ?? join(import.meta.dir, "dist");
  let saved: Awaited<ReturnType<typeof readCollectionModuleBuildManifest>>;
  try {
    saved = await readCollectionModuleBuildManifest(
      join(root, "module-build.json"),
    );
  } catch (cause) {
    throw new Error(
      "Wasm成果物を読み込めません。bun run reversi:build で再生成してください。",
      { cause },
    );
  }
  const wasm = saved.manifest.wasm,
    bytes = wasm && saved.artifactBytes.get(wasm.path);
  if (!wasm || !bytes)
    throw new Error(
      "Wasm成果物がありません。bun run reversi:build を実行してください。",
    );
  const assets = [
    ["/", "browser/index.html", "text/html"],
    ["/index.html", "browser/index.html", "text/html"],
    ["/style.css", "browser/style.css", "text/css"],
    ["/bridge.js", "browser/bridge.js", "text/javascript"],
    ["/wasm-runtime.js", "browser/wasm-runtime.js", "text/javascript"],
    ["/module-build.json", "module-build.json", "application/json"],
    ["/semantic-ir.json", "semantic-ir.json", "application/json"],
    ["/semantic-request.json", "semantic-request.json", "application/json"],
  ] as const;
  const files = new Map<string, { body: Uint8Array; type: string }>([
    ["/program.wasm", { body: bytes, type: "application/wasm" }],
  ]);
  for (const [path, file, type] of assets)
    files.set(path, {
      body: new Uint8Array(await Bun.file(join(root, file)).arrayBuffer()),
      type: `${type}; charset=utf-8`,
    });
  const ir = files.get("/semantic-ir.json");
  if (
    !ir ||
    saved.manifest.sources.length !== 1 ||
    saved.manifest.sources[0]?.path !== "reversi.semantic.llang.jsonc" ||
    digest(ir.body) !== saved.manifest.sources[0].hash
  )
    throw new Error(
      "保存したSemantic IRとWasmのビルド情報が一致しません。bun run reversi:build を実行してください。",
    );
  return async (request) => {
    const file = files.get(new URL(request.url).pathname),
      headers = { "cache-control": "no-store" };
    if (!file) return new Response("Not Found", { status: 404, headers });
    if (request.method !== "GET" && request.method !== "HEAD")
      return new Response("Method Not Allowed", {
        status: 405,
        headers: { ...headers, allow: "GET, HEAD" },
      });
    return new Response(
      request.method === "HEAD" ? null : file.body.slice().buffer,
      {
        headers: { ...headers, "content-type": file.type },
      },
    );
  };
}
if (import.meta.main) {
  const port = Number(process.env.PORT ?? "4174");
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("PORT must be 1..65535");
  const fetch = await createReversiDemo();
  Bun.serve({ port, hostname: "127.0.0.1", fetch });
  console.log(`月夜のリバーシ: http://127.0.0.1:${port}`);
}
