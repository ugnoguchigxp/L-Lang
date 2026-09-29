import {
  lstat,
  open,
  readFile,
  realpath,
  stat,
  unlink,
} from "node:fs/promises";
import { resolve } from "node:path";
import { withStudyRunLock, type StudyLockIO } from "./paper-study-lock";
import { publishInputSnapshot } from "./paper-study-inputs";
import { resumeStudy, runStudy } from "./paper-study";

const [mode, runDir] = process.argv.slice(2);
if (!mode || !runDir) throw new Error("test child arguments missing");
const ready = () => process.stdout.write("READY\n");
async function release() {
  let input = "";
  for await (const chunk of process.stdin) {
    input += String(chunk);
    if (input.includes("GO\n")) return;
  }
  throw new Error("test child release missing");
}
try {
  if (mode === "lock-hold") {
    await withStudyRunLock(runDir, async () => {
      ready();
      await release();
    });
  } else if (mode === "lock-probe") {
    await withStudyRunLock(runDir, async () => {
      ready();
    });
  } else if (mode === "resume-hold") {
    let signalled = false;
    await resumeStudy(runDir, {
      beforeTrial: async () => {
        if (!signalled) {
          signalled = true;
          ready();
          await release();
        }
      },
    });
  } else if (mode === "resume") {
    await resumeStudy(runDir);
  } else if (mode === "run-hold-publish") {
    await runStudy(
      resolve("research/paper-v1/study-draft.json"),
      "fixture",
      runDir,
      undefined,
      {
        publishInputs: async (path, snapshot) => {
          ready();
          await release();
          await publishInputSnapshot(path, snapshot);
        },
      },
    );
  } else if (mode === "prewrite-hold") {
    const io: StudyLockIO = {
      realpath,
      stat,
      lstat,
      readFile,
      unlink,
      open: async (...args) => {
        const handle = await open(...args);
        ready();
        await release();
        return handle;
      },
    };
    await withStudyRunLock(runDir, async () => {}, io);
  } else throw new Error("unknown test child mode");
  process.stdout.write("DONE\n");
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 2;
}
