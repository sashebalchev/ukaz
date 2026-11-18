// The bite of law T-09: the same property as the check, run against services that are broken on purpose.
// Every test in this file must FAIL. If one passes, the check of T-09 has lost its teeth.

import { test } from "node:test";
import { startLaptopSigner } from "../../signer/laptop.ts";
import { blockedAnotherFinger, blockedNoTouch, oneMatchSignsOneList } from "./t09-fingerprint.test.ts";
import type { Start } from "./t09-fingerprint.test.ts";

const quiet = (): void => {};

// Broken on purpose: it asks the reader for any finger, as sudo does, whatever finger its settings name.
const takesAnyFinger: Start = (settings, reader, milliseconds) =>
  startLaptopSigner(settings, (_finger, user, limit) => reader.check("any", user, limit), quiet, milliseconds);

// Broken on purpose: after one match it remembers that you were there, and does not ask the reader again.
const keepsTheMatch: Start = (settings, reader, milliseconds) => {
  let matched = false;
  const check: typeof reader.check = async (finger, user, limit) => {
    if (matched) return { match: true, detail: "remembered" };
    const result = await reader.check(finger, user, limit);
    matched = result.match;
    return result;
  };
  return startLaptopSigner(settings, check, quiet, milliseconds);
};

// Broken on purpose: it waits twenty times longer for the finger than its time limit says.
const waitsTooLong: Start = (settings, reader, milliseconds) => startLaptopSigner(settings, reader.check, quiet, milliseconds * 20);

test("bite: a service that takes any finger fails the blocked case of another finger", () => blockedAnotherFinger(takesAnyFinger));
test("bite: a service that keeps a match signs a second list", () => oneMatchSignsOneList(keepsTheMatch));
test("bite: a service that waits too long fails the blocked case of no touch", () => blockedNoTouch(waitsTooLong));
