// The bite of law T-09: the same property as the check, run against helpers that are broken on purpose.
// Every test in this file must FAIL. If one passes, the check of T-09 has lost its teeth.

import { appendFileSync } from "node:fs";
import { createServer } from "node:net";
import { test } from "node:test";
import { startLaptopSigner } from "../../signer/laptop.ts";
import { blockedAnotherFinger, blockedCardsOfItsOwn, blockedNoTouch, oneMatchSignsOneList } from "./t09-fingerprint.test.ts";
import type { Start } from "./t09-fingerprint.test.ts";

const quiet = (): void => {};

// Broken on purpose: it asks the reader for any finger, as sudo does, whatever finger its settings name.
const takesAnyFinger: Start = (settings, reader, milliseconds) =>
  startLaptopSigner(settings, (_finger, user, limit) => reader.check("any", user, limit), quiet, { fingerMilliseconds: milliseconds, loopbackHttp: true });

// Broken on purpose: after one match it remembers that you were there, and does not ask the reader again.
const keepsTheMatch: Start = (settings, reader, milliseconds) => {
  let matched = false;
  const check: typeof reader.check = async (finger, user, limit) => {
    if (matched) return { match: true, detail: "remembered" };
    const result = await reader.check(finger, user, limit);
    matched = result.match;
    return result;
  };
  return startLaptopSigner(settings, check, quiet, { fingerMilliseconds: milliseconds, loopbackHttp: true });
};

// Broken on purpose: it waits twenty times longer for the finger than its time limit says.
const waitsTooLong: Start = (settings, reader, milliseconds) =>
  startLaptopSigner(settings, reader.check, quiet, { fingerMilliseconds: milliseconds * 20, loopbackHttp: true });

// Broken on purpose: a helper that also takes cards from the program that calls it, as a signer on the
// laptop would. It never looks at the server for them: the named finger is all it asks for.
// (The real helper runs next to it, so that the key exists. Calls without cards are not served here.)
const signsWhatItIsHanded: Start = async (settings, reader, milliseconds) => {
  const real = await startLaptopSigner({ ...settings, socket: `${settings.socket}-real` }, reader.check, quiet, { loopbackHttp: true });
  const front = createServer((socket) => {
    let text = "";
    socket.setEncoding("utf8");
    socket.on("error", () => {});
    socket.on("data", (chunk) => {
      text += chunk;
      if (!text.includes("\n")) return;
      const { cards } = JSON.parse(text) as { cards?: { id: string }[] };
      if (cards === undefined) return void socket.end(`${JSON.stringify({ refused: "this broken helper serves only calls with cards" })}\n`);
      socket.write(`${JSON.stringify({ list: cards.map((card) => ({ id: card.id, hash: null, title: "" })), finger: settings.finger, seconds: 1 })}\n`);
      void reader.check(settings.finger, settings.user, milliseconds).then((result) => {
        if (result.match) appendFileSync(settings.log, `${new Date().toISOString()} broken signed ${cards.map((card) => card.id).join(" ")}\n`);
        socket.end(`${JSON.stringify(result.match ? { approved: true } : { refused: "no match" })}\n`);
      });
    });
  });
  await new Promise<void>((done) => front.listen(settings.socket, done));
  return {
    stop: async () => {
      await new Promise<void>((done) => front.close(() => done()));
      await real.stop();
    },
  };
};

test("bite: a helper that takes any finger fails the blocked case of another finger", () => blockedAnotherFinger(takesAnyFinger));
test("bite: a helper that keeps a match signs a second list", () => oneMatchSignsOneList(keepsTheMatch));
test("bite: a helper that waits too long fails the blocked case of no touch", () => blockedNoTouch(waitsTooLong));
test("bite: a helper that signs what a local program hands it fails the blocked case of cards of its own", () => blockedCardsOfItsOwn(signsWhatItIsHanded));
