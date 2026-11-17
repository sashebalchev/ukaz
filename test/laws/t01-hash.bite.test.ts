// The bite of law T-01: the same property as the check, run against hashes that are broken on purpose.
// Every test in this file must FAIL. If one passes, the check of T-01 has lost its teeth.

import { createHash } from "node:crypto";
import { test } from "node:test";
import type { FrozenFile } from "../../src/hash.ts";
import { blockedCase, everyByteCounts, firstSeed } from "./t01-hash.test.ts";

// Broken on purpose: it hashes the card file and forgets the frozen files.
function hashOfTheCardOnly(card: Uint8Array, _frozen: FrozenFile[]): string {
  return createHash("sha256").update(card).digest("hex");
}

// Broken on purpose: it covers every byte, but glues the parts together without their lengths.
function hashWithoutLengths(card: Uint8Array, frozen: FrozenFile[]): string {
  const hash = createHash("sha256").update(card);
  for (const file of [...frozen].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    hash.update(file.path).update(file.bytes);
  }
  return hash.digest("hex");
}

test("bite: a hash that forgets the frozen files fails the blocked case", () => blockedCase(hashOfTheCardOnly));

test("bite: a hash that forgets the frozen files fails the generated cases", () => {
  everyByteCounts(hashOfTheCardOnly, firstSeed());
});

test("bite: a hash without length prefixes fails the generated cases", () => {
  everyByteCounts(hashWithoutLengths, firstSeed());
});
