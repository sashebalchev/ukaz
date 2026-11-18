// The bite of law T-07: the same property as the check, run against a variant that is broken on purpose.
// Every test in this file must FAIL. If one passes, the check of T-07 has lost its teeth.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { loadCards } from "../../src/cards.ts";
import { blockedBiteThatPasses, blockedMissingBite, blockedToothlessCardInABatch } from "./t07-teeth.test.ts";
import type { Sign } from "./t07-teeth.test.ts";

// Broken on purpose: it offers every card to the signer and never runs a bite.
const offersEveryCard: Sign = (world) => {
  const ids = loadCards(world.repo).map((card) => card.id);
  const out = mkdtempSync(join(world.folder, "out-"));
  const words = ["--repo", world.repo, "--out", out, ...ids];
  const signer = spawnSync("sh", ["-c", `${world.signerCommand} "$@"`, "signer", ...words], { stdio: "ignore" });
  if (signer.status !== 0) return 1;
  const folder = join(world.repo, "laws", "approvals");
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "batch.manifest"), readFileSync(join(out, "manifest")));
  writeFileSync(join(folder, "batch.manifest.sig"), readFileSync(join(out, "manifest.sig")));
  return 0;
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
