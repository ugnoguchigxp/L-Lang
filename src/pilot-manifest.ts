import { readFile, realpath } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

import { atomicWriteJson } from "./atomic-file";
import { resolveContainedFile } from "./contained-path";
import {
  assertPilotReviewApproved,
  type PilotFreeze,
  type PilotManifest,
  type PilotReview,
  parsePilotFreeze,
  parsePilotManifest,
  parsePilotReview,
} from "./pilot-manifest-parser";
import { sha256 } from "./semantic-fingerprint";
import {
  parseBoundedJsonText,
  readBoundedJsonFile,
  SEMANTIC_LIMITS,
} from "./semantic-limits";

export {
  assertPilotReviewApproved,
  type PilotCase,
  type PilotFreeze,
  type PilotManifest,
  type PilotReview,
  parsePilotFreeze,
  parsePilotManifest,
  parsePilotReview,
} from "./pilot-manifest-parser";

export type PilotProtocol = {
  directory: string;
  manifestPath: string;
  manifest: PilotManifest;
  manifestHash: string;
  freezePath: string;
  freeze: PilotFreeze;
  reviewPath: string;
  review: PilotReview;
  reviewHash: string;
};

export async function readPilotProtocol(
  manifestPathInput: string,
): Promise<PilotProtocol> {
  const manifestPath = await realpath(resolve(manifestPathInput));
  const directory = dirname(manifestPath);
  const manifestData = await readFile(manifestPath);
  if (manifestData.byteLength > SEMANTIC_LIMITS.externalJsonBytes) {
    throw new Error("pilot manifest exceeds input budget");
  }
  const manifest = parsePilotManifest(
    parseBoundedJsonText(
      manifestData.toString("utf8"),
      "pilot manifest",
      SEMANTIC_LIMITS.externalJsonBytes,
    ),
  );
  const freezePath = await pilotFile(
    directory,
    manifest.freeze,
    "pilot freeze",
  );
  const freeze = parsePilotFreeze(
    await readBoundedJsonFile(freezePath, "pilot freeze"),
  );
  const reviewPath = await pilotFile(
    directory,
    manifest.review,
    "pilot review",
  );
  const reviewData = await readFile(reviewPath);
  const review = parsePilotReview(
    parseBoundedJsonText(reviewData.toString("utf8"), "pilot review"),
  );
  const required = requiredPilotFiles(manifest, basename(manifestPath));
  const frozen = Object.keys(freeze.files).sort();
  if (
    required.length !== frozen.length ||
    required.some((file, index) => file !== frozen[index])
  ) {
    throw new Error("pilot freeze files must exactly match manifest inputs");
  }
  for (const [file, expectedHash] of Object.entries(freeze.files)) {
    const absolute = await pilotFile(directory, file, `pilot input ${file}`);
    const data = await readFile(absolute);
    if (data.byteLength > SEMANTIC_LIMITS.externalJsonBytes) {
      throw new Error(`pilot input ${file} exceeds input budget`);
    }
    if (sha256(data) !== expectedHash) {
      throw new Error(`pilot frozen input changed: ${file}`);
    }
  }
  return {
    directory,
    manifestPath,
    manifest,
    manifestHash: sha256(manifestData),
    freezePath,
    freeze,
    reviewPath,
    review,
    reviewHash: sha256(reviewData),
  };
}

export async function readPilotFrozenJson(
  protocol: PilotProtocol,
  file: string,
  label: string,
): Promise<unknown> {
  const expectedHash = protocol.freeze.files[file];
  if (expectedHash === undefined) {
    throw new Error(`${label} is not part of the frozen Pilot input`);
  }
  const absolute = await pilotFile(protocol.directory, file, label);
  const data = await readFile(absolute);
  if (sha256(data) !== expectedHash) {
    throw new Error(`${label} changed after protocol verification`);
  }
  return parseBoundedJsonText(
    data.toString("utf8"),
    label,
    SEMANTIC_LIMITS.externalJsonBytes,
  );
}

export async function writePilotFreeze(input: {
  manifestPath: string;
  status: PilotFreeze["status"];
  instructions?: string;
}): Promise<{ path: string; files: Record<string, string> }> {
  const manifestPath = await realpath(resolve(input.manifestPath));
  const directory = dirname(manifestPath);
  const manifestData = await readFile(manifestPath);
  const manifest = parsePilotManifest(
    parseBoundedJsonText(manifestData.toString("utf8"), "pilot manifest"),
  );
  if (input.status === "frozen" || input.status === "completed") {
    const reviewPath = await pilotFile(
      directory,
      manifest.review,
      "pilot review",
    );
    const review = parsePilotReview(
      await readBoundedJsonFile(reviewPath, "pilot review"),
    );
    assertPilotReviewApproved(review, manifest);
  }
  const files: Record<string, string> = {};
  for (const file of requiredPilotFiles(manifest, basename(manifestPath))) {
    const absolute = await pilotFile(directory, file, `pilot input ${file}`);
    files[file] = sha256(await readFile(absolute));
  }
  const freezePath = resolve(directory, manifest.freeze);
  const freeze: PilotFreeze = {
    version: 1,
    status: input.status,
    instructions:
      input.instructions ??
      "Do not change frozen Pilot input after observing model output.",
    files,
  };
  await atomicWriteJson(freezePath, freeze);
  return { path: freezePath, files };
}

export function assertPilotFrozen(freeze: PilotFreeze): void {
  if (freeze.status !== "frozen") {
    throw new Error("Pilot inputs must be frozen before live execution");
  }
}

export function requiredPilotFiles(
  manifest: PilotManifest,
  manifestFile = "manifest.json",
): string[] {
  return [
    manifestFile,
    manifest.review,
    ...manifest.projectFiles,
    ...manifest.cases.flatMap((entry) => [
      entry.source,
      entry.baseline,
      entry.hiddenCases,
      entry.schemaEvolutionSource,
      entry.fixture,
    ]),
  ]
    .filter((file, index, files) => files.indexOf(file) === index)
    .sort();
}

function pilotFile(
  directory: string,
  file: string,
  label: string,
): Promise<string> {
  return resolveContainedFile(directory, file, label, {
    containmentLabel: "Pilot directory",
  });
}
