import { loadCards } from "./cards.ts";
import type { Loaded } from "./cards.ts";
import { runCommand } from "./run.ts";

type Outcome = { ok: boolean; summary: string; command: string; output: string };

// laws check: one short line per card, then the failing cards with the last lines of their output,
// then ALL LAWS HOLD or SOME LAWS FAIL. Returns the exit code.
export async function checkCommand(repo: string, print: (line: string) => void): Promise<number> {
  const cards = loadCards(repo);
  const failed: Outcome[] = [];
  for (const card of cards) {
    const outcome = await checkCard(repo, card);
    print(`${card.id}  ${outcome.summary}`);
    if (!outcome.ok) failed.push(outcome);
  }
  if (cards.length === 0) {
    print("no law cards in laws/, so nothing was checked");
    print("SOME LAWS FAIL");
    return 1;
  }
  if (failed.length === 0) {
    print("ALL LAWS HOLD");
    return 0;
  }
  for (const outcome of failed.filter((failure) => failure.output !== "")) {
    print("");
    print(`--- ${outcome.command}`);
    print(outcome.output);
  }
  print("");
  print("SOME LAWS FAIL");
  return 1;
}

async function checkCard(repo: string, loaded: Loaded): Promise<Outcome> {
  const fail = (why: string, command = "", output = ""): Outcome => ({
    ok: false,
    summary: `FAIL  ${why}`,
    command: `${loaded.id}: ${command}`,
    output,
  });
  if (!loaded.ok) return fail(`the card is broken: ${loaded.problem}`);

  const { card } = loaded;
  if (card.check === null) {
    if (card.grade === "prose") return { ok: true, summary: "prose, no check", command: "", output: "" };
    return fail(`no check, and grade ${card.grade} needs one`);
  }
  const run = await runCommand(card.check, repo, card.timeout);
  if (run.timedOut) return fail(`stopped at its time limit of ${card.timeout} s`, card.check, run.lastLines);
  if (run.leftBehind) return fail("it started processes that could not be stopped", card.check, run.lastLines);
  if (run.exitCode === null) return fail("the check was killed by a signal", card.check, run.lastLines);
  if (run.exitCode !== 0) return fail(`the check exited ${run.exitCode}`, card.check, run.lastLines);
  return { ok: true, summary: "ok", command: card.check, output: "" };
}
