// The bite of law T-03: the same property as the check, run against variants that are broken on purpose.
// Every test in this file must FAIL. If one passes, the check of T-03 has lost its teeth.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { loadCards, readCardFiles } from "../../src/cards.ts";
import { requestText } from "../../src/request.ts";
import { blockedNoSigner, findWaysToSign, readSources, storesOnlyWhatVerifies } from "./t03-no-key.test.ts";
import type { Sign, World } from "./t03-no-key.test.ts";

function approvalsFolder(world: World): string {
  const folder = join(world.repo, "laws", "approvals");
  mkdirSync(folder, { recursive: true });
  return folder;
}

// Broken on purpose: it asks the signing server and stores whatever comes back, without verifying it.
const storesWhateverComesBack: Sign = async (world, server) => {
  if (server === null) return 1;
  const cards = loadCards(world.repo).flatMap((card) => {
    if (!card.ok) return [];
    const { cardBytes, files } = readCardFiles(world.repo, card.id);
    return [{ id: card.id, retire: false, card: cardBytes, files }];
  });
  const headers = { "Content-Type": "application/json" };
  const posted = await fetch(`${server}api/requests`, { method: "POST", headers, body: requestText(cards) });
  const { id } = (await posted.json()) as { id: string };
  for (let tries = 0; tries < 200; tries++) {
    const result = (await (await fetch(`${server}api/requests/${id}/result`)).json()) as { state: string; manifest?: string; signature?: string };
    if (result.state === "signed") {
      writeFileSync(join(approvalsFolder(world), "batch.manifest"), result.manifest ?? "");
      writeFileSync(join(approvalsFolder(world), "batch.manifest.sig"), result.signature ?? "");
      return 0;
    }
    await new Promise<void>((wake) => setTimeout(() => wake(), 50));
  }
  return 1;
};

// Broken on purpose: it checks the signature against the signers file, but not whether the list is the one
// that it asked for.
const checksOnlyTheSignature: Sign = async (world, server) => {
  const stored = await storesWhateverComesBack(world, server);
  if (stored !== 0) return stored;
  const manifest = join(approvalsFolder(world), "batch.manifest");
  const options = ["-Y", "verify", "-f", world.signers, "-I", "owner", "-n", "laws", "-s", `${manifest}.sig`];
  const verified = spawnSync("ssh-keygen", options, { input: readFileSync(manifest), stdio: ["pipe", "ignore", "ignore"] });
  if (verified.status === 0) return 0;
  rmSync(join(world.repo, "laws", "approvals"), { recursive: true, force: true });
  return 1;
};

// Broken on purpose: with no signing server it helps itself to the key it finds in the home folder.
const signsByItself: Sign = async (world, server) => {
  if (server !== null) return storesWhateverComesBack(world, server);
  const lines = loadCards(world.repo).map((card) => (card.ok ? `${card.id} ${card.hash}\n` : ""));
  const manifest = join(approvalsFolder(world), "batch.manifest");
  writeFileSync(manifest, `signed: ${new Date().toISOString()}\n${lines.join("")}`);
  const key = join(world.home, ".ssh", "id_ed25519");
  return spawnSync("ssh-keygen", ["-Y", "sign", "-f", key, "-n", "laws", manifest], { stdio: "ignore" }).status;
};

// Broken on purpose: the source of a laws command that can sign.
const SOURCE_THAT_SIGNS = `
import { spawnSync } from "node:child_process";
export function approve(manifest: string, key: string): void {
  spawnSync("ssh-keygen", ["-Y", "sign", "-f", key, "-n", "laws", manifest]);
}
`;

test("bite: a laws command that signs by itself fails the blocked case of no signer", () => blockedNoSigner(signsByItself));
test("bite: a laws command that stores without verifying fails", () => storesOnlyWhatVerifies(storesWhateverComesBack));
test("bite: a laws command that checks the signature but not the list fails", () => storesOnlyWhatVerifies(checksOnlyTheSignature));
test("bite: a source that runs ssh-keygen -Y sign is found", () => {
  const sources = readSources().set("sign.ts", SOURCE_THAT_SIGNS);
  assert.deepEqual(findWaysToSign(sources), []);
});
