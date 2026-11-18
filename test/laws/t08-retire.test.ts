// The check of law T-08 (laws/T-08.md): a law can only be removed by you.
// This file and its bite are frozen with the card, so everything the check means is written here.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { loadCards } from "../../src/cards.ts";
import { gate } from "../../src/gate.ts";
import { verifyRepo } from "../../src/verify.ts";

// What is under test: is the gate of this repository open, given this signers file?
export type IsOpen = (repo: string, signersFile: string) => boolean;

// A temporary folder with two throwaway keys. Only the owner's key is in the signers file.
export type World = { folder: string; signers: string; ownerKey: string; strangerKey: string };

// What one signed manifest says about a card: the version it approves, or that it retires the card.
type Signed = { time: number; byOwner: boolean; says: Map<string, number | "retired"> };

const CASES = 200;
const CLI = join(import.meta.dirname, "../../src/cli.ts");
const REAL_SIGNER = join(import.meta.dirname, "../../signer/signer.ts");
const IDS = ["A-01", "A-02", "A-03", "A-04"];
let repositoryCount = 0;
let manifestCount = 0;
let clock = Date.UTC(2026, 0, 1);

// ---- The property. The bite runs the same functions against broken gates. ----

// Blocked by the law: an approved card's file is deleted, and the gate still answers open.
export function blockedApprovedCardDeleted(isOpen: IsOpen, world: World): void {
  const repo = newRepository(world, "blocked-deleted", ["A-01", "A-02"]);
  sign(repo, world.ownerKey, ["A-01", "A-02"], []);
  assert.equal(isOpen(repo, world.signers), true, "two approved cards must open the gate");
  rmSync(join(repo, "laws", "A-02.md"));
  assert.equal(isOpen(repo, world.signers), false, "an approved card's file was deleted and the gate stayed open");
}

// Allowed by the law: you sign the retirement of a card. Its file can then be removed, and the gate stays open.
export function allowedSignedRetirement(isOpen: IsOpen, world: World): void {
  const repo = newRepository(world, "allowed-retired", ["A-01", "A-02"]);
  sign(repo, world.ownerKey, ["A-01", "A-02"], []);
  sign(repo, world.ownerKey, [], ["A-02"]);
  rmSync(join(repo, "laws", "A-02.md"));
  assert.equal(isOpen(repo, world.signers), true, "a card was retired with a signature and removed, and the gate closed");
}

// A retirement that the owner did not sign removes nothing.
export function blockedRetirementByAStranger(isOpen: IsOpen, world: World): void {
  const repo = newRepository(world, "blocked-stranger", ["A-01", "A-02"]);
  sign(repo, world.ownerKey, ["A-01", "A-02"], []);
  sign(repo, world.strangerKey, [], ["A-02"]);
  rmSync(join(repo, "laws", "A-02.md"));
  assert.equal(isOpen(repo, world.signers), false, "a stranger retired a card, it was deleted, and the gate stayed open");
}

// A retired card does not come back by itself, and a retirement covers only what was signed before it.
// "Before" is the signed time inside the manifest. The names of the files mean nothing.
export function blockedRetiredCardComesBack(isOpen: IsOpen, world: World): void {
  const repo = newRepository(world, "blocked-comes-back", ["A-01", "A-02"]);
  sign(repo, world.ownerKey, ["A-01", "A-02"], []);
  sign(repo, world.ownerKey, [], ["A-02"]);
  rmSync(join(repo, "laws", "A-02.md"));
  assert.equal(isOpen(repo, world.signers), true, "a signed retirement must let the file go");

  writeCard(repo, "A-02", 0);
  assert.equal(isOpen(repo, world.signers), false, "a retired card came back without a new signature and the gate stayed open");
  sign(repo, world.ownerKey, ["A-02"], []);
  assert.equal(isOpen(repo, world.signers), true, "a retired card that was signed again must be approved");

  rmSync(join(repo, "laws", "A-02.md"));
  assert.equal(isOpen(repo, world.signers), false, "a card approved after its retirement was deleted and the gate stayed open");
  let next = 1;
  renameManifests(repo, () => (next -= 0.1));
  assert.equal(isOpen(repo, world.signers), false, "renaming the manifest files changed the answer");
}

// Over generated histories of approving, retiring, deleting, restoring and renaming: the gate is open
// exactly when every card file is approved as it is now, by an owner's manifest later than the card's
// last retirement, and every card with such an approval still has its file.
export function removedOnlyBySignedRetirement(isOpen: IsOpen, world: World, firstSeed: number): void {
  let opened = 0;
  for (let seed = firstSeed; seed < firstSeed + CASES; seed++) {
    const random = generator(seed);
    const ids = IDS.slice(0, 2 + int(random, 3));
    const repo = newRepository(world, `case-${seed}`, ids);
    const present = new Map(ids.map((id) => [id, 0])); // id -> the version of its file
    const newestVersion = new Map(present);
    const signed: Signed[] = [];
    const story: string[] = [];
    const record = (key: string, approve: string[], retire: string[]): void => {
      const says = new Map<string, number | "retired">();
      for (const id of approve) says.set(id, present.get(id) ?? 0);
      for (const id of retire) says.set(id, "retired");
      signed.push({ time: sign(repo, key, approve, retire), byOwner: key === world.ownerKey, says });
    };
    record(world.ownerKey, ids, []);

    const events = 1 + int(random, 5);
    for (let event = 0; event < events; event++) {
      const id = ids[int(random, ids.length)] ?? "A-01";
      const here = [...present.keys()];
      const kind = int(random, 10);
      if (kind === 0 && here.length > 0) {
        record(world.ownerKey, here, []);
        story.push("the owner approves every card that is there");
      } else if (kind <= 2 && present.has(id)) {
        const who = kind === 1 ? "the owner" : "a stranger";
        record(kind === 1 ? world.ownerKey : world.strangerKey, [], [id]);
        story.push(`${who} retires ${id}`);
      } else if (kind === 3 && present.has(id)) {
        record(world.ownerKey, here.filter((other) => other !== id), [id]);
        story.push(`the owner retires ${id} and approves the rest in one batch`);
      } else if (kind <= 5 && present.has(id)) {
        rmSync(join(repo, "laws", `${id}.md`));
        present.delete(id);
        story.push(`the file of ${id} is deleted`);
      } else if (kind <= 7) {
        const newest = newestVersion.get(id) ?? 0;
        const version = random() < 0.5 ? newest + 1 : int(random, newest + 1);
        newestVersion.set(id, Math.max(newest, version));
        writeCard(repo, id, version);
        present.set(id, version);
        story.push(`${id} is written as version ${version}`);
      } else if (kind === 8 && present.has(id)) {
        record(world.ownerKey, [id], []);
        story.push(`the owner approves ${id}`);
      } else {
        renameManifests(repo, random);
        story.push("the manifest files are renamed");
      }
    }

    const liveVersions = (id: string): Set<number> => {
      const byOwner = signed.filter((manifest) => manifest.byOwner && manifest.says.has(id));
      const retiredAt = Math.max(0, ...byOwner.filter((manifest) => manifest.says.get(id) === "retired").map((manifest) => manifest.time));
      const live = new Set<number>();
      for (const manifest of byOwner) {
        const says = manifest.says.get(id);
        if (says !== undefined && says !== "retired" && manifest.time > retiredAt) live.add(says);
      }
      return live;
    };
    const everyFileApproved = [...present].every(([id, version]) => liveVersions(id).has(version));
    const nothingMissing = ids.every((id) => liveVersions(id).size === 0 || present.has(id));
    const expected = present.size > 0 && everyFileApproved && nothingMissing;

    const actual = isOpen(repo, world.signers);
    assert.equal(actual, expected, `wrong answer after all cards were approved and then: ${story.join("; ")} (replay with LAWS_SEED=${seed})`);
    if (actual) opened += 1;
    rmSync(repo, { recursive: true, force: true });
  }
  assert.ok(opened > CASES / 10 && opened < CASES - CASES / 10, `one-sided cases: ${opened} of ${CASES} were open`);
}

export function firstSeed(): number {
  return Number(process.env["LAWS_SEED"] ?? Date.now() % 1_000_000_000);
}

export function newWorld(): World {
  const folder = mkdtempSync(join(tmpdir(), "laws-t08-"));
  const world = {
    folder,
    signers: join(folder, "allowed_signers"),
    ownerKey: join(folder, "owner-key"),
    strangerKey: join(folder, "stranger-key"),
  };
  run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", world.ownerKey]);
  run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", world.strangerKey]);
  writeFileSync(world.signers, `owner ${readFileSync(`${world.ownerKey}.pub`, "utf8")}`);
  return world;
}

export function removeWorld(world: World): void {
  rmSync(world.folder, { recursive: true, force: true });
}

function newRepository(world: World, name: string, ids: string[]): string {
  repositoryCount += 1;
  const repo = join(world.folder, `${name}-${repositoryCount}`);
  mkdirSync(join(repo, "laws", "approvals"), { recursive: true });
  for (const id of ids) writeCard(repo, id, 0);
  return repo;
}

// The same id and version always give the same bytes, so an old version can come back exactly.
function writeCard(repo: string, id: string, version: number): void {
  const frontMatter = `---\nid: ${id}\ngrade: chosen\ncheck: true\n---\n`;
  writeFileSync(join(repo, "laws", `${id}.md`), `${frontMatter}# ${id} The law of ${id}\n\nVersion ${version}.\n`);
}

// Stores a manifest signed with the given key: these cards approved as they are now, those retired.
// Each manifest is dated a second later than the one before. Returns that time.
function sign(repo: string, key: string, approve: string[], retire: string[]): number {
  const cards = loadCards(repo);
  const lines = new Map<string, string>(retire.map((id) => [id, "retired"]));
  for (const id of approve) {
    const card = cards.find((candidate) => candidate.id === id);
    if (card === undefined || !card.ok) throw new Error(`the test card ${id} must load`);
    lines.set(id, card.hash);
  }
  manifestCount += 1;
  clock += 1000;
  const manifest = join(repo, "laws", "approvals", `m${manifestCount}.manifest`);
  const text = [...lines.keys()].sort().map((id) => `${id} ${lines.get(id)}\n`).join("");
  writeFileSync(manifest, `signed: ${new Date(clock).toISOString()}\n${text}`);
  run("ssh-keygen", ["-Y", "sign", "-f", key, "-n", "laws", manifest]);
  return clock;
}

// Gives every manifest and its signature a new name, so that the names sort in another order.
function renameManifests(repo: string, random: () => number): void {
  const folder = join(repo, "laws", "approvals");
  for (const name of readdirSync(folder).filter((file) => file.endsWith(".manifest"))) {
    manifestCount += 1;
    const renamed = `${String(int(random, 1000)).padStart(3, "0")}-r${manifestCount}.manifest`;
    renameSync(join(folder, name), join(folder, renamed));
    renameSync(join(folder, `${name}.sig`), join(folder, `${renamed}.sig`));
  }
}

function run(program: string, options: string[]): string {
  const result = spawnSync(program, options, { encoding: "utf8" });
  assert.equal(result.status, 0, `${program} ${options.join(" ")} failed: ${result.stderr}`);
  return result.stdout;
}

// A small seeded generator (mulberry32). The same seed always gives the same cases.
function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

function int(random: () => number, below: number): number {
  return Math.floor(random() * below);
}

// ---- The check: the property against the real gate, and "laws retire" through the real signer. ----

if (import.meta.main) {
  const real: IsOpen = (repo, signersFile) => {
    const open = gate(repo, signersFile).open;
    assert.equal(verifyRepo(repo, signersFile).ok, open, "laws verify and laws gate must give the same answer");
    return open;
  };
  const world = newWorld();
  after(() => removeWorld(world));

  test("T-08 blocked: an approved card's file is deleted", () => blockedApprovedCardDeleted(real, world));
  test("T-08 allowed: a signed retirement, then the file is removed", () => allowedSignedRetirement(real, world));
  test("T-08 a retirement signed by a stranger removes nothing", () => blockedRetirementByAStranger(real, world));
  test("T-08 a retired card does not come back by itself", () => blockedRetiredCardComesBack(real, world));
  test(`T-08 removed only by a signed retirement, over ${CASES} generated histories`, () => {
    removedOnlyBySignedRetirement(real, world, firstSeed());
  });

  test("T-08 laws retire asks the signer, which shows the title, and the card can then be removed", () => {
    const repo = newRepository(world, "command", ["A-01", "A-02"]);
    sign(repo, world.ownerKey, ["A-01", "A-02"], []);

    // The signer needs a person at a terminal. This stand-in runs the real signer and types the word.
    const standIn = join(world.folder, "signer-with-a-person.mjs");
    const typesTheWord = `process.exitCode = runSigner(process.argv.slice(2), (word) => word, (line) => console.log(line));`;
    writeFileSync(standIn, `import { runSigner } from ${JSON.stringify(REAL_SIGNER)};\n${typesTheWord}\n`);
    const signer = `'${process.execPath}' '${standIn}' --key '${world.ownerKey}' --log '${join(world.folder, "signer.log")}'`;
    const laws = (words: string[]): { exitCode: number | null; printed: string } => {
      const result = spawnSync(process.execPath, [CLI, ...words, "--repo", repo, "--signers", world.signers, "--signer", signer], {
        encoding: "utf8",
      });
      return { exitCode: result.status, printed: result.stdout + result.stderr };
    };

    const retired = laws(["retire", "A-02"]);
    assert.equal(retired.exitCode, 0, retired.printed);
    assert.match(retired.printed, /^ *retire +A-02 +The law of A-02$/m, "the signer must show what it retires, with the title");
    assert.ok(existsSync(join(repo, "laws", "A-02.md")), "laws retire removes no file itself");

    rmSync(join(repo, "laws", "A-02.md"));
    assert.equal(laws(["gate"]).printed, "open\n");
    assert.equal(laws(["verify"]).exitCode, 0);
    assert.match(laws(["status"]).printed, /^A-02 .*retired/m, "status must show the retired card");

    const gone = laws(["retire", "A-02"]);
    assert.notEqual(gone.exitCode, 0, "a card that is not there cannot be retired");
  });
}
