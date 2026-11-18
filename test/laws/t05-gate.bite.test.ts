// The bite of law T-05: the same property as the check, run against gates that are broken on purpose.
// Every test in this file must FAIL. If one passes, the check of T-05 has lost its teeth.

import { after, test } from "node:test";
import { readLawbook } from "../../src/verify.ts";
import {
  blockedNewCardAndMissingSignature,
  blockedOneOfTenEdited,
  firstSeed,
  newWorld,
  openOnlyWhenNothingIsWaiting,
  removeWorld,
} from "./t05-gate.test.ts";
import type { IsOpen } from "./t05-gate.test.ts";

// Broken on purpose: a card that was approved once keeps the gate open, whatever happened to it since.
const onceApprovedIsEnough: IsOpen = (repo, signersFile) => {
  const book = readLawbook(repo, signersFile);
  return book.states.every((card) => card.state === "approved" || card.state === "changed");
};

// Broken on purpose: only changed cards close the gate. A card nobody approved is not noticed.
const newCardsAreNotNoticed: IsOpen = (repo, signersFile) => {
  const book = readLawbook(repo, signersFile);
  return book.states.every((card) => card.state !== "changed");
};

const world = newWorld();
after(() => removeWorld(world));

test("bite: a gate that forgets edits fails the blocked case of ten cards", () => {
  blockedOneOfTenEdited(onceApprovedIsEnough, world);
});
test("bite: a gate that forgets edits fails the generated histories", () => {
  openOnlyWhenNothingIsWaiting(onceApprovedIsEnough, world, firstSeed());
});
test("bite: a gate that does not notice new cards fails the blocked case", () => {
  blockedNewCardAndMissingSignature(newCardsAreNotNoticed, world);
});
test("bite: a gate that does not notice new cards fails the generated histories", () => {
  openOnlyWhenNothingIsWaiting(newCardsAreNotNoticed, world, firstSeed());
});
