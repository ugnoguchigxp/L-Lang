import { runHostRequest } from "./capability-host";

// One process, one bounded JSON request. Candidate path is supplied only by the host argv.
if (import.meta.main) {
  try {
    if (process.argv.length !== 3) throw new Error("expected manifest path");
    const reader = Bun.stdin.stream().getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 64 * 1024) {
        await reader.cancel();
        throw new Error("stdin exceeds 64 KiB");
      }
      chunks.push(value);
    }
    const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const response = JSON.stringify(
      await runHostRequest(process.argv[2] as string, request),
    );
    if (Buffer.byteLength(response) > 1024 * 1024)
      throw new Error("stdout exceeds 1 MiB");
    process.stdout.write(`${response}\n`);
  } catch {
    process.stderr.write("Invalid host transport input or output\n");
    process.exitCode = 2;
  }
}
