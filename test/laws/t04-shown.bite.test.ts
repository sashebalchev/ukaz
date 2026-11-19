// The bite of law T-04: the same property as the check, run against sides that are broken on purpose.
// Every test in this file must FAIL. If one passes, the check of T-04 has lost its teeth.

import { createHash } from "node:crypto";
import { test } from "node:test";
import { allowedShownIsSigned, blockedChangedAfterShowing, blockedNoList, honestList, manifestOfLines } from "./t04-shown.test.ts";
import type { Approval, Side } from "./t04-shown.test.ts";

// A side that reads the request from the server, and does what its two functions say.
const side =
  (decide: (server: string, id: string, between: () => Promise<void>) => Promise<Approval>): Side =>
  async (world) => ({ approve: (id, between) => decide(world.server, id, between), stop: async () => {} });

// Broken on purpose: it shows the list that it computed, and signs the same list with one hash changed.
const showsOneSignsAnother = side(async (server, id) => {
  const list = await honestList(server, id);
  if (list === null) return { shown: null, signed: null };
  const signed = list.map((line, at) => (at === 0 ? { ...line, hash: createHash("sha256").update("another card").digest("hex") } : line));
  return { shown: list, signed: manifestOfLines(signed) };
});

// Broken on purpose: it computes every hash from the card file only, and leaves the frozen files out. What
// it shows and what it signs agree with each other, and neither is what the bytes of the request hash to.
const hashesOnlyTheCard = side(async (server, id) => {
  const reply = await fetch(`${server}api/requests/${id}/request`);
  const { cards } = (await reply.json()) as { cards: { id: string; card: string }[] };
  const list = (await honestList(server, id) ?? []).map((line) => {
    const card = cards.find((one) => one.id === line.id);
    return { ...line, hash: createHash("sha256").update(Buffer.from(card?.card ?? "", "base64")).digest("hex") };
  });
  return { shown: list, signed: manifestOfLines(list) };
});

// Broken on purpose: with no list to show, it signs a list of its own.
const signsWithoutAList = side(async (server, id) => {
  const list = await honestList(server, id);
  if (list === null) return { shown: null, signed: manifestOfLines([{ id: "A-01", hash: "0".repeat(64) }]) };
  return { shown: list, signed: manifestOfLines(list) };
});

// Broken on purpose: it shows the list, and reads the request again before it signs. If the bytes changed in
// between, it signs a list that it did not show.
const readsAgainBeforeSigning = side(async (server, id, between) => {
  const shown = await honestList(server, id);
  await between();
  const again = await honestList(server, id);
  return { shown, signed: again === null ? null : manifestOfLines(again) };
});

test("bite: a side that signs another list than it showed fails", () => allowedShownIsSigned(showsOneSignsAnother));
test("bite: a side that leaves the frozen files out of the hash fails", () => allowedShownIsSigned(hashesOnlyTheCard));
test("bite: a side that signs with no list fails", () => blockedNoList(signsWithoutAList));
test("bite: a side that reads again before it signs fails when the bytes changed", () => blockedChangedAfterShowing(readsAgainBeforeSigning));
