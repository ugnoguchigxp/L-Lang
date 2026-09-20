import { afterEach, describe, expect, test } from "bun:test";
import {
  cp,
  link,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { executeLlangCli } from "./llang-cli";
import { BoundedPullStream } from "./llang-effects-concurrency";
import { readVerifiedEffectsExecutionSnapshot } from "./llang-effects-bundle-inspection";
import { executeEffectsModuleBundle } from "./llang-effects-execution-evidence";
import { recoverEffectsExecution } from "./llang-effects-execution-recovery";
import { parseEffectsExecutionGrant } from "./llang-effects-execution-grant";
import { buildEffectsModuleProgram } from "./llang-module-effects-build";
import { LBytes } from "./llang-effects-values";
import {
  EFFECTS_TRANSCRIPT_GENESIS,
  EffectsTranscriptWriter,
  parseEffectsTranscript,
} from "./llang-effects-transcript-writer";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "llang-effects-evidence-"));
  roots.push(root);
  const source = join(root, "main.llang.jsonc"),
    bundle = join(root, "bundle"),
    manifestPath = join(bundle, "module-build.json");
  await writeFile(
    source,
    JSON.stringify({
      language: "l-lang",
      version: 5,
      kind: "module",
      profile: "module-effects-v1",
      module: "evidence/main",
      entry: "main",
      imports: [],
      operations: [
        {
          id: "host.echo",
          version: 1,
          requestType: "string",
          responseType: "i64",
          errorType: { code: "string" },
          effect: "host",
          resource: "none",
          cancellable: true,
          idempotent: true,
        },
      ],
      resultType: "i64",
      nodes: [
        {
          kind: "await",
          operation: "host.echo",
          version: 1,
          request: "secret-payload",
        },
      ],
    }),
  );
  await buildEffectsModuleProgram({
    entry: "main.llang.jsonc",
    root,
    entryName: "main",
    target: "all",
    outDir: bundle,
  });
  const snapshot = await readVerifiedEffectsExecutionSnapshot(manifestPath),
    grantPath = join(root, "grant.json"),
    grant = {
      format: "llang-effects-grant",
      version: 1,
      bundleIdentityHash: snapshot.bundleIdentityHash,
      operations: ["host.echo@1"],
      file: null,
      http: null,
      wallClock: false,
      deadlineMs: 30_000,
      limits: {},
    };
  await writeFile(grantPath, JSON.stringify(grant));
  return { root, manifestPath, grantPath, grant };
}

async function fileFixture() {
  const root = await mkdtemp(join(tmpdir(), "llang-effects-file-evidence-"));
  roots.push(root);
  const source = join(root, "main.llang.jsonc"),
    bundle = join(root, "bundle"),
    sandbox = join(root, "sandbox"),
    manifestPath = join(bundle, "module-build.json");
  await mkdir(sandbox);
  await writeFile(join(sandbox, "input.bin"), "private-body");
  await writeFile(
    source,
    JSON.stringify({
      language: "l-lang",
      version: 5,
      kind: "module",
      profile: "module-effects-v1",
      module: "evidence/file",
      entry: "main",
      imports: [],
      operations: [],
      resultType: "bytes",
      nodes: [{ kind: "file", action: "read", path: "input.bin" }],
    }),
  );
  await buildEffectsModuleProgram({
    entry: "main.llang.jsonc",
    root,
    entryName: "main",
    target: "all",
    outDir: bundle,
  });
  const snapshot = await readVerifiedEffectsExecutionSnapshot(manifestPath),
    grantPath = join(root, "grant.json");
  await writeFile(
    grantPath,
    JSON.stringify({
      format: "llang-effects-grant",
      version: 1,
      bundleIdentityHash: snapshot.bundleIdentityHash,
      operations: ["file.read@1"],
      file: {
        adapterRoot: "./sandbox",
        logicalRoots: ["input.bin"],
        read: true,
        write: false,
        replace: false,
      },
      http: null,
      wallClock: false,
      deadlineMs: 30_000,
      limits: {},
    }),
  );
  return { root, manifestPath, grantPath };
}

async function fileWriteFixture(preexisting = false) {
  const root = await mkdtemp(join(tmpdir(), "llang-effects-write-evidence-"));
  roots.push(root);
  const source = join(root, "main.llang.jsonc"),
    bundle = join(root, "bundle"),
    sandbox = join(root, "sandbox"),
    manifestPath = join(bundle, "module-build.json");
  await mkdir(sandbox);
  if (preexisting) await writeFile(join(sandbox, "output.bin"), "original");
  await writeFile(
    source,
    JSON.stringify({
      language: "l-lang",
      version: 5,
      kind: "module",
      profile: "module-effects-v1",
      module: "evidence/write",
      entry: "main",
      imports: [],
      operations: [],
      resultType: "i64",
      nodes: [
        {
          kind: "file",
          action: "write",
          path: "output.bin",
          bytes: { bytes: "d3JpdHRlbg==" },
          replace: false,
        },
      ],
    }),
  );
  await buildEffectsModuleProgram({
    entry: "main.llang.jsonc",
    root,
    entryName: "main",
    target: "all",
    outDir: bundle,
  });
  const snapshot = await readVerifiedEffectsExecutionSnapshot(manifestPath),
    grantPath = join(root, "grant.json");
  await writeFile(
    grantPath,
    JSON.stringify({
      format: "llang-effects-grant",
      version: 1,
      bundleIdentityHash: snapshot.bundleIdentityHash,
      operations: ["file.write@1"],
      file: {
        adapterRoot: "./sandbox",
        logicalRoots: ["output.bin"],
        read: false,
        write: true,
        replace: false,
      },
      http: null,
      wallClock: false,
      deadlineMs: 30_000,
      limits: {},
    }),
  );
  return { root, source, bundle, sandbox, manifestPath, grantPath };
}

async function httpFixture(url: string) {
  const root = await mkdtemp(join(tmpdir(), "llang-effects-http-evidence-"));
  roots.push(root);
  const source = join(root, "main.llang.jsonc"),
    bundle = join(root, "bundle"),
    manifestPath = join(bundle, "module-build.json");
  await writeFile(
    source,
    JSON.stringify({
      language: "l-lang",
      version: 5,
      kind: "module",
      profile: "module-effects-v1",
      module: "evidence/http",
      entry: "main",
      imports: [],
      operations: [],
      resultType: "bytes",
      nodes: [
        {
          kind: "http",
          url,
          method: "POST",
          headers: { "x-program": "program-header-secret" },
          body: { bytes: "cHJvZ3JhbS1ib2R5LXNlY3JldA==" },
        },
      ],
    }),
  );
  await buildEffectsModuleProgram({
    entry: "main.llang.jsonc",
    root,
    entryName: "main",
    target: "all",
    outDir: bundle,
  });
  const snapshot = await readVerifiedEffectsExecutionSnapshot(manifestPath),
    grantPath = join(root, "grant.json"),
    credentialPath = join(root, "credentials.json"),
    origin = new URL(url).origin;
  await writeFile(
    grantPath,
    JSON.stringify({
      format: "llang-effects-grant",
      version: 1,
      bundleIdentityHash: snapshot.bundleIdentityHash,
      operations: ["http.request@1"],
      file: null,
      http: {
        origins: [origin],
        methods: ["POST"],
        requestHeaders: ["x-program"],
        allowPublic: false,
        allowedAddresses: ["127.0.0.1"],
      },
      wallClock: false,
      deadlineMs: 30_000,
      limits: {},
    }),
  );
  await writeFile(
    credentialPath,
    JSON.stringify({
      format: "llang-effects-credential-env",
      version: 1,
      origins: { [origin]: { authorization: "LLANG_TEST_HTTP_TOKEN" } },
    }),
  );
  return { root, manifestPath, grantPath, credentialPath };
}

describe("effects execution evidence", () => {
  test("executes the inspected bundled Wasm and publishes redacted evidence", async () => {
    const item = await fixture(),
      outputDirectory = join(item.root, "evidence"),
      report = await executeEffectsModuleBundle({
        manifestPath: item.manifestPath,
        grantPath: item.grantPath,
        outputDirectory,
        execute: async (operation, request) => {
          expect(operation.id).toBe("host.echo");
          expect(request).toBe("secret-payload");
          return 42n;
        },
      });
    expect(report).toMatchObject({
      format: "llang-effects-execution",
      version: 1,
      status: "completed",
      result: { status: "completed", certainty: "known" },
      authenticity: { attestation: "not-signed", retention: "caller-managed" },
    });
    const transcript = await readFile(
        join(outputDirectory, "effects-transcript.jsonl"),
        "utf8",
      ),
      saved = JSON.parse(
        await readFile(join(outputDirectory, "effects-execution.json"), "utf8"),
      );
    expect(transcript).not.toContain("secret-payload");
    expect(parseEffectsTranscript(transcript)).toHaveLength(3);
    expect(saved.authenticity.evidenceHash).toBe(
      (report.authenticity as { evidenceHash: string }).evidenceHash,
    );
    await expect(
      readFile(join(outputDirectory, "execution.lock")),
    ).rejects.toThrow();
  });

  test("rejects non-canonical and over-budget grants", () => {
    const valid = {
      format: "llang-effects-grant",
      version: 1,
      bundleIdentityHash: "a".repeat(64),
      operations: ["host.z@1", "host.a@1"],
      file: null,
      http: null,
      wallClock: false,
      deadlineMs: 1,
      limits: {},
    };
    expect(() => parseEffectsExecutionGrant(valid)).toThrow(
      "INVALID_EFFECTS_GRANT",
    );
    expect(() =>
      parseEffectsExecutionGrant({
        ...valid,
        operations: ["host.a@1"],
        limits: { hostRequests: 1_025 },
      }),
    ).toThrow("INVALID_EFFECTS_GRANT_LIMIT");
  });

  test("rejects missing and extra grant operations before dispatch", async () => {
    for (const operations of [[], ["host.echo@1", "host.extra@1"]]) {
      const item = await fixture(),
        output = join(item.root, `operation-mismatch-${operations.length}`);
      await writeFile(
        item.grantPath,
        JSON.stringify({ ...item.grant, operations }),
      );
      let dispatches = 0;
      await expect(
        executeEffectsModuleBundle({
          manifestPath: item.manifestPath,
          grantPath: item.grantPath,
          outputDirectory: output,
          execute: async () => {
            dispatches += 1;
            return 42n;
          },
        }),
      ).rejects.toThrow("EFFECTS_GRANT_OPERATION_MISMATCH");
      expect(dispatches).toBe(0);
      await expect(readFile(output)).rejects.toThrow();
    }
  });

  test("detects transcript mutation", () => {
    expect(EFFECTS_TRANSCRIPT_GENESIS).toHaveLength(64);
    expect(() =>
      parseEffectsTranscript(
        `${JSON.stringify({
          sequence: 1,
          kind: "terminal",
          previousHash: EFFECTS_TRANSCRIPT_GENESIS,
          eventHash: "0".repeat(64),
        })}\n`,
      ),
    ).toThrow("INVALID_EFFECTS_TRANSCRIPT_CHAIN");
  });

  test("exposes strict CLI execution options", async () => {
    const item = await fixture();
    expect(
      await executeLlangCli([
        "module",
        "execute",
        item.manifestPath,
        "--grant",
        item.grantPath,
        "--out-dir",
        join(item.root, "cli-evidence"),
        "--json",
      ]),
    ).toMatchObject({ exitCode: 1, output: { status: "failed" } });
    expect(
      await executeLlangCli([
        "module",
        "execute",
        item.manifestPath,
        "--grant",
        item.grantPath,
        "--bad",
        "x",
        "--json",
      ]),
    ).toMatchObject({ exitCode: 2, output: { ok: false } });
  });

  test("executes built-in file IO through the CLI without recording contents", async () => {
    const item = await fileFixture(),
      output = join(item.root, "file-evidence"),
      result = await executeLlangCli([
        "module",
        "execute",
        item.manifestPath,
        "--grant",
        item.grantPath,
        "--out-dir",
        output,
        "--json",
      ]);
    expect(result).toMatchObject({
      exitCode: 0,
      output: { status: "completed" },
    });
    const transcript = await readFile(
      join(output, "effects-transcript.jsonl"),
      "utf8",
    );
    expect(transcript).toContain("file:<redacted>");
    expect(transcript).not.toContain("private-body");
    expect(transcript).not.toContain(join(item.root, "sandbox"));
  });

  test("executes a relocated bundle after source deletion without leaking paths", async () => {
    const item = await fixture(),
      relocated = join(item.root, "relocated"),
      output = join(item.root, "relocated-evidence");
    await cp(join(item.root, "bundle"), relocated, { recursive: true });
    await rm(join(item.root, "bundle"), { recursive: true });
    await rm(join(item.root, "main.llang.jsonc"));
    const report = await executeEffectsModuleBundle({
      manifestPath: join(relocated, "module-build.json"),
      grantPath: item.grantPath,
      outputDirectory: output,
      execute: async () => 42n,
    });
    expect(report.status).toBe("completed");
    const evidence = `${await readFile(
      join(output, "execution-intent.json"),
      "utf8",
    )}${await readFile(join(output, "effects-transcript.jsonl"), "utf8")}${await readFile(
      join(output, "effects-execution.json"),
      "utf8",
    )}`;
    expect(evidence).not.toContain(item.root);
    expect(evidence).not.toContain(relocated);
  });

  test("records file write commit and abort without damaging existing data", async () => {
    const success = await fileWriteFixture(),
      successOutput = join(success.root, "evidence");
    expect(
      await executeLlangCli([
        "module",
        "execute",
        success.manifestPath,
        "--grant",
        success.grantPath,
        "--out-dir",
        successOutput,
        "--json",
      ]),
    ).toMatchObject({ exitCode: 0, output: { status: "completed" } });
    expect(await readFile(join(success.sandbox, "output.bin"), "utf8")).toBe(
      "written",
    );
    expect(
      parseEffectsTranscript(
        await readFile(join(successOutput, "effects-transcript.jsonl"), "utf8"),
      ).find((event) => event.kind === "cleanup"),
    ).toMatchObject({ cleanupAction: "commit", outcome: { code: "ok" } });

    const failure = await fileWriteFixture(true),
      failureOutput = join(failure.root, "evidence");
    expect(
      await executeLlangCli([
        "module",
        "execute",
        failure.manifestPath,
        "--grant",
        failure.grantPath,
        "--out-dir",
        failureOutput,
        "--json",
      ]),
    ).toMatchObject({ exitCode: 1, output: { status: "failed" } });
    expect(await readFile(join(failure.sandbox, "output.bin"), "utf8")).toBe(
      "original",
    );
    expect(
      parseEffectsTranscript(
        await readFile(join(failureOutput, "effects-transcript.jsonl"), "utf8"),
      ).find((event) => event.kind === "cleanup"),
    ).toMatchObject({ cleanupAction: "abort", outcome: { code: "ok" } });
  });

  test("rejects a multiply-linked grant before creating evidence", async () => {
    const item = await fixture(),
      alias = join(item.root, "grant-alias.json"),
      output = join(item.root, "hardlink-evidence");
    await link(item.grantPath, alias);
    await expect(
      executeEffectsModuleBundle({
        manifestPath: item.manifestPath,
        grantPath: alias,
        outputDirectory: output,
        execute: async () => 42n,
      }),
    ).rejects.toThrow("INVALID_EFFECTS_GRANT_FILE");
    await expect(readFile(output)).rejects.toThrow();
  });

  test("rejects a requirement contract inside its writable file grant", async () => {
    const item = await fileWriteFixture(),
      snapshot = await readVerifiedEffectsExecutionSnapshot(item.manifestPath),
      requirementsPath = join(item.sandbox, "requirements.json"),
      output = join(item.root, "requirements-overlap-evidence"),
      requirements = {
        format: "llang-effects-requirements",
        version: 1,
        id: "protected-requirements",
        revision: 1,
        body: "The program must not be able to replace this contract.",
        bundleIdentityHash: snapshot.bundleIdentityHash,
        requirements: [
          {
            id: "write",
            level: "must",
            statement: "Run the declared write operation.",
            verification: "structure",
          },
        ],
        bindings: [
          {
            requirementId: "write",
            nodes: [0],
            operations: ["file.write@1"],
            authorityRules: [],
            terminalStatuses: [],
          },
        ],
        authorityCeiling: {
          operations: ["file.write@1"],
          file: {
            logicalRoots: ["requirements.json"],
            read: false,
            write: true,
            replace: true,
          },
          http: null,
          wallClock: false,
          deadlineMs: 30_000,
          limits: {},
        },
        expectedTerminalStatuses: ["completed"],
      };
    await writeFile(requirementsPath, JSON.stringify(requirements));
    await writeFile(
      item.grantPath,
      JSON.stringify({
        format: "llang-effects-grant",
        version: 1,
        bundleIdentityHash: snapshot.bundleIdentityHash,
        operations: ["file.write@1"],
        file: {
          adapterRoot: "./sandbox",
          logicalRoots: ["requirements.json"],
          read: false,
          write: true,
          replace: true,
        },
        http: null,
        wallClock: false,
        deadlineMs: 30_000,
        limits: {},
      }),
    );
    await expect(
      executeEffectsModuleBundle({
        manifestPath: item.manifestPath,
        grantPath: item.grantPath,
        requirementsPath,
        outputDirectory: output,
      }),
    ).rejects.toThrow("REQUIREMENTS_INSIDE_WRITABLE_FILE_GRANT");
    await expect(readFile(output)).rejects.toThrow();
  });

  test("records an ignored host cancellation as an unknown timeout", async () => {
    const item = await fixture(),
      grant = { ...item.grant, deadlineMs: 1 };
    await writeFile(item.grantPath, JSON.stringify(grant));
    const report = await executeEffectsModuleBundle({
      manifestPath: item.manifestPath,
      grantPath: item.grantPath,
      outputDirectory: join(item.root, "timeout-evidence"),
      execute: async () => new Promise(() => undefined),
    });
    expect(report).toMatchObject({
      status: "cancelled",
      result: {
        status: "cancelled",
        errorCode: "timeout",
        certainty: "unknown",
      },
    });
  });

  test("stops before dispatch and reports the resource limit", async () => {
    const item = await fixture(),
      grant = { ...item.grant, limits: { hostRequests: 0 } };
    await writeFile(item.grantPath, JSON.stringify(grant));
    let dispatches = 0;
    const report = await executeEffectsModuleBundle({
      manifestPath: item.manifestPath,
      grantPath: item.grantPath,
      outputDirectory: join(item.root, "limited-evidence"),
      execute: async () => {
        dispatches += 1;
        return 42n;
      },
    });
    expect(dispatches).toBe(0);
    expect(report).toMatchObject({
      status: "failed",
      result: {
        status: "failed",
        errorCode: "resource-limit",
        certainty: "known",
      },
      resource: {
        limits: { hostRequests: 0 },
        used: { hostRequests: 0 },
        peak: { hostRequests: 0 },
        unreleased: {},
      },
    });
  });

  test("injects HTTP credentials without recording secrets, paths, or bodies", async () => {
    let observedAuthorization = "";
    const server = createServer((request, response) => {
      observedAuthorization = String(request.headers.authorization ?? "");
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.end("response-body-secret");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("TEST_SERVER");
      const item = await httpFixture(
          `http://127.0.0.1:${address.port}/private/path?token=query-secret`,
        ),
        output = join(item.root, "http-evidence");
      process.env.LLANG_TEST_HTTP_TOKEN = "credential-value-secret";
      const result = await executeLlangCli([
        "module",
        "execute",
        item.manifestPath,
        "--grant",
        item.grantPath,
        "--out-dir",
        output,
        "--credential-env",
        item.credentialPath,
        "--json",
      ]);
      expect(result).toMatchObject({
        exitCode: 0,
        output: { status: "completed" },
      });
      expect(observedAuthorization).toBe("credential-value-secret");
      const allEvidence = `${await readFile(
        join(output, "execution-intent.json"),
        "utf8",
      )}${await readFile(join(output, "effects-transcript.jsonl"), "utf8")}${await readFile(
        join(output, "effects-execution.json"),
        "utf8",
      )}`;
      for (const secret of [
        "credential-value-secret",
        "LLANG_TEST_HTTP_TOKEN",
        "/private/path",
        "query-secret",
        "program-header-secret",
        "program-body-secret",
        "response-body-secret",
      ])
        expect(allEvidence).not.toContain(secret);
    } finally {
      delete process.env.LLANG_TEST_HTTP_TOKEN;
      server.close();
      await once(server, "close");
    }
  });

  test("recovers pending requests as unknown without replay", async () => {
    const root = await mkdtemp(join(tmpdir(), "llang-effects-recovery-"));
    roots.push(root);
    await writeFile(
      join(root, "execution-intent.json"),
      JSON.stringify({
        format: "llang-effects-execution-intent",
        version: 1,
        executionId: "recovery-fixture",
        bundleIdentityHash: "a".repeat(64),
        grantSourceHash: "b".repeat(64),
        grantCommitmentHash: "c".repeat(64),
        bundledWasmHash: "d".repeat(64),
        startedAt: 1,
        deadlineMs: 30_000,
        credentialInjection: "not-needed",
        credentialHeaderNames: [],
      }),
    );
    await writeFile(
      join(root, "execution.lock"),
      JSON.stringify({
        format: "llang-effects-execution-lock",
        version: 1,
        executionId: "recovery-fixture",
        ownerToken: "owner-secret",
        pid: 2_147_483_647,
        startedAt: 1,
      }),
    );
    const writer = await EffectsTranscriptWriter.create(
      join(root, "effects-transcript.jsonl"),
    );
    await writer.append({
      kind: "request",
      requestId: "1:1:0",
      state: 0,
      operation: "host.echo@1",
      payloadHash: "e".repeat(64),
      bytes: 4,
    });
    await writer.close();
    const report = await recoverEffectsExecution(root);
    expect(report).toMatchObject({
      status: "incomplete",
      recovered: true,
      recovery: { replayedOperations: 0 },
      result: {
        certainty: "unknown",
        pendingRequests: [
          {
            requestId: "1:1:0",
            operation: "host.echo@1",
            certainty: "unknown",
          },
        ],
      },
    });
    const text = await readFile(join(root, "effects-execution.json"), "utf8");
    expect(text).not.toContain("owner-secret");
    await expect(readFile(join(root, "execution.lock"))).rejects.toThrow();
  });

  test("recovers a real child-process crash after request without replay", async () => {
    const item = await fixture(),
      output = join(item.root, "crash-evidence"),
      counter = join(item.root, "dispatch-count.txt"),
      child = Bun.spawn(
        [
          process.execPath,
          join(import.meta.dir, "llang-effects-execution-crash-fixture.ts"),
          item.manifestPath,
          item.grantPath,
          output,
          counter,
        ],
        { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" },
      );
    const [exitCode, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
    ]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toBe("");
    expect(await readFile(counter, "utf8")).toBe("1");
    const report = await recoverEffectsExecution(output);
    expect(report).toMatchObject({
      status: "incomplete",
      recovery: { replayedOperations: 0 },
      result: {
        certainty: "unknown",
        pendingRequests: [{ operation: "host.echo@1", certainty: "unknown" }],
      },
    });
    expect(await readFile(counter, "utf8")).toBe("1");
  });

  test("records task children and stream chunks with cleanup", async () => {
    const root = await mkdtemp(join(tmpdir(), "llang-effects-task-stream-"));
    roots.push(root);
    const source = join(root, "main.llang.jsonc"),
      bundle = join(root, "bundle"),
      manifestPath = join(bundle, "module-build.json");
    await writeFile(
      source,
      JSON.stringify({
        language: "l-lang",
        version: 5,
        kind: "module",
        profile: "module-effects-v1",
        module: "evidence/task-stream",
        entry: "main",
        imports: [],
        operations: [
          {
            id: "host.echo",
            version: 1,
            requestType: "i64",
            responseType: "i64",
            errorType: { code: "string" },
            effect: "host",
            resource: "none",
            cancellable: true,
            idempotent: true,
          },
          {
            id: "host.pull",
            version: 1,
            requestType: "i32",
            responseType: "bytes",
            errorType: { code: "string" },
            effect: "host",
            resource: "stream",
            cancellable: true,
            idempotent: true,
          },
        ],
        resultType: "bytes",
        nodes: [
          {
            kind: "task",
            tasks: [
              {
                kind: "await",
                operation: "host.echo",
                version: 1,
                request: { i64: "1" },
              },
              {
                kind: "await",
                operation: "host.echo",
                version: 1,
                request: { i64: "2" },
              },
            ],
          },
          {
            kind: "stream",
            operation: "host.pull",
            version: 1,
            request: 64,
            maximumChunks: 2,
          },
        ],
      }),
    );
    await buildEffectsModuleProgram({
      entry: "main.llang.jsonc",
      root,
      entryName: "main",
      target: "all",
      outDir: bundle,
    });
    const snapshot = await readVerifiedEffectsExecutionSnapshot(manifestPath),
      grantPath = join(root, "grant.json"),
      output = join(root, "evidence");
    await writeFile(
      grantPath,
      JSON.stringify({
        format: "llang-effects-grant",
        version: 1,
        bundleIdentityHash: snapshot.bundleIdentityHash,
        operations: ["host.echo@1", "host.pull@1"],
        file: null,
        http: null,
        wallClock: false,
        deadlineMs: 30_000,
        limits: {},
      }),
    );
    const chunks = [LBytes.from([1]), LBytes.from([2])];
    const report = await executeEffectsModuleBundle({
      manifestPath,
      grantPath,
      outputDirectory: output,
      execute: async (_operation, request) => request,
      openStream: async () =>
        new BoundedPullStream(
          async () =>
            chunks.length
              ? { eof: false, bytes: chunks.shift() as LBytes }
              : { eof: true },
          () => undefined,
        ),
    });
    expect(report.status).toBe("completed");
    const events = parseEffectsTranscript(
      await readFile(join(output, "effects-transcript.jsonl"), "utf8"),
    );
    expect(events.filter((event) => event.kind === "request")).toHaveLength(3);
    expect(
      events.filter((event) => event.kind === "stream-chunk"),
    ).toHaveLength(3);
    expect(events.filter((event) => event.kind === "cleanup")).toHaveLength(1);
    expect(events.find((event) => event.kind === "cleanup")).toMatchObject({
      cleanupAction: "cancel",
    });
    const childIds = events
      .filter((event) => event.operation === "host.echo@1")
      .map((event) => event.requestId);
    expect(new Set(childIds).size).toBe(2);
  });

  test("rejects an evidence directory inside the file adapter root", async () => {
    const item = await fileFixture(),
      output = join(item.root, "sandbox", "evidence");
    await expect(
      executeEffectsModuleBundle({
        manifestPath: item.manifestPath,
        grantPath: item.grantPath,
        outputDirectory: output,
      }),
    ).rejects.toThrow("EVIDENCE_OVERLAPS_FILE_ROOT");
    await expect(readFile(output)).rejects.toThrow();
  });

  test("fails the published report if the bundle changes during execution", async () => {
    const item = await fixture(),
      output = join(item.root, "changed-bundle-evidence"),
      report = await executeEffectsModuleBundle({
        manifestPath: item.manifestPath,
        grantPath: item.grantPath,
        outputDirectory: output,
        execute: async () => {
          const manifest = JSON.parse(
            await readFile(item.manifestPath, "utf8"),
          );
          manifest.entry = "changed#entry";
          await writeFile(item.manifestPath, JSON.stringify(manifest));
          return 42n;
        },
      });
    expect(report).toMatchObject({
      status: "failed",
      bundle: { bundleChangedAfterStart: true },
      result: { status: "failed", errorCode: "bundle-changed" },
    });
    const events = parseEffectsTranscript(
      await readFile(join(output, "effects-transcript.jsonl"), "utf8"),
    );
    expect(events.at(-1)).toMatchObject({
      kind: "terminal",
      outcome: { code: "failed" },
    });
  });

  test("fails the published report if the grant changes during execution", async () => {
    const item = await fixture(),
      output = join(item.root, "changed-grant-evidence"),
      report = await executeEffectsModuleBundle({
        manifestPath: item.manifestPath,
        grantPath: item.grantPath,
        outputDirectory: output,
        execute: async () => {
          await writeFile(
            item.grantPath,
            JSON.stringify({ ...item.grant, deadlineMs: 29_999 }),
          );
          return 42n;
        },
      });
    expect(report).toMatchObject({
      status: "failed",
      grant: { changedAfterStart: true },
      result: { status: "failed", errorCode: "grant-changed" },
    });
    const events = parseEffectsTranscript(
      await readFile(join(output, "effects-transcript.jsonl"), "utf8"),
    );
    expect(events.at(-1)).toMatchObject({
      kind: "terminal",
      outcome: { code: "failed" },
    });
  });

  test("fails closed if the evidence directory is replaced during execution", async () => {
    const item = await fixture(),
      output = join(item.root, "replaced-evidence"),
      displaced = join(item.root, "displaced-evidence"),
      sentinel = join(output, "owned-by-other.txt");
    await expect(
      executeEffectsModuleBundle({
        manifestPath: item.manifestPath,
        grantPath: item.grantPath,
        outputDirectory: output,
        execute: async () => {
          await rename(output, displaced);
          await mkdir(output);
          await writeFile(sentinel, "keep");
          return 42n;
        },
      }),
    ).rejects.toThrow();
    expect(await readFile(sentinel, "utf8")).toBe("keep");
    await expect(
      readFile(join(output, "effects-execution.json")),
    ).rejects.toThrow();
  });
});
