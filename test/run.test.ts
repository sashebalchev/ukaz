import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { lastLines, runCommand } from "../src/run.ts";

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
    assert.deepEqual(passed, { exitCode: 0, timedOut: false, leftRunning: false, notStopped: false, output: "" });
    assert.ok(readFileSync(join(folder, "here.txt"), "utf8").trim().endsWith(folder.split("/").pop() ?? ""));

    const failed = await runCommand("exit 7", folder, 10);
    assert.equal(failed.exitCode, 7);
    assert.equal(failed.timedOut, false);
  });
});

test("everything it printed comes back, from both streams, in order", async () => {
  await inFolder(async (folder) => {
    const run = await runCommand("for n in $(seq 1 40); do echo line $n; done; echo the end >&2", folder, 10);
    assert.equal(run.output.split("\n").length, 42);
    const lines = lastLines(run.output, 15).split("\n");
    assert.equal(lines.length, 15);
    assert.equal(lines[0], "line 27");
    assert.equal(lines[14], "the end");
  });
});

test("at the time limit the command is stopped and reported as timed out", async () => {
  await inFolder(async (folder) => {
    const started = Date.now();
    const run = await runCommand("echo before; sleep 30; echo after", folder, 1);
    assert.deepEqual(run, { exitCode: null, timedOut: true, leftRunning: false, notStopped: false, output: "before\n" });
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

// True while the process exists. A killed process may take a moment to go, so this looks for a while.
async function staysAlive(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      process.kill(pid, 0);
    } catch {
      return false;
    }
    await new Promise<void>((wake) => setTimeout(() => wake(), 50));
  }
  process.kill(pid, "SIGKILL");
  return true;
}

test("what a command leaves running is stopped and reported, also outside its process group", async () => {
  const detach =
    'const child = require("node:child_process").spawn("sleep", ["300"], { detached: true, stdio: "ignore" });' +
    'require("node:fs").writeFileSync("started.pid", String(child.pid)); child.unref();';
  const commands = ["sleep 300 & echo $! > started.pid", `'${process.execPath}' -e '${detach}'`];
  for (const command of commands) {
    await inFolder(async (folder) => {
      const run = await runCommand(command, folder, 10);
      assert.equal(run.exitCode, 0);
      assert.equal(run.leftRunning, true, command);
      assert.equal(run.notStopped, false);
      const pid = Number(readFileSync(join(folder, "started.pid"), "utf8"));
      assert.equal(await staysAlive(pid), false, "the process that was left running must be gone");
    });
  }
});

test("a run inside a run keeps the outer marker, so the outer run still finds what the inner one left", async () => {
  await inFolder(async (folder) => {
    const environment = join(folder, "environment.txt");
    const run = await runCommand(`env > '${environment}'`, folder, 10);
    assert.equal(run.exitCode, 0);
    const markers = readFileSync(environment, "utf8").split("\n").filter((line) => line.startsWith("LAWS_RUN_"));
    assert.equal(markers.length, 1 + Object.keys(process.env).filter((name) => name.startsWith("LAWS_RUN_")).length);
    rmSync(environment);
  });
});
