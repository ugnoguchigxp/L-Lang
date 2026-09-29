import { expect, test } from "bun:test";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { runPaperCli } from "./paper-cli";
import { loadStudyInputs } from "./paper-study-inputs";
import {
  createStudyReviewTemplate,
  parseStudyReviewRecord,
  verifyStudyReview,
  verifyStudyReviewRecord,
  type StudyReviewRecord,
} from "./paper-study-review";
import { saveStudyReview } from "./paper-study";

const draft = resolve("research/paper-v1/study-draft.json");
const clone = <T>(value: T): T => structuredClone(value);
const template = async () =>
  createStudyReviewTemplate(await loadStudyInputs(draft));
function taskAt(record: StudyReviewRecord, index: number) {
  const task = record.tasks[index];
  if (!task) throw new Error(`test review task ${index} missing`);
  return task;
}
function accept(value: StudyReviewRecord) {
  for (const task of value.tasks) {
    task.sourceAuthors = ["author-source"];
    task.oracleAuthors = ["author-oracle"];
    task.reviewer = "reviewer-independent";
    task.independent = true;
    task.reviewedAt = "2026-09-29T10:11:12.000Z";
    task.recordReference = "review-note-1";
    for (const key of Object.keys(task.checks) as (keyof typeof task.checks)[])
      task.checks[key] = "pass";
  }
  return value;
}
async function copiedStudy(root: string) {
  const study = JSON.parse(await readFile(draft, "utf8"));
  const inputs = resolve(root, "inputs");
  await mkdir(inputs);
  for (const [index, task] of study.tasks.entries())
    for (const kind of ["source", "metadata", "oracle", "fixture"] as const) {
      if (!task[kind]) continue;
      const target = resolve(inputs, `${index}-${kind}.json`);
      await cp(resolve("research/paper-v1", task[kind]), target);
      task[kind] = target;
    }
  const path = resolve(root, "study.json");
  await writeFile(path, JSON.stringify(study));
  return { study, path };
}

test("P7-01/02 current review-study creates an untouched pending template", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "paper-review-template-"));
  try {
    const out = resolve(root, "review");
    const before = await readFile(draft);
    const result = await saveStudyReview(draft, out);
    expect(result.tasks).toHaveLength(4);
    expect((await lstat(resolve(out, "review.json"))).isFile()).toBe(true);
    expect((await lstat(resolve(out, "review.md"))).isFile()).toBe(true);
    const record = parseStudyReviewRecord(
      JSON.parse(
        await readFile(resolve(out, "review-record.template.json"), "utf8"),
      ),
    );
    expect(record.tasks.map((task) => task.taskId)).toEqual([
      "logic",
      "contact",
      "boundary",
      "unsupported",
    ]);
    for (const task of record.tasks) {
      expect(task.sourceAuthors).toBeNull();
      expect(task.oracleAuthors).toBeNull();
      expect(task.reviewer).toBeNull();
      expect(task.independent).toBeNull();
      expect(task.reviewedAt).toBeNull();
      expect(task.recordReference).toBeNull();
      expect(Object.values(task.checks)).toEqual([
        "pending",
        "pending",
        "pending",
        "pending",
        "pending",
      ]);
      expect(task.findings).toEqual([]);
    }
    expect(
      (
        await verifyStudyReview(
          draft,
          resolve(out, "review-record.template.json"),
        )
      ).status,
    ).toBe("pending");
    expect(
      (
        await runPaperCli([
          "verify-study-review",
          "--study",
          draft,
          "--record",
          resolve(out, "review-record.template.json"),
        ])
      ).exitCode,
    ).toBe(1);
    expect(await readFile(draft)).toEqual(before);
    await expect(lstat(resolve(out, "review-record.json"))).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("P7-03/12/17 test-only accepted record is deterministic and does not imply evidence eligibility", async () => {
  const loaded = await loadStudyInputs(draft);
  const record = accept(createStudyReviewTemplate(loaded));
  const first = verifyStudyReviewRecord(record, loaded);
  const second = verifyStudyReviewRecord(record, loaded);
  expect(first).toEqual(second);
  expect(first.status).toBe("accepted");
  expect(first.tasks.map((task) => task.status)).toEqual([
    "accepted",
    "accepted",
    "accepted",
    "accepted",
  ]);
  expect(first.tasks.every((task) => task.reasons.length === 0)).toBe(true);
  expect(first.evidenceEligible).toBe(false);
  const root = await mkdtemp(resolve(tmpdir(), "paper-review-accepted-"));
  try {
    const path = resolve(root, "record.json");
    await writeFile(path, JSON.stringify(record));
    expect(
      (
        await runPaperCli([
          "verify-study-review",
          "--study",
          draft,
          "--record",
          path,
        ])
      ).exitCode,
    ).toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("P7-04/05 failure takes priority; a failed check requires a matching finding", async () => {
  const loaded = await loadStudyInputs(draft);
  const record = createStudyReviewTemplate(loaded);
  taskAt(record, 0).checks.requirements = "fail";
  taskAt(record, 0).findings = [
    { check: "requirements", note: "expected value needs revision" },
  ];
  const result = verifyStudyReviewRecord(record, loaded);
  expect(result.status).toBe("changes-requested");
  expect(result.tasks[0]?.reasons).toContain("checks-failed");
  expect(result.tasks[0]?.reasons).toContain("checks-pending");
  const validRoot = await mkdtemp(resolve(tmpdir(), "paper-review-changes-"));
  try {
    const path = resolve(validRoot, "record.json");
    await writeFile(path, JSON.stringify(record));
    const cli = await runPaperCli([
      "verify-study-review",
      "--study",
      draft,
      "--record",
      path,
    ]);
    expect(cli.exitCode).toBe(1);
    expect(JSON.stringify(cli.result)).toContain("changes-requested");
  } finally {
    await rm(validRoot, { recursive: true, force: true });
  }
  taskAt(record, 0).findings = [];
  expect(() => verifyStudyReviewRecord(record, loaded)).toThrow(
    "lacks a finding",
  );
  const root = await mkdtemp(resolve(tmpdir(), "paper-review-bad-finding-"));
  try {
    const path = resolve(root, "record.json");
    await writeFile(path, JSON.stringify(record));
    await expect(
      runPaperCli(["verify-study-review", "--study", draft, "--record", path]),
    ).rejects.toThrow("lacks a finding");
    const child = Bun.spawnSync([
      process.execPath,
      resolve("src/paper-cli.ts"),
      "verify-study-review",
      "--study",
      draft,
      "--record",
      path,
    ]);
    expect(child.exitCode).toBe(2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("P7-06 reviewer independence is checked against both author lists", async () => {
  const loaded = await loadStudyInputs(draft);
  for (const change of [
    (record: StudyReviewRecord) => {
      taskAt(record, 0).independent = false;
    },
    (record: StudyReviewRecord) => {
      taskAt(record, 0).reviewer = "author-source";
    },
    (record: StudyReviewRecord) => {
      taskAt(record, 0).reviewer = "author-oracle";
    },
  ]) {
    const record = accept(createStudyReviewTemplate(loaded));
    change(record);
    const result = verifyStudyReviewRecord(record, loaded);
    expect(result.status).toBe("changes-requested");
    expect(
      result.tasks[0]?.reasons.some(
        (code) =>
          code === "reviewer-is-author" || code === "independence-declined",
      ),
    ).toBe(true);
  }
});

test("P7-07 every missing declaration is reported even when checks pass", async () => {
  const loaded = await loadStudyInputs(draft);
  const record = accept(createStudyReviewTemplate(loaded));
  const task = taskAt(record, 0);
  task.sourceAuthors = null;
  task.reviewer = null;
  task.independent = null;
  task.reviewedAt = null;
  task.recordReference = null;
  const result = verifyStudyReviewRecord(record, loaded);
  expect(result.status).toBe("pending");
  expect(result.tasks[0]?.reasons).toEqual([
    "authors-missing",
    "independence-unconfirmed",
    "reference-missing",
    "reviewed-at-missing",
    "reviewer-missing",
  ]);
});

test("P7-08 source, metadata, Oracle and fixture changes invalidate the old record", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "paper-review-input-change-"));
  try {
    const { study, path } = await copiedStudy(root);
    const record = createStudyReviewTemplate(await loadStudyInputs(path));
    const recordPath = resolve(root, "record.json");
    await writeFile(recordPath, JSON.stringify(record));
    for (const [kind, change] of [
      [
        "source",
        (value: unknown) => {
          const source = value as { requirements: { text: string }[] };
          const requirement = source.requirements[0];
          if (!requirement) throw new Error("test requirement missing");
          requirement.text += " changed";
        },
      ],
      [
        "metadata",
        (value: unknown) => {
          const metadata = value as { purpose: string };
          metadata.purpose += " changed";
        },
      ],
      [
        "oracle",
        (value: unknown) => {
          const oracle = value as { cases: { expected: { value: boolean } }[] };
          const first = oracle.cases[0];
          if (!first) throw new Error("test Oracle case missing");
          first.expected.value = !first.expected.value;
        },
      ],
      [
        "fixture",
        (value: unknown) => {
          const fixture = value as {
            responses: { reply: { responseId: string } }[];
          };
          const first = fixture.responses[0];
          if (!first) throw new Error("test fixture response missing");
          first.reply.responseId = "changed";
        },
      ],
    ] as const) {
      const input = study.tasks[0][kind];
      const original = await readFile(input);
      const value = JSON.parse(original.toString());
      change(value);
      await writeFile(input, JSON.stringify(value));
      await expect(verifyStudyReview(path, recordPath)).rejects.toThrow();
      await writeFile(input, original);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("P7-09 study review flags, model, budget and paths invalidate the old record", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "paper-review-study-change-"));
  try {
    const { study, path } = await copiedStudy(root);
    const record = createStudyReviewTemplate(await loadStudyInputs(path));
    const recordPath = resolve(root, "record.json");
    await writeFile(recordPath, JSON.stringify(record));
    for (const mutate of [
      (v: typeof study) => {
        v.review = "reviewed";
      },
      (v: typeof study) => {
        v.model = "gpt-5.6-terra";
      },
      (v: typeof study) => {
        v.budget = 12;
      },
      (v: typeof study) => {
        v.tasks[0].source = resolve(root, "other-source.json");
      },
    ]) {
      const changed = clone(study);
      mutate(changed);
      await writeFile(path, JSON.stringify(changed));
      await expect(verifyStudyReview(path, recordPath)).rejects.toThrow();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("P7-10 missing, added, duplicate and reordered tasks are rejected", async () => {
  const loaded = await loadStudyInputs(draft);
  const original = createStudyReviewTemplate(loaded);
  for (const edit of [
    (r: StudyReviewRecord) => {
      r.tasks.pop();
    },
    (r: StudyReviewRecord) => {
      r.tasks.push(clone(taskAt(r, 0)));
      taskAt(r, 4).taskId = "extra";
    },
    (r: StudyReviewRecord) => {
      taskAt(r, 1).taskId = taskAt(r, 0).taskId;
    },
    (r: StudyReviewRecord) => {
      r.tasks.reverse();
    },
  ]) {
    const record = clone(original);
    edit(record);
    expect(() => verifyStudyReviewRecord(record, loaded)).toThrow();
  }
});

test("P7-11 unknown fields, invalid enums, IDs and dates fail strict parsing", async () => {
  const original = await template();
  const mutations: ((value: StudyReviewRecord) => void)[] = [
    (v) => {
      Object.assign(v, { status: "accepted" });
    },
    (v) => {
      delete (v as { format?: string }).format;
    },
    (v) => {
      Object.assign(taskAt(v, 0), { extra: true });
    },
    (v) => {
      Object.assign(taskAt(v, 0).checks, { extra: "pass" });
    },
    (v) => {
      Object.assign(taskAt(v, 0).checks, { requirements: "yes" });
    },
    (v) => {
      Object.assign(taskAt(v, 0), {
        findings: [{ check: "unknown", note: "x" }],
      });
    },
    (v) => {
      taskAt(v, 0).sourceAuthors = [];
    },
    (v) => {
      taskAt(v, 0).sourceAuthors = ["a", "a"];
    },
    (v) => {
      taskAt(v, 0).reviewer = " ";
    },
    (v) => {
      taskAt(v, 0).reviewer = " reviewer";
    },
    (v) => {
      taskAt(v, 0).reviewedAt = "2026-02-30T00:00:00.000Z";
    },
    (v) => {
      taskAt(v, 0).reviewedAt = "2026-09-29T10:11:12Z";
    },
    (v) => {
      Object.assign(taskAt(v, 0), { independent: "true" });
    },
    (v) => {
      taskAt(v, 0).taskId = "bad id";
    },
    (v) => {
      v.inputHashes["unknown:key"] = "0".repeat(64);
    },
  ];
  for (const mutate of mutations) {
    const record = clone(original);
    mutate(record);
    expect(() => parseStudyReviewRecord(record)).toThrow();
  }
});

test("P7-13/14 invalid inputs stop; ordinary draft missing conditions do not", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "paper-review-invalid-input-"));
  try {
    const record = await template();
    const recordPath = resolve(root, "record.json");
    await writeFile(recordPath, JSON.stringify(record));
    expect((await verifyStudyReview(draft, recordPath)).status).toBe("pending");
    const study = JSON.parse(await readFile(draft, "utf8"));
    study.tasks[0].source = "missing-source.json";
    const path = resolve(root, "bad-study.json");
    await writeFile(path, JSON.stringify(study));
    await expect(verifyStudyReview(path, recordPath)).rejects.toThrow();
    await writeFile(path, "{}");
    await expect(verifyStudyReview(path, recordPath)).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("P7-15 verification uses one loaded snapshot and later detects changes", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "paper-review-read-once-"));
  try {
    const { study, path } = await copiedStudy(root);
    const record = createStudyReviewTemplate(await loadStudyInputs(path));
    const recordPath = resolve(root, "record.json");
    await writeFile(recordPath, JSON.stringify(record));
    const source = study.tasks[0].source;
    const first = await verifyStudyReview(path, recordPath, {
      afterInputsLoaded: async () => {
        const value = JSON.parse(await readFile(source, "utf8"));
        value.requirements[0].text += " changed";
        await writeFile(source, JSON.stringify(value));
      },
    });
    expect(first.status).toBe("pending");
    await expect(verifyStudyReview(path, recordPath)).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("P7-16 references remain strings; no network or Wasm execution", async () => {
  const loaded = await loadStudyInputs(draft);
  const record = accept(createStudyReviewTemplate(loaded));
  taskAt(record, 0).recordReference = "https://invalid.example/review";
  taskAt(record, 1).recordReference = "/not/a/real/file";
  const oldFetch = globalThis.fetch;
  const oldCompile = WebAssembly.compile;
  const oldInstantiate = WebAssembly.instantiate;
  let calls = 0;
  try {
    globalThis.fetch = (async () => {
      calls++;
      throw new Error("unexpected fetch");
    }) as unknown as typeof fetch;
    WebAssembly.compile = (async () => {
      calls++;
      throw new Error("unexpected compile");
    }) as typeof WebAssembly.compile;
    WebAssembly.instantiate = (async () => {
      calls++;
      throw new Error("unexpected instantiate");
    }) as typeof WebAssembly.instantiate;
    expect(verifyStudyReviewRecord(record, loaded).status).toBe("accepted");
    expect(calls).toBe(0);
  } finally {
    globalThis.fetch = oldFetch;
    WebAssembly.compile = oldCompile;
    WebAssembly.instantiate = oldInstantiate;
  }
});
