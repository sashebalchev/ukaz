import { loadCards } from "./cards.ts";
import type { Loaded } from "./cards.ts";
import { lastLines, runCommand } from "./run.ts";

// How one card's check went. "shown" is the command and the last lines it printed, for a failure.
type Outcome = { ok: boolean; summary: string; shown: string };

// laws check: one short line per card, then the failing cards with the last lines of their output,
// then ALL LAWS HOLD or SOME LAWS FAIL. Returns the exit code.
export async function checkCommand(repo: string, print: (line: string) => void): Promise<number> {
  const cards = loadCards(repo);
  const failures: Outcome[] = [];
  for (const card of cards) {
    const outcome = await checkCard(repo, card);
    print(`${card.id}  ${outcome.summary}`);
    if (!outcome.ok) failures.push(outcome);
  }
  if (cards.length === 0) print("no law cards in laws/, so nothing was checked");
  if (cards.length > 0 && failures.length === 0) {
    print("ALL LAWS HOLD");
    return 0;
  }
  for (const failure of failures.filter((outcome) => outcome.shown !== "")) {
    print("");
    print(failure.shown);
  }
  print("");
  print("SOME LAWS FAIL");
  return 1;
}

async function checkCard(repo: string, loaded: Loaded): Promise<Outcome> {
  if (!loaded.ok) return { ok: false, summary: `FAIL  the card is broken: ${loaded.problem}`, shown: "" };

  const { card } = loaded;
  if (card.check === null) {
    if (card.grade === "prose") return { ok: true, summary: "prose, no check", shown: "" };
    return { ok: false, summary: `FAIL  no check, and grade ${card.grade} needs one`, shown: "" };
  }
  const run = await runCommand(card.check, repo, card.timeout);
  let why: string;
  if (run.timedOut) why = `stopped at its time limit of ${card.timeout} s`;
  else if (run.notStopped) why = "it started processes that could not be stopped";
  else if (run.exitCode === null) why = "the check was killed by a signal";
  else if (run.exitCode !== 0) why = `the check exited ${run.exitCode}`;
  else if (run.leftRunning) why = "it left a process running; the process was stopped";
  else return { ok: true, summary: "ok", shown: "" };
  return { ok: false, summary: `FAIL  ${why}`, shown: `--- ${card.id}: ${card.check}\n${lastLines(run.output, 15)}` };
}
