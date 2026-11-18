// The bite of law T-08: the same property as the check, run against gates that are broken on purpose.
// Every test in this file must FAIL. If one passes, the check of T-08 has lost its teeth.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { parseManifest } from "../../src/approvals.ts";
import { readLawbook } from "../../src/verify.ts";
import {
  blockedApprovedCardDeleted,
  blockedRetiredCardComesBack,
  blockedRetirementByAStranger,
  firstSeed,
  newWorld,
  removedOnlyBySignedRetirement,
  removeWorld,
} from "./t08-retire.test.ts";
import type { IsOpen } from "./t08-retire.test.ts";

// Broken on purpose: it looks only at the card files that are there. A card that is gone is not missed.
const missingCardsAreNotMissed: IsOpen = (repo, signersFile) => {
  const book = readLawbook(repo, signersFile);
  return book.cards.length > 0 && book.states.every((card) => card.problem === null || card.state === "missing");
};

// Broken on purpose: a card may be gone if any manifest retires it, whoever signed it and whenever.
const anyRetirementLineCounts: IsOpen = (repo, signersFile) => {
  const folder = join(repo, "laws", "approvals");
  const retired = new Set<string>();
  for (const name of readdirSync(folder).filter((file) => file.endsWith(".manifest"))) {
    for (const entry of parseManifest(readFileSync(join(folder, name), "utf8")).entries) {
      if (entry.hash === null) retired.add(entry.id);
    }
  }
  const book = readLawbook(repo, signersFile);
  return book.cards.length > 0 && book.states.every((card) => card.problem === null || (card.state === "missing" && retired.has(card.id)));
};

const world = newWorld();
after(() => removeWorld(world));

test("bite: a gate that does not miss deleted cards fails the blocked case", () => {
  blockedApprovedCardDeleted(missingCardsAreNotMissed, world);
});
test("bite: a gate that does not miss deleted cards fails the generated histories", () => {
  removedOnlyBySignedRetirement(missingCardsAreNotMissed, world, firstSeed());
});
test("bite: a gate that believes any retirement line fails for a stranger's retirement", () => {
  blockedRetirementByAStranger(anyRetirementLineCounts, world);
});
test("bite: a gate that believes any retirement line fails when a retired card came back and was deleted", () => {
  blockedRetiredCardComesBack(anyRetirementLineCounts, world);
});
test("bite: a gate that believes any retirement line fails the generated histories", () => {
  removedOnlyBySignedRetirement(anyRetirementLineCounts, world, firstSeed());
});
