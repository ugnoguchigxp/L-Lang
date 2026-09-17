import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  parseLlangRequest,
  parseLlangSuite,
  requestRevision,
} from "./llang-capability";
import { contentHash } from "./prompt-source";

export async function createLlangCapabilityFixture(roots: string[]) {
  const root = await mkdtemp(resolve(tmpdir(), "llang-v2-"));
  roots.push(root);
  const source = resolve(
    process.cwd(),
    "examples/jsonc-enabled-user/enabled-user.llang.jsonc",
  );
  const contract = JSON.parse(
    (await readFile(source, "utf8"))
      .replace(/\/\/.*$/gm, "")
      .replace(/,\s*([}\]])/g, "$1"),
  ).contract;
  const request = parseLlangRequest({
    version: 2,
    id: "enabled-user",
    body: "enabledかつsuspendedでない利用者だけを許可する。",
    profile: "predicate-i32-v1",
    contract,
    requirements: [
      { id: "enabled", level: "must", text: "enabledであること" },
      {
        id: "not-suspended",
        level: "must-not",
        text: "suspendedを許可しないこと",
      },
    ],
  });
  const suite = parseLlangSuite(
    {
      version: 2,
      requestRevision: requestRevision(request),
      contractHash: contentHash(contract),
      cases: [
        {
          id: "accept",
          requirementIds: ["enabled", "not-suspended"],
          input: { enabled: true, suspended: false },
          undefinedFields: [],
          expected: { kind: "value", value: true },
        },
        {
          id: "disabled",
          requirementIds: ["enabled"],
          input: { enabled: false, suspended: false },
          undefinedFields: [],
          expected: { kind: "value", value: false },
        },
        {
          id: "suspended",
          requirementIds: ["not-suspended"],
          input: { enabled: true, suspended: true },
          undefinedFields: [],
          expected: { kind: "value", value: false },
        },
      ],
    },
    request,
  );
  const requestPath = resolve(root, "request.json"),
    suitePath = resolve(root, "tests.json"),
    metadataPath = resolve(root, "metadata.json");
  const metadata = {
    id: "enabled-user",
    release: "v2",
    purpose: "受付可否",
    useWhen: "利用者受付時",
    doNotUseWhen: "外部状態が必要な場合",
  };
  await writeFile(requestPath, JSON.stringify(request));
  await writeFile(suitePath, JSON.stringify(suite));
  await writeFile(metadataPath, JSON.stringify(metadata));
  return {
    root,
    source,
    request,
    suite,
    requestPath,
    suitePath,
    metadataPath,
    metadata,
  };
}
