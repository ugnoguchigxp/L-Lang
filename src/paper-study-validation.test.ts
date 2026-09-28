import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  enumerateTrials,
  hashesMatch,
  matchTrials,
  parseStudy,
  parseStudyRun,
} from "./paper-study-validation";

const draft = resolve("research/paper-v1/study-draft.json");
const readDraft = async () => JSON.parse(await readFile(draft, "utf8"));
const hash = "a".repeat(64);

test("P2-01/03/08 study parser retains draft and rejects invalid schema and unsafe IDs", async () => {
  const base = await readDraft();
  expect(parseStudy(base).state).toBe("draft");
  for (const change of [
    (s: any) => {
      s.provider = "direct";
    },
    (s: any) => {
      s.model = "";
    },
    (s: any) => {
      delete s.maxCalls;
    },
    (s: any) => {
      s.maxCalls = -1;
    },
    (s: any) => {
      s.maxCalls = 1.5;
    },
    (s: any) => {
      s.tasks[0].id = "../escape";
    },
    (s: any) => {
      s.tasks[0].review = "approved";
    },
    (s: any) => {
      s.extra = true;
    },
    (s: any) => {
      s.tasks[0].features = [4];
    },
  ]) {
    const value = structuredClone(base);
    change(value);
    expect(() => parseStudy(value)).toThrow();
  }
});

test("P2-04/05 hash sets ignore order but reject missing, extra, and changed entries", () => {
  expect(hashesMatch({ a: hash, b: hash }, { b: hash, a: hash })).toBe(true);
  expect(hashesMatch({ a: hash }, { a: hash, b: hash })).toBe(false);
  expect(hashesMatch({ a: hash, b: hash }, { a: hash })).toBe(false);
  expect(hashesMatch({ a: hash }, { a: "b".repeat(64) })).toBe(false);
});

test("P2-07/10/21 run parser and plan reject duplicate, unknown, oracle and hash mismatch", async () => {
  const study = parseStudy(await readDraft());
  const hashes: Record<string, string> = {};
  for (const task of study.tasks)
    for (const kind of ["source", "metadata", "oracle", "fixture"])
      hashes[`${task.id}:${kind}`] = hash;
  const trials = enumerateTrials(study).map((entry) => ({
    ...entry,
    status: "pending",
    oracleStatus: "not-run",
    sourceHash: hash,
    metadataHash: hash,
    oracleHash: hash,
    fixtureHash: hash,
    development: null,
    calls: 0,
    tokens: 0,
    reason: null,
  }));
  const base = {
    version: 1,
    studyPath: draft,
    studyHash: hash,
    mode: "fixture",
    status: "running",
    approvalHash: null,
    approvalPath: null,
    trials,
  };
  expect(matchTrials(parseStudyRun(base), study, hashes)).toHaveLength(4);
  for (const mutate of [
    (r: any) => {
      r.trials[1] = { ...r.trials[0] };
    },
    (r: any) => {
      r.trials[0].id = "unknown-1";
    },
    (r: any) => {
      r.trials[0].oracleStatus = "pass";
    },
    (r: any) => {
      r.trials[0].oracleHash = "b".repeat(64);
    },
  ]) {
    const value = structuredClone(base);
    mutate(value);
    expect(() => matchTrials(parseStudyRun(value), study, hashes)).toThrow();
  }
  const invalid = structuredClone(base) as any;
  invalid.trials[0].calls = -1;
  expect(() => parseStudyRun(invalid)).toThrow();
});
