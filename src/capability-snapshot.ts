import { readCapability, verifyCapability } from "./capability-package";
import {
  readLlangCapability,
  regularBytes,
} from "./llang-capability-contracts";
import { verifyLlangCapability } from "./llang-capability-verifier";
import { decodeUtf8, parseStrictJsonObject } from "./llang-jsonc";
import { WasmError } from "./wasm-contract";

/** Package version and host protocol version are independent. */
async function packageVersion(path: string) {
  const manifest = parseStrictJsonObject(
    decodeUtf8(await regularBytes(path), path),
    path,
  );
  const version = (manifest as { version?: unknown }).version;
  if (version !== 1 && version !== 2)
    throw new WasmError("INVALID_CAPABILITY", "unsupported package version");
  return version;
}

export async function readCapabilitySnapshot(path: string) {
  if ((await packageVersion(path)) === 2) {
    const snapshot = await readLlangCapability(path);
    return { ...snapshot, source: snapshot.request };
  }
  return readCapability(path);
}

export async function verifyCapabilityPackage(path: string) {
  return (await packageVersion(path)) === 2
    ? verifyLlangCapability(path)
    : verifyCapability(path);
}
