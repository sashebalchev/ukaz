// The check of law T-02 (laws/T-02.md): approved means signed, by a key you named, over the card as it is now.
// This file and its bite are frozen with the card, so everything the check means is written here.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { loadCards } from "../../src/cards.ts";
import { verifyRepo } from "../../src/verify.ts";

// What is under test: does this repository verify against this signers file?
export type Verify = (repo: string, signersFile: string) => boolean;

// A temporary folder with two throwaway keys. Only the owner's key is in the signers file.
export type World = { folder: string; signers: string; ownerKey: string; strangerKey: string };
type Batch = { manifest: string; ids: string[]; byOwner: boolean; intact: boolean; versions: Map<string, number> };

const CASES = 200;
const CLI = join(import.meta.dirname, "../../src/cli.ts");
let repositoryCount = 0;
let batchCount = 0;
let clock = Date.UTC(2026, 0, 1);

// ---- The property. The bite runs the same functions against broken ways to verify. ----

// Blocked by the law: a key is added to a file inside the repository and a card is signed with it.
export function blockedKeyInsideTheRepository(verify: Verify, world: World): void {
  const repo = newRepository(world, "blocked-key-inside", ["A-01"]);
  plantSignersInside(world, repo);
  approve(repo, ["A-01"], world.strangerKey);
  assert.equal(verify(repo, world.signers), false, "a card signed with a key from inside the repository verified");
}

// Blocked by the law: a signature made for an earlier version of the card.
export function blockedEarlierVersion(verify: Verify, world: World): void {
  const repo = newRepository(world, "blocked-earlier-version", ["A-01", "B-02"]);
  approve(repo, ["A-01", "B-02"], world.ownerKey);
  assert.equal(verify(repo, world.signers), true, "two freshly approved cards must verify");
  appendFileSync(join(repo, "laws", "B-02.md"), "One more sentence.\n");
  assert.equal(verify(repo, world.signers), false, "a signature for an earlier version of the card still counted");
}

// Allowed by the law: two cards approved in one batch under one signature.
export function allowedTwoCardsOneSignature(verify: Verify, world: World): void {
  const repo = newRepository(world, "allowed-one-batch", ["A-01", "B-02"]);
  assert.equal(verify(repo, world.signers), false, "cards that nobody approved verified");
  approve(repo, ["A-01", "B-02"], world.ownerKey);
  assert.equal(verify(repo, world.signers), true, "two cards under one good signature did not verify");
}

// Over generated histories of signing, editing and tampering: the repository verifies exactly when
// every card has an untouched manifest, signed by the owner, that lists the card as it is now.
export function onlyCurrentOwnerSignaturesCount(verify: Verify, world: World, firstSeed: number): void {
  let verified = 0;
  for (let seed = firstSeed; seed < firstSeed + CASES; seed++) {
    const random = generator(seed);
    const ids = ["A-01", "B-02", "C-03"].slice(0, 1 + int(random, 3));
    const repo = newRepository(world, `case-${seed}`, ids);
    const version = new Map(ids.map((id) => [id, 0]));
    const batches: Batch[] = [];
    const story: string[] = [];

    const steps = 1 + int(random, 5);
    for (let step = 0; step < steps; step++) {
      const id = ids[int(random, ids.length)] ?? "A-01";
      const kind = int(random, 10);
      if (kind < 6) {
        const byOwner = kind < 4;
        const some = ids.filter(() => random() < 0.5);
        const batchIds = random() < 0.5 ? ids : some.length > 0 ? some : [id];
        const manifest = approve(repo, batchIds, byOwner ? world.ownerKey : world.strangerKey);
        batches.push({ manifest, ids: batchIds, byOwner, intact: true, versions: new Map(version) });
        story.push(`${byOwner ? "the owner" : "a stranger"} signs ${batchIds.join("+")}`);
      } else if (kind < 8) {
        const file = random() < 0.5 ? join(repo, "laws", `${id}.md`) : join(repo, "frozen", `${id}.txt`);
        appendFileSync(file, "x");
        version.set(id, (version.get(id) ?? 0) + 1);
        story.push(`${id} is edited`);
      } else if (kind === 8) {
        plantSignersInside(world, repo);
        story.push("the stranger's key is added inside the repository");
      } else {
        const batch = batches[int(random, batches.length)];
        if (batch === undefined) continue;
        const signedLine = readFileSync(batch.manifest, "utf8").split("\n")[0];
        const forged = `${signedLine}\n${linesNow(repo, batch.ids)}`;
        if (forged !== readFileSync(batch.manifest, "utf8")) {
          writeFileSync(batch.manifest, forged);
          batch.intact = false;
        }
        story.push(`the manifest of ${batch.ids.join("+")} is rewritten under its old signature`);
      }
    }

    const expected = ids.every((id) =>
      batches.some(
        (batch) => batch.byOwner && batch.intact && batch.ids.includes(id) && batch.versions.get(id) === version.get(id),
      ),
    );
    const actual = verify(repo, world.signers);
    assert.equal(actual, expected, `wrong answer after: ${story.join("; ")} (replay with LAWS_SEED=${seed})`);
    if (actual) verified += 1;
    rmSync(repo, { recursive: true, force: true });
  }
  assert.ok(verified > CASES / 10 && verified < CASES - CASES / 10, `one-sided cases: ${verified} of ${CASES} verified`);
}

export function firstSeed(): number {
  return Number(process.env["LAWS_SEED"] ?? Date.now() % 1_000_000_000);
}

export function newWorld(): World {
  const folder = mkdtempSync(join(tmpdir(), "laws-t02-"));
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

// A repository where each card freezes one file, frozen/<id>.txt.
function newRepository(world: World, name: string, ids: string[]): string {
  repositoryCount += 1;
  const repo = join(world.folder, `${name}-${repositoryCount}`);
  mkdirSync(join(repo, "laws", "approvals"), { recursive: true });
  mkdirSync(join(repo, "frozen"));
  for (const id of ids) {
    const frontMatter = `---\nid: ${id}\ngrade: chosen\ncheck: true\nbite: false\nfrozen: [frozen/${id}.txt]\n---\n`;
    writeFileSync(join(repo, "laws", `${id}.md`), `${frontMatter}# ${id} A law\n`);
    writeFileSync(join(repo, "frozen", `${id}.txt`), "the first version\n");
  }
  return repo;
}

// The manifest lines "<id> <hash>" for these cards as they are now.
function linesNow(repo: string, ids: string[]): string {
  const cards = loadCards(repo);
  const line = (id: string): string => {
    const card = cards.find((candidate) => candidate.id === id);
    if (card === undefined || !card.ok) throw new Error(`the test card ${id} must load`);
    return `${id} ${card.hash}\n`;
  };
  return [...ids].sort().map(line).join("");
}

// Stores a manifest of these cards as they are now, signed with the given key. Returns the manifest file.
// A manifest starts with the time it was signed; here each one is a second later than the one before.
function approve(repo: string, ids: string[], key: string): string {
  batchCount += 1;
  clock += 1000;
  const manifest = join(repo, "laws", "approvals", `batch-${batchCount}.manifest`);
  writeFileSync(manifest, `signed: ${new Date(clock).toISOString()}\n${linesNow(repo, ids)}`);
  run("ssh-keygen", ["-Y", "sign", "-f", key, "-n", "laws", manifest]);
  return manifest;
}

// The attack: a signers file inside the repository that names the stranger's key as the owner.
function plantSignersInside(world: World, repo: string): string {
  const inside = join(repo, "laws", "allowed_signers");
  writeFileSync(inside, `owner ${readFileSync(`${world.strangerKey}.pub`, "utf8")}`);
  return inside;
}

function run(program: string, options: string[], environment: Record<string, string> = {}): string {
  const result = spawnSync(program, options, { encoding: "utf8", env: { ...process.env, ...environment } });
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

// ---- The check: the property against the real code, and the laws command on the signers file. ----

// Runs "laws verify" and returns its exit code and everything it printed.
function lawsVerify(repo: string, options: string[], environment: Record<string, string> = {}): [number | null, string] {
  const result = spawnSync(process.execPath, [CLI, "verify", "--repo", repo, ...options], {
    encoding: "utf8",
    env: { ...process.env, ...environment },
  });
  return [result.status, result.stdout + result.stderr];
}

if (import.meta.main) {
  const real: Verify = (repo, signersFile) => verifyRepo(repo, signersFile).ok;
  const world = newWorld();
  after(() => removeWorld(world));

  test("T-02 blocked: a key added inside the repository", () => blockedKeyInsideTheRepository(real, world));
  test("T-02 blocked: a signature for an earlier version of the card", () => blockedEarlierVersion(real, world));
  test("T-02 allowed: two cards under one signature", () => allowedTwoCardsOneSignature(real, world));
  test(`T-02 only current signatures by the owner count, over ${CASES} generated histories`, () => {
    onlyCurrentOwnerSignaturesCount(real, world, firstSeed());
  });

  test("T-02 laws verify exits 0 with the signers file outside the repository, 1 when a card changes", () => {
    const repo = newRepository(world, "command", ["A-01", "B-02"]);
    approve(repo, ["A-01", "B-02"], world.ownerKey);
    assert.equal(lawsVerify(repo, ["--signers", world.signers])[0], 0);
    assert.equal(lawsVerify(repo, [], { LAWS_SIGNERS: world.signers })[0], 0);
    appendFileSync(join(repo, "frozen", "A-01.txt"), "x");
    const [exitCode, printed] = lawsVerify(repo, ["--signers", world.signers]);
    assert.equal(exitCode, 1);
    assert.match(printed, /A-01/);
  });

  test("T-02 laws verify refuses a signers file inside the repository, however it is named", () => {
    const repo = newRepository(world, "refusal", ["A-01"]);
    // Even with the owner's own key in it: the place is what is wrong.
    const inside = join(repo, "laws", "allowed_signers");
    writeFileSync(inside, readFileSync(world.signers, "utf8"));
    approve(repo, ["A-01"], world.ownerKey);
    assert.equal(lawsVerify(repo, ["--signers", world.signers])[0], 0);

    const linkToInside = join(world.folder, "link-to-inside");
    symlinkSync(inside, linkToInside);
    const linkInsideToOutside = join(repo, "link-to-outside");
    symlinkSync(world.signers, linkInsideToOutside);

    const attempts: [string[], Record<string, string>][] = [
      [["--signers", inside], {}],
      [[], { LAWS_SIGNERS: inside }],
      [["--signers", linkToInside], {}],
      [["--signers", linkInsideToOutside], {}],
    ];
    for (const [options, environment] of attempts) {
      const [exitCode, printed] = lawsVerify(repo, options, environment);
      assert.equal(exitCode, 1, `verify passed with ${JSON.stringify([options, environment])}`);
      assert.match(printed, /inside the repository/);
    }
  });

  test("T-02 laws verify fails when there is no signers file", () => {
    const repo = newRepository(world, "no-signers", ["A-01"]);
    approve(repo, ["A-01"], world.ownerKey);
    const [exitCode, printed] = lawsVerify(repo, ["--signers", join(world.folder, "no-such-file")]);
    assert.equal(exitCode, 1);
    assert.match(printed, /no signers file/);
  });
}
