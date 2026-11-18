// The check of law T-05 (laws/T-05.md): the gate is open only when nothing is waiting.
// This file and its bite are frozen with the card, so everything the check means is written here.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { loadCards } from "../../src/cards.ts";
import { gate } from "../../src/gate.ts";

// What is under test: is the gate of this repository open, given this signers file?
export type IsOpen = (repo: string, signersFile: string) => boolean;

// A temporary folder with two throwaway keys. Only the owner's key is in the signers file.
export type World = { folder: string; signers: string; ownerKey: string; strangerKey: string };
type Batch = { manifest: string; ids: string[]; intact: boolean; versions: Map<string, number> };

const CASES = 200;
const CLI = join(import.meta.dirname, "../../src/cli.ts");
const TEN = ["A-01", "A-02", "A-03", "A-04", "A-05", "A-06", "A-07", "A-08", "A-09", "A-10"];
let repositoryCount = 0;
let batchCount = 0;
let clock = Date.UTC(2026, 0, 1);

// ---- The property. The bite runs the same functions against broken gates. ----

// Blocked by the law: ten cards are approved, one is edited, and the gate still answers open.
export function blockedOneOfTenEdited(isOpen: IsOpen, world: World): void {
  const repo = newRepository(world, "blocked-one-of-ten", TEN);
  approve(repo, TEN, world.ownerKey);
  assert.equal(isOpen(repo, world.signers), true, "ten approved cards must open the gate");
  appendFileSync(join(repo, "laws", "A-07.md"), "And one exception.\n");
  assert.equal(isOpen(repo, world.signers), false, "one of ten cards was edited and the gate stayed open");
}

// Blocked by the law: a new card, and a missing signature.
export function blockedNewCardAndMissingSignature(isOpen: IsOpen, world: World): void {
  const withNewCard = newRepository(world, "blocked-new-card", ["A-01", "A-02"]);
  approve(withNewCard, ["A-01", "A-02"], world.ownerKey);
  writeCard(withNewCard, "A-03");
  assert.equal(isOpen(withNewCard, world.signers), false, "a new card was added and the gate stayed open");

  const withoutSignature = newRepository(world, "blocked-missing-signature", ["A-01", "A-02"]);
  const manifest = approve(withoutSignature, ["A-01", "A-02"], world.ownerKey);
  assert.equal(isOpen(withoutSignature, world.signers), true, "two approved cards must open the gate");
  rmSync(`${manifest}.sig`);
  assert.equal(isOpen(withoutSignature, world.signers), false, "the signature is missing and the gate stayed open");
}

// Allowed by the law: every card is approved and unchanged.
export function allowedEverythingApproved(isOpen: IsOpen, world: World): void {
  const repo = newRepository(world, "allowed-all-approved", ["A-01", "A-02", "A-03"]);
  assert.equal(isOpen(repo, world.signers), false, "nothing is approved yet and the gate is open");
  approve(repo, ["A-01", "A-03"], world.ownerKey);
  assert.equal(isOpen(repo, world.signers), false, "A-02 is not approved yet and the gate is open");
  approve(repo, ["A-02"], world.ownerKey);
  assert.equal(isOpen(repo, world.signers), true, "every card is approved and unchanged, and the gate is closed");
}

// Over generated histories: every card starts approved, then things happen. The gate is open exactly
// when every card is listed, as it is now, in a manifest that still carries the owner's signature.
export function openOnlyWhenNothingIsWaiting(isOpen: IsOpen, world: World, firstSeed: number): void {
  let opened = 0;
  for (let seed = firstSeed; seed < firstSeed + CASES; seed++) {
    const random = generator(seed);
    const ids = TEN.slice(0, 1 + int(random, 5));
    const repo = newRepository(world, `case-${seed}`, ids);
    const version = new Map(ids.map((id) => [id, 0]));
    const batches: Batch[] = [];
    const ownerApproves = (batchIds: string[]): void => {
      batches.push({ manifest: approve(repo, batchIds, world.ownerKey), ids: batchIds, intact: true, versions: new Map(version) });
    };
    const split = int(random, ids.length);
    ownerApproves(ids.slice(split));
    if (split > 0) ownerApproves(ids.slice(0, split));

    const story: string[] = [];
    const events = int(random, 4);
    for (let event = 0; event < events; event++) {
      const id = ids[int(random, ids.length)] ?? "A-01";
      const batch = batches[int(random, batches.length)];
      if (batch === undefined) throw new Error("there is always a first batch");
      const kind = int(random, 9);
      if (kind === 0) {
        writeFileSync(join(repo, "notes.txt"), `note ${event}\n`);
        story.push("a file that no card lists changes");
      } else if (kind === 1) {
        approve(repo, [id], world.strangerKey);
        story.push(`a stranger signs ${id}`);
      } else if (kind === 2 || kind === 3) {
        const file = kind === 2 ? join(repo, "laws", `${id}.md`) : join(repo, "frozen", `${id}.txt`);
        appendFileSync(file, "x");
        version.set(id, (version.get(id) ?? 0) + 1);
        story.push(kind === 2 ? `the card ${id} is edited` : `the frozen file of ${id} is edited`);
      } else if (kind === 4) {
        const added = `N-0${event}`;
        writeCard(repo, added);
        ids.push(added);
        version.set(added, 0);
        story.push(`the new card ${added} appears`);
      } else if (kind === 5) {
        rmSync(`${batch.manifest}.sig`, { force: true });
        batch.intact = false;
        story.push(`the signature over ${batch.ids.join("+")} is deleted`);
      } else if (kind === 6) {
        rmSync(`${batch.manifest}.sig`, { force: true });
        run("ssh-keygen", ["-Y", "sign", "-f", world.strangerKey, "-n", "laws", batch.manifest]);
        batch.intact = false;
        story.push(`the signature over ${batch.ids.join("+")} is replaced by a stranger's`);
      } else {
        ownerApproves([...ids]);
        story.push("the owner approves every card as it is now");
      }
    }

    const expected = ids.every((id) =>
      batches.some((batch) => batch.intact && batch.ids.includes(id) && batch.versions.get(id) === version.get(id)),
    );
    const actual = isOpen(repo, world.signers);
    const told = story.length > 0 ? story.join("; ") : "nothing";
    assert.equal(actual, expected, `wrong answer after all cards were approved and then: ${told} (replay with LAWS_SEED=${seed})`);
    if (actual) opened += 1;
    rmSync(repo, { recursive: true, force: true });
  }
  assert.ok(opened > CASES / 10 && opened < CASES - CASES / 10, `one-sided cases: ${opened} of ${CASES} were open`);
}

export function firstSeed(): number {
  return Number(process.env["LAWS_SEED"] ?? Date.now() % 1_000_000_000);
}

export function newWorld(): World {
  const folder = mkdtempSync(join(tmpdir(), "laws-t05-"));
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
  mkdirSync(join(repo, "frozen"));
  for (const id of ids) writeCard(repo, id);
  return repo;
}

// A card that freezes one file, frozen/<id>.txt.
function writeCard(repo: string, id: string): void {
  const frontMatter = `---\nid: ${id}\ngrade: chosen\ncheck: true\nbite: false\nfrozen: [frozen/${id}.txt]\n---\n`;
  writeFileSync(join(repo, "laws", `${id}.md`), `${frontMatter}# ${id} A law\n`);
  writeFileSync(join(repo, "frozen", `${id}.txt`), "the first version\n");
}

// Stores a manifest of these cards as they are now, signed with the given key. Returns the manifest file.
// A manifest starts with the time it was signed; here each one is a second later than the one before.
function approve(repo: string, ids: string[], key: string): string {
  const cards = loadCards(repo);
  const line = (id: string): string => {
    const card = cards.find((candidate) => candidate.id === id);
    if (card === undefined || !card.ok) throw new Error(`the test card ${id} must load`);
    return `${id} ${card.hash}\n`;
  };
  batchCount += 1;
  clock += 1000;
  const manifest = join(repo, "laws", "approvals", `batch-${batchCount}.manifest`);
  writeFileSync(manifest, `signed: ${new Date(clock).toISOString()}\n${[...ids].sort().map(line).join("")}`);
  run("ssh-keygen", ["-Y", "sign", "-f", key, "-n", "laws", manifest]);
  return manifest;
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

// ---- The check: the property against the real gate, and the laws command. ----

// Runs "laws gate" and returns its exit code and what it printed.
function lawsGate(repo: string, signersFile: string): [number | null, string] {
  const result = spawnSync(process.execPath, [CLI, "gate", "--repo", repo, "--signers", signersFile], {
    encoding: "utf8",
  });
  return [result.status, result.stdout];
}

if (import.meta.main) {
  const real: IsOpen = (repo, signersFile) => gate(repo, signersFile).open;
  const world = newWorld();
  after(() => removeWorld(world));

  test("T-05 blocked: ten cards approved, one edited", () => blockedOneOfTenEdited(real, world));
  test("T-05 blocked: a new card, a missing signature", () => blockedNewCardAndMissingSignature(real, world));
  test("T-05 allowed: every card approved and unchanged", () => allowedEverythingApproved(real, world));
  test(`T-05 open only when nothing is waiting, over ${CASES} generated histories`, () => {
    openOnlyWhenNothingIsWaiting(real, world, firstSeed());
  });

  test("T-05 laws gate prints open and exits 0, or closed with the reason and exits 1", () => {
    const repo = newRepository(world, "command", ["A-01", "A-02"]);
    approve(repo, ["A-01", "A-02"], world.ownerKey);
    assert.deepEqual(lawsGate(repo, world.signers), [0, "open\n"]);

    appendFileSync(join(repo, "frozen", "A-02.txt"), "x");
    const [exitCode, printed] = lawsGate(repo, world.signers);
    assert.equal(exitCode, 1);
    assert.match(printed, /^closed\n/);
    assert.match(printed, /A-02/);
    assert.doesNotMatch(printed, /open/);
  });

  test("T-05 laws gate is closed without a signers file, and with no cards", () => {
    const repo = newRepository(world, "no-signers", ["A-01"]);
    approve(repo, ["A-01"], world.ownerKey);
    assert.equal(lawsGate(repo, join(world.folder, "no-such-file"))[0], 1);

    const empty = newRepository(world, "no-cards", []);
    assert.match(lawsGate(empty, world.signers)[1], /^closed\n/);
  });
}
