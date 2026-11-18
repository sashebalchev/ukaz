// The check of law T-07 (laws/T-07.md): a law without teeth cannot be signed.
// This file and its bite are frozen with the card, so everything the check means is written here.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { verifyRepo } from "../../src/verify.ts";

// What is under test: "laws sign" on the world's repository, for every card that is waiting.
// It returns the exit code.
export type Sign = (world: World) => number | null;

// A temporary folder: a repository, a throwaway key, the signers file that names it, and a signer
// command that keeps a log. The signer needs a person at a terminal, so the command is a stand-in:
// it runs the real signer and types the word that the signer asks for.
export type World = { folder: string; repo: string; signers: string; signerCommand: string; log: string };

const CLI = join(import.meta.dirname, "../../src/cli.ts");
const REAL_SIGNER = join(import.meta.dirname, "../../signer/signer.ts");
// A bite that fails and says what the card expects it to say.
const SAYS = "bite-says: the blocked case was caught";
const GOOD_BITE = ["bite: echo the blocked case was caught; exit 1", SAYS];

// ---- The property. The bite runs the same functions against a broken variant. ----

// Blocked by the law: a card whose bite command exits 0 is offered for signing.
export function blockedBiteThatPasses(sign: Sign): void {
  withWorld((world) => {
    writeCard(world, "A-01", ["grade: chosen", "check: true", "bite: echo the blocked case was caught", SAYS]);
    assert.notEqual(sign(world), 0, "laws sign succeeded for a card whose bite passes");
    assertNotOffered(world, "A-01", "its bite exits 0");
  });
}

// Blocked by the law: a bite that fails only because its file name is misspelled.
export function blockedMisspelledBite(sign: Sign): void {
  withWorld((world) => {
    const bite = `bite: '${process.execPath}' --test test/laws/mispelled.bite.test.ts`;
    writeCard(world, "A-01", ["grade: chosen", "check: true", bite, SAYS]);
    assert.notEqual(sign(world), 0, "laws sign succeeded for a bite that fails only because its file name is misspelled");
    assertNotOffered(world, "A-01", "its bite fails only because the file name is misspelled");
  });
}

// Also refused: a bite that fails and says something else, and a card that does not say what its bite prints.
export function blockedBiteThatFailsAnotherWay(sign: Sign): void {
  withWorld((world) => {
    writeCard(world, "A-01", ["grade: chosen", "check: true", "bite: echo something else broke; exit 1", SAYS]);
    assert.notEqual(sign(world), 0, "laws sign succeeded for a bite that fails without the text of bite-says");
    assertNotOffered(world, "A-01", "its bite does not print the text of bite-says");
  });
  withWorld((world) => {
    writeCard(world, "A-01", ["grade: chosen", "check: true", "bite: echo the blocked case was caught; exit 1"]);
    assert.notEqual(sign(world), 0, "laws sign succeeded for a card without bite-says");
    assertNotOffered(world, "A-01", "it has no bite-says");
  });
}

// Also refused: a card above prose grade with no bite at all.
export function blockedMissingBite(sign: Sign): void {
  withWorld((world) => {
    writeCard(world, "A-01", ["grade: generated", "check: true"]);
    assert.notEqual(sign(world), 0, "laws sign succeeded for a card without a bite");
    assertNotOffered(world, "A-01", "it has no bite");
  });
}

// A toothless card is not signed along with good ones.
export function blockedToothlessCardInABatch(sign: Sign): void {
  withWorld((world) => {
    writeCard(world, "A-01", ["grade: chosen", "check: true", ...GOOD_BITE]);
    writeCard(world, "A-02", ["grade: chosen", "check: true", "bite: exit 0", SAYS]);
    sign(world);
    assertNotOffered(world, "A-02", "its bite exits 0");
  });
}

// Allowed by the law: a card whose bite command exits 1 is offered for signing.
export function allowedBiteThatFails(sign: Sign): void {
  withWorld((world) => {
    writeCard(world, "A-01", ["grade: chosen", "check: true", ...GOOD_BITE]);
    writeCard(world, "A-02", ["grade: prose"]);
    assert.equal(sign(world), 0, "laws sign failed for a card whose bite fails as the card says, and a prose card");
    assert.match(signerLog(world), /A-01/, "the card whose bite fails was not offered to the signer");
    assert.equal(verifyRepo(world.repo, world.signers).ok, true, "the cards are not approved after signing");
  });
}

function withWorld(body: (world: World) => void): void {
  const folder = mkdtempSync(join(tmpdir(), "laws-t07-"));
  try {
    const key = join(folder, "key");
    const log = join(folder, "signer.log");
    const standIn = join(folder, "signer-with-a-person.mjs");
    const typesTheWord = "process.exitCode = runSigner(process.argv.slice(2), (word) => word, (line) => console.log(line));";
    writeFileSync(standIn, `import { runSigner } from ${JSON.stringify(REAL_SIGNER)};\n${typesTheWord}\n`);
    const world = {
      folder,
      repo: join(folder, "repo"),
      signers: join(folder, "allowed_signers"),
      signerCommand: `'${process.execPath}' '${standIn}' --key '${key}' --log '${log}'`,
      log,
    };
    mkdirSync(join(world.repo, "laws"), { recursive: true });
    const made = spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key], { encoding: "utf8" });
    assert.equal(made.status, 0, `ssh-keygen failed: ${made.stderr}`);
    writeFileSync(world.signers, `owner ${readFileSync(`${key}.pub`, "utf8")}`);
    body(world);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

function writeCard(world: World, id: string, frontMatter: string[]): void {
  const file = join(world.repo, "laws", `${id}.md`);
  writeFileSync(file, `---\nid: ${id}\n${frontMatter.join("\n")}\n---\n# ${id} A law\n`);
}

// What the signer was asked to sign so far: one line per signing, with the ids.
function signerLog(world: World): string {
  return existsSync(world.log) ? readFileSync(world.log, "utf8") : "";
}

// The card never reached the signer, and no stored manifest lists it.
function assertNotOffered(world: World, id: string, why: string): void {
  assert.doesNotMatch(signerLog(world), new RegExp(id), `${id} was offered to the signer although ${why}`);
  const folder = join(world.repo, "laws", "approvals");
  for (const name of existsSync(folder) ? readdirSync(folder) : []) {
    const text = readFileSync(join(folder, name), "utf8");
    assert.doesNotMatch(text, new RegExp(`^${id} `, "m"), `${id} is in the stored approval ${name} although ${why}`);
  }
}

// ---- The check: the property against the real laws command. ----

if (import.meta.main) {
  const real: Sign = (world) => {
    const options = ["sign", "--repo", world.repo, "--signers", world.signers, "--signer", world.signerCommand];
    return spawnSync(process.execPath, [CLI, ...options], { encoding: "utf8" }).status;
  };

  test("T-07 blocked: a card whose bite exits 0 is not offered for signing", () => blockedBiteThatPasses(real));
  test("T-07 blocked: a bite that fails only because its file name is misspelled", () => blockedMisspelledBite(real));
  test("T-07 blocked: a bite that fails another way than the card says", () => blockedBiteThatFailsAnotherWay(real));
  test("T-07 blocked: a card above prose grade without a bite", () => blockedMissingBite(real));
  test("T-07 blocked: a toothless card in a batch with a good one", () => blockedToothlessCardInABatch(real));
  test("T-07 allowed: a card whose bite exits 1 is offered and signed", () => allowedBiteThatFails(real));
}
