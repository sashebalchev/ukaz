// The bite of law T-03: the same property as the check, run against variants that are broken on purpose.
// Every test in this file must FAIL. If one passes, the check of T-03 has lost its teeth.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { loadCards } from "../../src/cards.ts";
import { blockedNoSigner, findWaysToSign, readSources, storesOnlyWhatVerifies } from "./t03-no-key.test.ts";
import type { Sign, World } from "./t03-no-key.test.ts";

function approvalsFolder(world: World): string {
  const folder = join(world.repo, "laws", "approvals");
  mkdirSync(folder, { recursive: true });
  return folder;
}

// Broken on purpose: it asks the signer and stores whatever comes back, without verifying it.
const storesWhateverComesBack: Sign = (world, signerCommand) => {
  if (signerCommand === null) return 1;
  const ids = loadCards(world.repo).map((card) => card.id);
  const out = mkdtempSync(join(world.folder, "out-"));
  const words = ["--repo", world.repo, "--out", out, ...ids];
  const signer = spawnSync("sh", ["-c", `${signerCommand} "$@"`, "signer", ...words], { stdio: "ignore" });
  if (signer.status !== 0) return 1;
  writeFileSync(join(approvalsFolder(world), "batch.manifest"), readFileSync(join(out, "manifest")));
  writeFileSync(join(approvalsFolder(world), "batch.manifest.sig"), readFileSync(join(out, "manifest.sig")));
  return 0;
};

// Broken on purpose: with no signer it helps itself to the key it finds in the home folder.
const signsByItself: Sign = (world, signerCommand) => {
  if (signerCommand !== null) return storesWhateverComesBack(world, signerCommand);
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

test("bite: a laws command that signs by itself fails the blocked case of no signer", () => {
  blockedNoSigner(signsByItself);
});
test("bite: a laws command that stores without verifying fails", () => {
  storesOnlyWhatVerifies(storesWhateverComesBack);
});
test("bite: a source that runs ssh-keygen -Y sign is found", () => {
  const sources = readSources().set("sign.ts", SOURCE_THAT_SIGNS);
  assert.deepEqual(findWaysToSign(sources), []);
});
