import { loadCards } from "./cards.ts";
import type { Loaded } from "./cards.ts";
import { runCommand } from "./run.ts";

export type Teeth = { id: string; bites: boolean; summary: string };

// laws bite: runs every card's bite. A bite is the card's blocked case run for real, so it must fail,
// and fail in the way the card says. Returns the exit code: 0 only if no card is toothless.
export async function biteCommand(repo: string, print: (line: string) => void): Promise<number> {
  const cards = loadCards(repo);
  let toothless = 0;
  for (const card of cards) {
    const teeth = await teethOf(repo, card);
    print(`${card.id}  ${teeth.summary}`);
    if (!teeth.bites) toothless += 1;
  }
  if (cards.length === 0) {
    print("no law cards in laws/, so nothing was run");
    return 1;
  }
  print(toothless === 0 ? "EVERY LAW BITES" : "SOME LAWS ARE TOOTHLESS");
  return toothless === 0 ? 0 : 1;
}

// A card has teeth only if its bite ran to its own end, exited with a failure, and printed the text the
// card gives as bite-says. A bite that fails for another reason, such as a misspelled file name, does
// not print that text.
export async function teethOf(repo: string, loaded: Loaded): Promise<Teeth> {
  const toothless = (why: string): Teeth => ({ id: loaded.id, bites: false, summary: `TOOTHLESS  ${why}` });
  if (!loaded.ok) return toothless(`the card is broken: ${loaded.problem}`);

  const { card } = loaded;
  if (card.bite === null) {
    if (card.grade === "prose") return { id: card.id, bites: true, summary: "prose, no bite" };
    return toothless(`no bite, and grade ${card.grade} needs one`);
  }
  if (card.biteSays === null) return toothless("no bite-says: the card must give a text that its failing bite prints");

  const run = await runCommand(card.bite, repo, card.timeout);
  if (run.timedOut) return toothless(`the bite did not finish within ${card.timeout} s`);
  if (run.notStopped) return toothless("the bite started processes that could not be stopped");
  if (run.leftRunning) return toothless("the bite left a process running; the process was stopped");
  if (run.exitCode === null) return toothless("the bite was killed by a signal");
  if (run.exitCode === 0) return toothless("the bite passed (exit 0); it must fail");
  if (!run.output.includes(card.biteSays)) {
    return toothless(`the bite failed (exit ${run.exitCode}) without printing "${card.biteSays}"`);
  }
  return { id: card.id, bites: true, summary: "bites" };
}
