// @ts-nocheck -- llang:effects is a compiler-owned operation interface.
import { defineEffects, invoke } from "llang:effects";

export const definition = defineEffects({
  module: "examples/typescript-async",
  operations: [
    {
      id: "host.echo",
      version: 1,
      requestType: "string",
      responseType: "string",
      errorType: { code: "string" },
      effect: "host",
      resource: "none",
      cancellable: true,
      idempotent: true,
    },
  ],
});

export async function main(): Promise<string> {
  const message: string = "ready";
  await invoke<string>("host.echo", 1, message);
  const reply: string = await invoke<string>("host.echo", 1, "done");
  return reply;
}
