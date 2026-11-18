// The bite of law T-02: the same property as the check, run against ways to verify that are broken on purpose.
// Every test in this file must FAIL. If one passes, the check of T-02 has lost its teeth.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { parseManifest } from "../../src/approvals.ts";
import { loadCards } from "../../src/cards.ts";
import { readLawbook } from "../../src/verify.ts";
import {
  blockedEarlierVersion,
  blockedKeyInsideTheRepository,
  firstSeed,
  newWorld,
  onlyCurrentOwnerSignaturesCount,
  removeWorld,
} from "./t02-verify.test.ts";
import type { Verify } from "./t02-verify.test.ts";

// Broken on purpose: if the repository carries its own signers file, that one is trusted.
const trustsTheRepository: Verify = (repo, signersFile) => {
  const inside = join(repo, "laws", "allowed_signers");
  const book = readLawbook(repo, existsSync(inside) ? inside : signersFile);
  return book.states.every((card) => card.state === "approved");
};

// Broken on purpose: a good signature over the card's id counts, whatever hash it covered.
const forgetsTheHash: Verify = (repo, signersFile) => {
  const book = readLawbook(repo, signersFile);
  return book.states.every((card) => card.state === "approved" || card.state === "changed");
};

// Broken on purpose: it reads the manifests and never checks who signed them.
const skipsTheSignature: Verify = (repo) => {
  const folder = join(repo, "laws", "approvals");
  const lines = new Set<string>();
  for (const name of readdirSync(folder).filter((file) => file.endsWith(".manifest"))) {
    const manifest = parseManifest(readFileSync(join(folder, name), "utf8"));
    for (const entry of manifest.entries) lines.add(`${entry.id} ${entry.hash}`);
  }
  return loadCards(repo).every((card) => card.ok && lines.has(`${card.id} ${card.hash}`));
};

const world = newWorld();
after(() => removeWorld(world));

test("bite: trusting a signers file inside the repository fails the blocked case", () => {
  blockedKeyInsideTheRepository(trustsTheRepository, world);
});
test("bite: trusting a signers file inside the repository fails the generated histories", () => {
  onlyCurrentOwnerSignaturesCount(trustsTheRepository, world, firstSeed());
});
test("bite: forgetting the hash fails the blocked case", () => {
  blockedEarlierVersion(forgetsTheHash, world);
});
test("bite: forgetting the hash fails the generated histories", () => {
  onlyCurrentOwnerSignaturesCount(forgetsTheHash, world, firstSeed());
});
test("bite: skipping the signature fails the blocked case", () => {
  blockedKeyInsideTheRepository(skipsTheSignature, world);
});
test("bite: skipping the signature fails the generated histories", () => {
  onlyCurrentOwnerSignaturesCount(skipsTheSignature, world, firstSeed());
});
