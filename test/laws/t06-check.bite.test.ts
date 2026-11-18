// The bite of law T-06: the same property as the check, run against ways to run checks that are broken on purpose.
// Every test in this file must FAIL. If one passes, the check of T-06 has lost its teeth.

import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { loadCards } from "../../src/cards.ts";
import {
  blockedCardWithoutCheck,
  blockedCheckThatNeverReturns,
  blockedDetachedProcess,
  blockedProcessLeftRunning,
} from "./t06-check.test.ts";
import type { Check } from "./t06-check.test.ts";

// Runs every check the simple way: no process group. At the time limit only the shell is stopped,
// and when a check ends nobody looks for what it left behind.
function runSimply(repo: string, withoutCheck: "fails" | "is skipped"): ReturnType<Check> {
  const lines: string[] = [];
  let failed = false;
  for (const loaded of loadCards(repo)) {
    if (!loaded.ok) throw new Error(loaded.problem);
    const { card } = loaded;
    if (card.check === null) {
      if (withoutCheck === "is skipped" || card.grade === "prose") continue;
      failed = true;
      lines.push(`${card.id}  FAIL  no check`);
      continue;
    }
    const run = spawnSync("sh", ["-c", card.check], { cwd: repo, stdio: "ignore", timeout: card.timeout * 1000 });
    if (run.status !== 0) failed = true;
    lines.push(`${card.id}  ${run.status === 0 ? "ok" : "FAIL"}`);
  }
  lines.push(failed ? "SOME LAWS FAIL" : "ALL LAWS HOLD");
  return { exitCode: failed ? 1 : 0, printed: `${lines.join("\n")}\n` };
}

// Broken on purpose: it stops only the command it started, not what that command started.
const stopsOnlyTheShell: Check = (repo) => runSimply(repo, "fails");

// Broken on purpose: a card without a check is passed over in silence.
const skipsCardsWithoutCheck: Check = (repo) => runSimply(repo, "is skipped");

test("bite: stopping only the shell fails the blocked case of a check that never returns", () => {
  blockedCheckThatNeverReturns(stopsOnlyTheShell);
});
test("bite: not looking for what a check left fails the blocked case of a detached process", () => {
  blockedDetachedProcess(stopsOnlyTheShell);
});
test("bite: not looking for what a check left fails for a process in the check's own group", () => {
  blockedProcessLeftRunning(stopsOnlyTheShell);
});
test("bite: skipping a card without a check fails the blocked case", () => {
  blockedCardWithoutCheck(skipsCardsWithoutCheck);
});
