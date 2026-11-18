// The bite of law T-07: the same property as the check, run against a variant that is broken on purpose.
// Every test in this file must FAIL. If one passes, the check of T-07 has lost its teeth.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { loadCards } from "../../src/cards.ts";
import {
  blockedBiteThatFailsAnotherWay,
  blockedBiteThatPasses,
  blockedMisspelledBite,
  blockedMissingBite,
  blockedToothlessCardInABatch,
} from "./t07-teeth.test.ts";
import type { Sign, World } from "./t07-teeth.test.ts";

// Hands these cards to the signer and stores what comes back, the way laws sign does after its checks.
function offer(world: World, ids: string[]): number {
  const out = mkdtempSync(join(world.folder, "out-"));
  const words = ["--repo", world.repo, "--out", out, ...ids];
  const signer = spawnSync("sh", ["-c", `${world.signerCommand} "$@"`, "signer", ...words], { stdio: "ignore" });
  if (signer.status !== 0) return 1;
  const folder = join(world.repo, "laws", "approvals");
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "batch.manifest"), readFileSync(join(out, "manifest")));
  writeFileSync(join(folder, "batch.manifest.sig"), readFileSync(join(out, "manifest.sig")));
  return 0;
}

// Broken on purpose: it offers every card to the signer and never runs a bite.
const offersEveryCard: Sign = (world) => offer(world, loadCards(world.repo).map((card) => card.id));

// Broken on purpose: it runs the bites, and any failure is good enough. It does not look at what the bite printed.
const anyFailureCounts: Sign = (world) => {
  const offered: string[] = [];
  for (const card of loadCards(world.repo)) {
    const bite = card.ok ? card.card.bite : null;
    if (bite === null) return 1;
    if (spawnSync("sh", ["-c", bite], { cwd: world.repo, stdio: "ignore" }).status === 0) return 1;
    offered.push(card.id);
  }
  return offer(world, offered);
};

test("bite: offering every card fails the blocked case of a bite that passes", () => {
  blockedBiteThatPasses(offersEveryCard);
});
test("bite: offering every card fails for a card without a bite", () => {
  blockedMissingBite(offersEveryCard);
});
test("bite: offering every card fails for a toothless card in a batch", () => {
  blockedToothlessCardInABatch(offersEveryCard);
});
test("bite: counting any failure fails the blocked case of a misspelled file name", () => {
  blockedMisspelledBite(anyFailureCounts);
});
test("bite: counting any failure fails for a bite that fails another way", () => {
  blockedBiteThatFailsAnotherWay(anyFailureCounts);
});
