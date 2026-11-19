// The check of law T-07 (laws/T-07.md): a law without teeth cannot be signed.
// This file and its bite are frozen with the card, so everything the check means is written here.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { verifyRepo } from "../../src/verify.ts";
import { startStandIn } from "../standin.ts";
import type { StandIn } from "../standin.ts";

// What is under test: "laws sign" on the world's repository, for every card that is waiting.
// It returns the exit code.
export type Sign = (world: World) => Promise<number | null>;

// A temporary folder: a repository, a throwaway key, the signers file that names it, and a signing
// server with an approver that signs with that key and keeps a log (test/standin.ts). The approver is
// told about every list that reaches it; a card that was never offered to the server is not in its log.
export type World = { folder: string; repo: string; signers: string; server: string; log: string };

const CLI = join(import.meta.dirname, "../../src/cli.ts");
// A bite that fails and says what the card expects it to say.
const SAYS = "bite-says: the blocked case was caught";
const GOOD_BITE = ["bite: echo the blocked case was caught; exit 1", SAYS];

// ---- The property. The bite runs the same functions against a broken variant. ----

// Blocked by the law: a card whose bite command exits 0 is offered for signing.
export async function blockedBiteThatPasses(sign: Sign): Promise<void> {
  await withWorld(async (world) => {
    writeCard(world, "A-01", ["grade: chosen", "check: true", "bite: echo the blocked case was caught", SAYS]);
    assert.notEqual(await sign(world), 0, "laws sign succeeded for a card whose bite passes");
    assertNotOffered(world, "A-01", "its bite exits 0");
  });
}

// Blocked by the law: a bite that fails only because its file name is misspelled.
export async function blockedMisspelledBite(sign: Sign): Promise<void> {
  await withWorld(async (world) => {
    const bite = `bite: '${process.execPath}' --test test/laws/mispelled.bite.test.ts`;
    writeCard(world, "A-01", ["grade: chosen", "check: true", bite, SAYS]);
    assert.notEqual(await sign(world), 0, "laws sign succeeded for a bite that fails only because its file name is misspelled");
    assertNotOffered(world, "A-01", "its bite fails only because the file name is misspelled");
  });
}

// Also refused: a bite that fails and says something else, and a card that does not say what its bite prints.
export async function blockedBiteThatFailsAnotherWay(sign: Sign): Promise<void> {
  await withWorld(async (world) => {
    writeCard(world, "A-01", ["grade: chosen", "check: true", "bite: echo something else broke; exit 1", SAYS]);
    assert.notEqual(await sign(world), 0, "laws sign succeeded for a bite that fails without the text of bite-says");
    assertNotOffered(world, "A-01", "its bite does not print the text of bite-says");
  });
  await withWorld(async (world) => {
    writeCard(world, "A-01", ["grade: chosen", "check: true", "bite: echo the blocked case was caught; exit 1"]);
    assert.notEqual(await sign(world), 0, "laws sign succeeded for a card without bite-says");
    assertNotOffered(world, "A-01", "it has no bite-says");
  });
}

// Also refused: a card above prose grade with no bite at all.
export async function blockedMissingBite(sign: Sign): Promise<void> {
  await withWorld(async (world) => {
    writeCard(world, "A-01", ["grade: generated", "check: true"]);
    assert.notEqual(await sign(world), 0, "laws sign succeeded for a card without a bite");
    assertNotOffered(world, "A-01", "it has no bite");
  });
}

// A toothless card is not signed along with good ones.
export async function blockedToothlessCardInABatch(sign: Sign): Promise<void> {
  await withWorld(async (world) => {
    writeCard(world, "A-01", ["grade: chosen", "check: true", ...GOOD_BITE]);
    writeCard(world, "A-02", ["grade: chosen", "check: true", "bite: exit 0", SAYS]);
    await sign(world);
    assertNotOffered(world, "A-02", "its bite exits 0");
  });
}

// Allowed by the law: a card whose bite command exits 1 is offered for signing.
export async function allowedBiteThatFails(sign: Sign): Promise<void> {
  await withWorld(async (world) => {
    writeCard(world, "A-01", ["grade: chosen", "check: true", ...GOOD_BITE]);
    writeCard(world, "A-02", ["grade: prose"]);
    assert.equal(await sign(world), 0, "laws sign failed for a card whose bite fails as the card says, and a prose card");
    assert.match(approverLog(world), /A-01/, "the card whose bite fails was not offered to the signing server");
    assert.equal(verifyRepo(world.repo, world.signers).ok, true, "the cards are not approved after signing");
  });
}

async function withWorld(body: (world: World) => Promise<void>): Promise<void> {
  const folder = mkdtempSync(join(tmpdir(), "laws-t07-"));
  let approver: StandIn | null = null;
  try {
    const key = join(folder, "key");
    const log = join(folder, "approver.log");
    const made = spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key], { encoding: "utf8" });
    assert.equal(made.status, 0, `ssh-keygen failed: ${made.stderr}`);
    approver = await startStandIn(folder, key, log);
    const world = { folder, repo: join(folder, "repo"), signers: join(folder, "allowed_signers"), server: approver.url, log };
    mkdirSync(join(world.repo, "laws"), { recursive: true });
    writeFileSync(world.signers, `owner ${readFileSync(`${key}.pub`, "utf8")}`);
    await body(world);
  } finally {
    await approver?.stop();
    rmSync(folder, { recursive: true, force: true });
  }
}

function writeCard(world: World, id: string, frontMatter: string[]): void {
  const file = join(world.repo, "laws", `${id}.md`);
  writeFileSync(file, `---\nid: ${id}\n${frontMatter.join("\n")}\n---\n# ${id} A law\n`);
}

// What the approver on the server was asked to sign so far: one line per signing, with the ids.
function approverLog(world: World): string {
  return existsSync(world.log) ? readFileSync(world.log, "utf8") : "";
}

// The card never reached the signing server, and no stored manifest lists it.
function assertNotOffered(world: World, id: string, why: string): void {
  assert.doesNotMatch(approverLog(world), new RegExp(id), `${id} was offered to the signing server although ${why}`);
  const folder = join(world.repo, "laws", "approvals");
  for (const name of existsSync(folder) ? readdirSync(folder) : []) {
    const text = readFileSync(join(folder, name), "utf8");
    assert.doesNotMatch(text, new RegExp(`^${id} `, "m"), `${id} is in the stored approval ${name} although ${why}`);
  }
}

// ---- The check: the property against the real laws command. ----

if (import.meta.main) {
  // --phone: the laptop's fingerprint helper is not asked, even if this machine has one.
  const real: Sign = async (world) => {
    const options = ["sign", "--repo", world.repo, "--signers", world.signers, "--server", world.server, "--phone"];
    const environment = { ...process.env, LAWS_SIGNER: undefined, LAWS_SIGNERS: undefined };
    return spawnSync(process.execPath, [CLI, ...options], { encoding: "utf8", env: environment }).status;
  };

  test("T-07 blocked: a card whose bite exits 0 is not offered for signing", () => blockedBiteThatPasses(real));
  test("T-07 blocked: a bite that fails only because its file name is misspelled", () => blockedMisspelledBite(real));
  test("T-07 blocked: a bite that fails another way than the card says", () => blockedBiteThatFailsAnotherWay(real));
  test("T-07 blocked: a card above prose grade without a bite", () => blockedMissingBite(real));
  test("T-07 blocked: a toothless card in a batch with a good one", () => blockedToothlessCardInABatch(real));
  test("T-07 allowed: a card whose bite exits 1 is offered and signed", () => allowedBiteThatFails(real));
}
