// The bite of law T-07: the same property as the check, run against a variant that is broken on purpose.
// Every test in this file must FAIL. If one passes, the check of T-07 has lost its teeth.

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { loadCards, readCardFiles } from "../../src/cards.ts";
import { requestText } from "../../src/request.ts";
import {
  blockedBiteThatFailsAnotherWay,
  blockedBiteThatPasses,
  blockedMisspelledBite,
  blockedMissingBite,
  blockedToothlessCardInABatch,
} from "./t07-teeth.test.ts";
import type { Sign, World } from "./t07-teeth.test.ts";

// Posts these cards to the signing server and stores what comes back, the way laws sign does after its
// checks.
async function offer(world: World, ids: string[]): Promise<number> {
  const cards = ids.map((id) => {
    const { cardBytes, files } = readCardFiles(world.repo, id);
    return { id, retire: false, card: cardBytes, files };
  });
  const headers = { "Content-Type": "application/json" };
  const posted = await fetch(`${world.server}api/requests`, { method: "POST", headers, body: requestText(cards) });
  const { id } = (await posted.json()) as { id: string };
  for (let tries = 0; tries < 200; tries++) {
    const result = (await (await fetch(`${world.server}api/requests/${id}/result`)).json()) as { state: string; manifest?: string; signature?: string };
    if (result.state === "signed") {
      const folder = join(world.repo, "laws", "approvals");
      mkdirSync(folder, { recursive: true });
      writeFileSync(join(folder, "batch.manifest"), result.manifest ?? "");
      writeFileSync(join(folder, "batch.manifest.sig"), result.signature ?? "");
      return 0;
    }
    await new Promise<void>((wake) => setTimeout(() => wake(), 50));
  }
  return 1;
}

// Broken on purpose: it offers every card to the signing server and never runs a bite.
const offersEveryCard: Sign = (world) => offer(world, loadCards(world.repo).map((card) => card.id));

// Broken on purpose: it runs the bites, and any failure is good enough. It does not look at what the bite printed.
const anyFailureCounts: Sign = async (world) => {
  const offered: string[] = [];
  for (const card of loadCards(world.repo)) {
    const bite = card.ok ? card.card.bite : null;
    if (bite === null) return 1;
    if (spawnSync("sh", ["-c", bite], { cwd: world.repo, stdio: "ignore" }).status === 0) return 1;
    offered.push(card.id);
  }
  return offer(world, offered);
};

test("bite: offering every card fails the blocked case of a bite that passes", () => blockedBiteThatPasses(offersEveryCard));
test("bite: offering every card fails for a card without a bite", () => blockedMissingBite(offersEveryCard));
test("bite: offering every card fails for a toothless card in a batch", () => blockedToothlessCardInABatch(offersEveryCard));
test("bite: counting any failure fails the blocked case of a misspelled file name", () => blockedMisspelledBite(anyFailureCounts));
test("bite: counting any failure fails for a bite that fails another way", () => blockedBiteThatFailsAnotherWay(anyFailureCounts));
