import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runCommand } from "../src/run.ts";

async function inFolder(body: (folder: string) => Promise<void>): Promise<void> {
  const folder = mkdtempSync(join(tmpdir(), "laws-run-test-"));
  try {
    await body(folder);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

test("a command runs in the given folder and its exit code comes back", async () => {
  await inFolder(async (folder) => {
    const passed = await runCommand("pwd > here.txt", folder, 10);
    assert.deepEqual(passed, { exitCode: 0, timedOut: false, leftBehind: false, lastLines: "" });
    assert.ok(readFileSync(join(folder, "here.txt"), "utf8").trim().endsWith(folder.split("/").pop() ?? ""));

    const failed = await runCommand("exit 7", folder, 10);
    assert.equal(failed.exitCode, 7);
    assert.equal(failed.timedOut, false);
  });
});

test("the last 15 lines of what it printed are kept, from both streams, in order", async () => {
  await inFolder(async (folder) => {
    const run = await runCommand("for n in $(seq 1 40); do echo line $n; done; echo the end >&2", folder, 10);
    const lines = run.lastLines.split("\n");
    assert.equal(lines.length, 15);
    assert.equal(lines[0], "line 27");
    assert.equal(lines[14], "the end");
  });
});

test("at the time limit the command is stopped and reported as timed out", async () => {
  await inFolder(async (folder) => {
    const started = Date.now();
    const run = await runCommand("echo before; sleep 30; echo after", folder, 1);
    assert.deepEqual(run, { exitCode: null, timedOut: true, leftBehind: false, lastLines: "before" });
    assert.ok(Date.now() - started < 10_000);
  });
});

test("a command that cannot start is a failure, and no scratch folder stays behind", async () => {
  await inFolder(async (folder) => {
    const missingFolder = await runCommand("true", join(folder, "no-such-folder"), 10);
    assert.notEqual(missingFolder.exitCode, 0);
    const notACommand = await runCommand("no-such-program-anywhere", folder, 10);
    assert.equal(notACommand.exitCode, 127);
    assert.deepEqual(readdirSync(folder), []);
  });
});
