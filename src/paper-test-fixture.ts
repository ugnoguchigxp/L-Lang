import { resolve } from "node:path";
import {
  developCapability,
  fixtureConfig,
  fixtureDevelopmentAgent,
} from "./capability-development";
import { readJson } from "./prompt-source";

export async function createPaperTestRun(outDir: string) {
  const root = resolve("examples/capability-development/access");
  return developCapability(
    await readJson(resolve(root, "source.json")),
    await readJson(resolve(root, "metadata.json")),
    fixtureConfig,
    fixtureDevelopmentAgent(
      await readJson(resolve(root, "responses.fixture.json")),
    ),
    outDir,
  );
}
