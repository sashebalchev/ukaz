// The check of law T-06 (laws/T-06.md): ALL LAWS HOLD means every check ran and passed.
// This file and its bite are frozen with the card, so everything the check means is written here.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// What is under test: something that runs the checks of a repository like "laws check" does.
export type Check = (repo: string) => { exitCode: number | null; printed: string };

const CLI = join(import.meta.dirname, "../../src/cli.ts");

// A check that never returns. Before it hangs it starts a second process and notes its number.
const NEVER_RETURNS = "sleep 300 & echo $! > started.pid; wait";
// A check that passes at once and leaves a process behind.
const LEAVES_A_PROCESS = "sleep 300 & echo $! > started.pid";

// ---- The property. The bite runs the same functions against broken ways to run checks. ----

// Allowed by the law: checks that pass, and a prose-grade card with no check.
export function allowedPassingChecksAndProse(check: Check): void {
  withRepository((repo) => {
    writeCard(repo, "A-01", ["grade: chosen", "check: true"]);
    writeCard(repo, "A-02", ["grade: generated", "check: test -d laws"]);
    writeCard(repo, "A-03", ["grade: prose"]);
    const { exitCode, printed } = check(repo);
    assert.equal(exitCode, 0, `three good cards did not pass:\n${printed}`);
    assert.equal(lastLine(printed), "ALL LAWS HOLD");
    assert.doesNotMatch(printed, /SOME LAWS FAIL/);
    assert.match(printed, /^A-01 /m);
    assert.match(printed, /^A-02 /m);
    assert.match(printed, /^A-03 .*prose/m, "the prose card must be listed as prose");
  });
}

// A failing check: SOME LAWS FAIL, the failing card named, its output shown, exit 1.
export function blockedFailingCheck(check: Check): void {
  withRepository((repo) => {
    writeCard(repo, "A-01", ["grade: chosen", "check: true"]);
    writeCard(repo, "A-02", ["grade: chosen", "check: echo the-reason-it-failed; exit 3"]);
    const { exitCode, printed } = check(repo);
    assert.equal(exitCode, 1, `a failing check did not fail the run:\n${printed}`);
    assert.equal(lastLine(printed), "SOME LAWS FAIL");
    assert.doesNotMatch(printed, /ALL LAWS HOLD/);
    assert.match(printed, /^A-02 .*FAIL/m, "the failing card must be named");
    assert.doesNotMatch(printed, /^A-01 .*FAIL/m, "the passing card must not be named as failing");
    assert.match(printed, /the-reason-it-failed/, "the last lines of the failing check must be shown");
  });
}

// Blocked by the law: a check that never returns. It is stopped at its time limit with everything it
// started, and the card counts as failed.
export function blockedCheckThatNeverReturns(check: Check): void {
  withRepository((repo) => {
    writeCard(repo, "A-01", ["grade: chosen", `check: ${NEVER_RETURNS}`, "timeout: 1"]);
    const started = Date.now();
    const { exitCode, printed } = check(repo);
    const seconds = (Date.now() - started) / 1000;
    stopWhatIsStillRunning(repo, "the check was stopped at its time limit");
    assert.ok(seconds < 30, `a check with a 1 s limit held the run for ${seconds} s`);
    assert.equal(exitCode, 1, `a check that never returns did not fail the run:\n${printed}`);
    assert.equal(lastLine(printed), "SOME LAWS FAIL");
    assert.match(printed, /^A-01 .*FAIL/m);
  });
}

// When a check ends by itself, nothing it started is still running either.
export function nothingRunsAfterAPassingCheck(check: Check): void {
  withRepository((repo) => {
    writeCard(repo, "A-01", ["grade: chosen", `check: ${LEAVES_A_PROCESS}`]);
    const { exitCode, printed } = check(repo);
    stopWhatIsStillRunning(repo, "the check had ended");
    assert.equal(exitCode, 0, printed);
    assert.equal(lastLine(printed), "ALL LAWS HOLD");
  });
}

// Blocked by the law: a card above prose grade with no check.
export function blockedCardWithoutCheck(check: Check): void {
  withRepository((repo) => {
    writeCard(repo, "A-01", ["grade: chosen", "check: true"]);
    writeCard(repo, "A-02", ["grade: bounded"]);
    const { exitCode, printed } = check(repo);
    assert.equal(exitCode, 1, `a card above prose grade without a check did not fail the run:\n${printed}`);
    assert.equal(lastLine(printed), "SOME LAWS FAIL");
    assert.doesNotMatch(printed, /ALL LAWS HOLD/);
    assert.match(printed, /^A-02 .*FAIL/m, "the card without a check must be named");
  });
}

function withRepository(body: (repo: string) => void): void {
  const repo = mkdtempSync(join(tmpdir(), "laws-t06-"));
  try {
    mkdirSync(join(repo, "laws"));
    body(repo);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

function writeCard(repo: string, id: string, frontMatter: string[]): void {
  writeFileSync(join(repo, "laws", `${id}.md`), `---\nid: ${id}\n${frontMatter.join("\n")}\n---\n# ${id} A law\n`);
}

function lastLine(printed: string): string {
  return printed.trimEnd().split("\n").pop() ?? "";
}

// Fails if the process noted in started.pid is still running, and stops it first so that this test
// leaves nothing behind either. A killed process may take a moment to go, so it looks for 3 seconds.
function stopWhatIsStillRunning(repo: string, when: string): void {
  const noted = join(repo, "started.pid");
  assert.ok(existsSync(noted), "the check did not run: it left no started.pid");
  const pid = Number(readFileSync(noted, "utf8"));
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    spawnSync("sleep", ["0.05"]);
  }
  process.kill(pid, "SIGKILL");
  assert.fail(`a process that the check started was still running after ${when}`);
}

// ---- The check: the property against the real laws command. ----

if (import.meta.main) {
  const real: Check = (repo) => {
    const result = spawnSync(process.execPath, [CLI, "check", "--repo", repo], { encoding: "utf8" });
    return { exitCode: result.status, printed: result.stdout };
  };

  test("T-06 allowed: passing checks, and a prose card with no check", () => allowedPassingChecksAndProse(real));
  test("T-06 a failing check is named, shown, and fails the run", () => blockedFailingCheck(real));
  test("T-06 blocked: a check that never returns", () => blockedCheckThatNeverReturns(real));
  test("T-06 nothing is left running after a check that passes", () => nothingRunsAfterAPassingCheck(real));
  test("T-06 blocked: a card above prose grade with no check", () => blockedCardWithoutCheck(real));

  test("T-06 a card that cannot be read fails the run", () => {
    withRepository((repo) => {
      writeCard(repo, "A-01", ["grade: chosen", "check: true"]);
      writeCard(repo, "A-02", ["grade: chosen", "check: true", "colour: green"]);
      const { exitCode, printed } = real(repo);
      assert.equal(exitCode, 1);
      assert.equal(lastLine(printed), "SOME LAWS FAIL");
      assert.match(printed, /^A-02 .*FAIL/m);
    });
  });

  test("T-06 on success there is one short line per card and the verdict, nothing else", () => {
    withRepository((repo) => {
      writeCard(repo, "A-01", ["grade: chosen", "check: echo much noise; true"]);
      writeCard(repo, "A-02", ["grade: chosen", "check: true"]);
      const { printed } = real(repo);
      assert.equal(printed.trimEnd().split("\n").length, 3, printed);
      assert.doesNotMatch(printed, /much noise/);
    });
  });
}
