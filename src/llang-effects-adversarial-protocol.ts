import { resolve } from "node:path";
import { decodeUtf8, parseStrictJsonObject } from "./llang-jsonc";
import { readStableRegularFileSnapshot } from "./llang-effects-stable-file";
import { fingerprintFor, sha256 } from "./stable-hash";

const HASH = /^[0-9a-f]{64}$/;
const ID = /^[a-z][a-z0-9]*(?:[._/-][a-z0-9]+)*$/;
const CATEGORIES = [
  "instruction-in-data",
  "path-escalation",
  "endpoint-escalation",
  "credential-steering",
  "unauthorized-exfiltration",
  "write-escalation",
  "resource-pressure",
  "malformed-data",
  "generated-defect",
] as const;
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length &&
  Object.keys(value).every((key) => keys.includes(key));

export type EffectsAdversarialProtocol = Readonly<{
  format: "llang-effects-adversarial-protocol";
  version: 1;
  id: string;
  revision: number;
  evidenceEligible: false;
  datasetHash: string;
  shared: Readonly<{
    inputHash: string;
    grantHash: string;
    oracleHash: string;
    timeoutMs: number;
    memoryBytes: number;
    apiCallLimit: 0;
  }>;
  arms: readonly [
    Readonly<{ id: "llang"; hostProfile: string }>,
    Readonly<{ id: "typescript"; hostProfile: string }>,
  ];
  cases: readonly Readonly<{
    id: string;
    category: (typeof CATEGORIES)[number];
    normal: boolean;
    expectTaskCompleted: boolean;
    expectViolationBlocked: boolean;
  }>[];
}>;

export function parseEffectsAdversarialProtocol(
  value: unknown,
): EffectsAdversarialProtocol {
  if (
    !object(value) ||
    !exact(value, [
      "format",
      "version",
      "id",
      "revision",
      "evidenceEligible",
      "datasetHash",
      "shared",
      "arms",
      "cases",
    ]) ||
    value.format !== "llang-effects-adversarial-protocol" ||
    value.version !== 1 ||
    typeof value.id !== "string" ||
    !ID.test(value.id) ||
    !Number.isSafeInteger(value.revision) ||
    Number(value.revision) < 1 ||
    value.evidenceEligible !== false ||
    typeof value.datasetHash !== "string" ||
    !HASH.test(value.datasetHash) ||
    !object(value.shared) ||
    !exact(value.shared, [
      "inputHash",
      "grantHash",
      "oracleHash",
      "timeoutMs",
      "memoryBytes",
      "apiCallLimit",
    ]) ||
    ![
      value.shared.inputHash,
      value.shared.grantHash,
      value.shared.oracleHash,
    ].every((hash) => typeof hash === "string" && HASH.test(hash)) ||
    !Number.isSafeInteger(value.shared.timeoutMs) ||
    Number(value.shared.timeoutMs) < 1 ||
    !Number.isSafeInteger(value.shared.memoryBytes) ||
    Number(value.shared.memoryBytes) < 1 ||
    value.shared.apiCallLimit !== 0 ||
    !Array.isArray(value.arms) ||
    value.arms.length !== 2 ||
    !Array.isArray(value.cases) ||
    !value.cases.length ||
    value.cases.length > 256
  )
    throw new Error("INVALID_EFFECTS_ADVERSARIAL_PROTOCOL");
  const arms = value.arms.map((arm) => {
    if (
      !object(arm) ||
      !exact(arm, ["id", "hostProfile"]) ||
      !["llang", "typescript"].includes(String(arm.id)) ||
      typeof arm.hostProfile !== "string" ||
      !ID.test(arm.hostProfile)
    )
      throw new Error("INVALID_EFFECTS_ADVERSARIAL_PROTOCOL");
    return Object.freeze({
      id: arm.id as "llang" | "typescript",
      hostProfile: arm.hostProfile,
    });
  });
  if (
    arms[0]?.id !== "llang" ||
    arms[1]?.id !== "typescript" ||
    arms[0].hostProfile !== arms[1].hostProfile
  )
    throw new Error("UNFAIR_EFFECTS_ADVERSARIAL_BASELINE");
  const cases = value.cases.map((item) => {
    if (
      !object(item) ||
      !exact(item, [
        "id",
        "category",
        "normal",
        "expectTaskCompleted",
        "expectViolationBlocked",
      ]) ||
      typeof item.id !== "string" ||
      !ID.test(item.id) ||
      !CATEGORIES.includes(item.category as (typeof CATEGORIES)[number]) ||
      typeof item.normal !== "boolean" ||
      typeof item.expectTaskCompleted !== "boolean" ||
      typeof item.expectViolationBlocked !== "boolean"
    )
      throw new Error("INVALID_EFFECTS_ADVERSARIAL_PROTOCOL");
    return Object.freeze({
      id: item.id,
      category: item.category as (typeof CATEGORIES)[number],
      normal: item.normal,
      expectTaskCompleted: item.expectTaskCompleted,
      expectViolationBlocked: item.expectViolationBlocked,
    });
  });
  if (
    cases.map(({ id }) => id).join("\0") !==
      [...new Set(cases.map(({ id }) => id))].sort().join("\0") ||
    !CATEGORIES.every((category) =>
      cases.some((item) => item.category === category),
    ) ||
    value.datasetHash !== fingerprintFor(cases) ||
    value.shared.inputHash !==
      fingerprintFor(
        cases.map(({ id, category, normal }) => ({ id, category, normal })),
      ) ||
    value.shared.oracleHash !==
      fingerprintFor(
        cases.map(({ id, expectTaskCompleted, expectViolationBlocked }) => ({
          id,
          expectTaskCompleted,
          expectViolationBlocked,
        })),
      ) ||
    value.shared.grantHash !==
      fingerprintFor({
        hostProfile: arms[0].hostProfile,
        timeoutMs: Number(value.shared.timeoutMs),
        memoryBytes: Number(value.shared.memoryBytes),
        apiCallLimit: 0,
      })
  )
    throw new Error("EFFECTS_ADVERSARIAL_PROTOCOL_FREEZE_MISMATCH");
  return Object.freeze({
    format: "llang-effects-adversarial-protocol",
    version: 1,
    id: value.id,
    revision: Number(value.revision),
    evidenceEligible: false,
    datasetHash: value.datasetHash,
    shared: Object.freeze({
      inputHash: String(value.shared.inputHash),
      grantHash: String(value.shared.grantHash),
      oracleHash: String(value.shared.oracleHash),
      timeoutMs: Number(value.shared.timeoutMs),
      memoryBytes: Number(value.shared.memoryBytes),
      apiCallLimit: 0,
    }),
    arms: Object.freeze(arms) as EffectsAdversarialProtocol["arms"],
    cases: Object.freeze(cases),
  });
}

export async function readEffectsAdversarialProtocol(file: string) {
  const absolute = resolve(file),
    snapshot = await readStableRegularFileSnapshot(
      absolute,
      1024 * 1024,
      "INVALID_EFFECTS_ADVERSARIAL_PROTOCOL_FILE",
    ),
    document = parseEffectsAdversarialProtocol(
      parseStrictJsonObject(decodeUtf8(snapshot.bytes, absolute), absolute),
    );
  return Object.freeze({
    path: absolute,
    sourceHash: sha256(snapshot.bytes),
    freezeHash: fingerprintFor(document),
    document,
  });
}

export function evaluateEffectsAdversarialFixture(
  protocol: EffectsAdversarialProtocol,
  observations: readonly Readonly<{
    arm: "llang" | "typescript";
    caseId: string;
    taskCompleted: boolean;
    violationBlocked: boolean;
    incomplete: boolean;
  }>[],
) {
  const expected = protocol.arms.flatMap((arm) =>
      protocol.cases.map((item) => `${arm.id}\0${item.id}`),
    ),
    actual = observations.map((item) => `${item.arm}\0${item.caseId}`);
  if (
    actual.length !== expected.length ||
    [...actual].sort().join("\0") !== [...expected].sort().join("\0") ||
    new Set(actual).size !== actual.length
  )
    throw new Error("INCOMPLETE_EFFECTS_ADVERSARIAL_RESULTS");
  const caseMap = new Map(protocol.cases.map((item) => [item.id, item])),
    arms = protocol.arms.map((arm) => {
      const items = observations.filter((item) => item.arm === arm.id);
      return Object.freeze({
        id: arm.id,
        normalCompletion: items.filter(
          (item) => caseMap.get(item.caseId)?.normal && item.taskCompleted,
        ).length,
        prohibitedBlocked: items.filter(
          (item) =>
            caseMap.get(item.caseId)?.expectViolationBlocked &&
            item.violationBlocked,
        ).length,
        falseRejections: items.filter(
          (item) => caseMap.get(item.caseId)?.normal && !item.taskCompleted,
        ).length,
        incomplete: items.filter((item) => item.incomplete).length,
        oracleMismatches: items.filter((item) => {
          const expectedCase = caseMap.get(item.caseId);
          return (
            !expectedCase ||
            item.taskCompleted !== expectedCase.expectTaskCompleted ||
            item.violationBlocked !== expectedCase.expectViolationBlocked
          );
        }).length,
      });
    });
  return Object.freeze({
    format: "llang-effects-adversarial-fixture-result",
    version: 1,
    protocolHash: fingerprintFor(protocol),
    evidenceEligible: false,
    humanEvaluation: "not-run",
    liveEvaluation: "not-run",
    apiCalls: 0,
    arms: Object.freeze(arms),
  });
}
