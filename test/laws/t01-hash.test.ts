// The check of law T-01 (laws/T-01.md): a card's hash covers everything that gives it meaning.
// This file and its bite are frozen with the card, so everything the check means is written here.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadCards } from "../../src/cards.ts";
import { hashCard } from "../../src/hash.ts";
import type { FrozenFile } from "../../src/hash.ts";

export type HashFunction = (card: Uint8Array, frozen: FrozenFile[]) => string;
// The hash of one card in a repository, or null if the card cannot be hashed.
export type HashInRepository = (repo: string, id: string) => string | null;
type Change = { card: Uint8Array; frozen: FrozenFile[]; what: string };

const CASES = 400;
const CLI = join(import.meta.dirname, "../../src/cli.ts");

// ---- The property. The bite runs the same two functions against a broken hash. ----

// Blocked by the law: the test file behind a card's check is edited, and the hash stays what was approved.
export function blockedCase(hash: HashFunction): void {
  const card = bytes("---\nid: X-01\ngrade: chosen\nfrozen: [test/x01.test.ts]\n---\n# X-01 Start only when ready\n");
  const approved = hash(card, [{ path: "test/x01.test.ts", bytes: bytes("assert(startIsRefused())\n") }]);
  const edited = hash(card, [{ path: "test/x01.test.ts", bytes: bytes("assert(true)\n") }]);
  assert.notEqual(edited, approved, "the test file behind the check was edited and the hash did not change");
}

// Blocked by the law: the picture on a card is redrawn after approval, and the hash stays what was approved.
// The picture is the figure file the card names and the rendered text that "laws show" prints.
export function blockedPictureRedrawn(hashOf: HashInRepository): void {
  const repo = mkdtempSync(join(tmpdir(), "laws-t01-picture-"));
  try {
    const spec = join(repo, "figures", "X-02.spec.json");
    const rendered = join(repo, "figures", "X-02.txt");
    mkdirSync(join(repo, "laws"));
    mkdirSync(join(repo, "figures"));
    writeFileSync(join(repo, "laws", "X-02.md"), "---\nid: X-02\ngrade: prose\nfigure: figures/X-02.spec.json\n---\n# X-02 Two ports\n");
    writeFileSync(spec, '{ "ports": ["tcp 22", "udp 41641"] }\n');
    writeFileSync(rendered, "tcp 22\nudp 41641\n");
    const approved = hashOf(repo, "X-02");
    assert.ok(approved !== null, "a card with its figure in place must have a hash");

    writeFileSync(spec, '{ "ports": ["tcp 22", "tcp 8101"] }\n');
    assert.notEqual(hashOf(repo, "X-02"), approved, "the figure file was changed and the hash did not change");
    writeFileSync(spec, '{ "ports": ["tcp 22", "udp 41641"] }\n');
    assert.equal(hashOf(repo, "X-02"), approved, "the same bytes must give the same hash again");

    writeFileSync(rendered, "tcp 22\ntcp 8101\n");
    assert.notEqual(hashOf(repo, "X-02"), approved, "the picture was redrawn and the hash did not change");
    rmSync(rendered);
    assert.notEqual(hashOf(repo, "X-02"), approved, "the picture was removed and the hash did not change");

    rmSync(spec);
    assert.equal(hashOf(repo, "X-02"), null, "a card whose figure file is missing got a hash");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

// Over generated cards: listing the same files in another order gives the same hash,
// and one small change to the card, to a frozen file or to its path gives another hash.
export function everyByteCounts(hash: HashFunction, firstSeed: number): void {
  for (let seed = firstSeed; seed < firstSeed + CASES; seed++) {
    const random = generator(seed);
    const replay = `(replay with LAWS_SEED=${seed})`;
    const card = randomBytes(random, 1 + int(random, 120));
    const frozen = randomFiles(random);
    const before = hash(card, frozen);

    assert.equal(hash(card, [...frozen].reverse()), before, `the order of the frozen list changed the hash ${replay}`);
    const change = oneChange(random, card, frozen);
    assert.notEqual(hash(change.card, change.frozen), before, `${change.what}, and the hash stayed the same ${replay}`);
  }
}

export function firstSeed(): number {
  return Number(process.env["LAWS_SEED"] ?? Date.now() % 1_000_000_000);
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

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function randomBytes(random: () => number, length: number): Uint8Array {
  return Uint8Array.from({ length }, () => int(random, 256));
}

// Zero to four files with different paths. Paths use no "x", so "x" is free for new names.
function randomFiles(random: () => number): FrozenFile[] {
  const files = new Map<string, FrozenFile>();
  const count = int(random, 5);
  while (files.size < count) {
    const length = 2 + int(random, 8);
    const path = Array.from({ length }, () => "abc/01.-"[int(random, 8)]).join("");
    files.set(path, { path, bytes: randomBytes(random, int(random, 60)) });
  }
  return [...files.values()];
}

function oneChange(random: () => number, card: Uint8Array, frozen: FrozenFile[]): Change {
  const sorted = [...frozen].sort((a, b) => (a.path < b.path ? -1 : 1));
  const index = int(random, Math.max(sorted.length, 1));
  const file = sorted[index];
  const kind = int(random, 10);
  if (file === undefined || kind === 0) {
    return { card: flipOneByte(random, card), frozen, what: "one byte of the card file changed" };
  }
  const others = [...sorted.slice(0, index), ...sorted.slice(index + 1)];
  const withFile = (path: string, content: Uint8Array): FrozenFile[] => [...others, { path, bytes: content }];
  const first = sorted[0] ?? file;
  const shorterPath = file.path.slice(0, -1);

  if (kind === 1) return { card: Uint8Array.from([...card, 32]), frozen, what: "one byte was added to the card file" };
  if (kind === 2 && file.bytes.length > 0) {
    return { card, frozen: withFile(file.path, flipOneByte(random, file.bytes)), what: "one byte of a frozen file changed" };
  }
  if (kind === 3 && file.bytes.length > 0) {
    return { card, frozen: withFile(file.path, file.bytes.slice(0, -1)), what: "a frozen file lost its last byte" };
  }
  if (kind === 4) return { card, frozen: withFile(`${file.path}x`, file.bytes), what: "a frozen file was renamed" };
  if (kind === 5) return { card, frozen: others, what: "a frozen file left the list" };
  if (kind === 6) {
    return { card, frozen: [...sorted, { path: "x/new", bytes: bytes("") }], what: "an empty frozen file was added" };
  }
  if (kind === 7) {
    // The last byte of the card file moves to the front of the first frozen file.
    const moved = Uint8Array.from([card[card.length - 1] ?? 0, ...first.bytes]);
    const rest = sorted.filter((other) => other !== first);
    return {
      card: card.slice(0, -1),
      frozen: [...rest, { path: first.path, bytes: moved }],
      what: "a byte moved from the end of the card file into the next file",
    };
  }
  if (kind === 8 && others.every((other) => other.path !== shorterPath)) {
    // The last character of a path moves to the front of that file's content.
    const moved = Uint8Array.from([file.path.charCodeAt(file.path.length - 1), ...file.bytes]);
    return { card, frozen: withFile(shorterPath, moved), what: "a character moved from a path into the file's content" };
  }
  return { card, frozen: withFile(file.path, Uint8Array.from([...file.bytes, 10])), what: "one byte was added to a frozen file" };
}

function flipOneByte(random: () => number, content: Uint8Array): Uint8Array {
  const changed = content.slice();
  const at = int(random, changed.length);
  changed[at] = (changed[at] ?? 0) ^ (1 + int(random, 255));
  return changed;
}

// ---- The law's cases, run for real: a repository, a throwaway key, and the laws command. ----

type Approved = { folder: string; repo: string; signers: string };

// A repository with one card X-01 that freezes test/x01.test.ts and has a figure, approved with a throwaway key.
function approvedRepository(): Approved {
  const folder = mkdtempSync(join(tmpdir(), "laws-t01-"));
  const repo = join(folder, "repo");
  const signers = join(folder, "allowed_signers");
  const key = join(folder, "key");
  mkdirSync(join(repo, "laws", "approvals"), { recursive: true });
  mkdirSync(join(repo, "test"));
  mkdirSync(join(repo, "src"));
  mkdirSync(join(repo, "figures"));
  const frontMatter = "id: X-01\ngrade: chosen\ncheck: true\nfrozen: [test/x01.test.ts]\nfigure: figures/X-01.spec.json\n";
  writeFileSync(join(repo, "laws", "X-01.md"), `---\n${frontMatter}---\n# X-01 Start only when ready\n`);
  writeFileSync(join(repo, "figures", "X-01.spec.json"), '{ "steps": ["idle", "cup on scale", "start"] }\n');
  writeFileSync(join(repo, "figures", "X-01.txt"), "idle -> cup on scale -> start\n");
  writeFileSync(join(repo, "test", "x01.test.ts"), "assert(startIsRefused())\n");
  writeFileSync(join(repo, "src", "start.ts"), "export const ready = false;\n");

  run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key]);
  const publicKey = run("ssh-keygen", ["-y", "-f", key]).trim();
  writeFileSync(signers, `tester ${publicKey}\n`);

  const card = loadCards(repo)[0];
  if (card === undefined || !card.ok) throw new Error("the card of the test repository must load");
  const manifest = join(repo, "laws", "approvals", "one.manifest");
  writeFileSync(manifest, `signed: 2026-01-01T00:00:00.000Z\nX-01 ${card.hash}\n`);
  run("ssh-keygen", ["-Y", "sign", "-f", key, "-n", "laws", manifest]);
  return { folder, repo, signers };
}

function run(program: string, options: string[]): string {
  const result = spawnSync(program, options, { encoding: "utf8" });
  assert.equal(result.status, 0, `${program} ${options.join(" ")} failed: ${result.stderr}`);
  return result.stdout;
}

// The state that "laws status" shows for the card X-01.
function shownState(at: Approved): string {
  const status = run(process.execPath, [CLI, "status", "--repo", at.repo, "--signers", at.signers]);
  const line = status.split("\n").find((candidate) => candidate.startsWith("X-01 "));
  return line?.split(/\s+/)[2] ?? `no line for X-01 in: ${status}`;
}

if (import.meta.main) {
  test("T-01 blocked case, on the hash itself", () => blockedCase(hashCard));

  test(`T-01 one changed byte changes the hash, over ${CASES} generated cards`, () => {
    everyByteCounts(hashCard, firstSeed());
  });

  test("T-01 blocked: the test file behind a check is edited after approval", () => {
    const at = approvedRepository();
    try {
      assert.equal(shownState(at), "approved");
      appendFileSync(join(at.repo, "test", "x01.test.ts"), " ");
      assert.equal(shownState(at), "changed", "the frozen test file changed by one byte");
    } finally {
      rmSync(at.folder, { recursive: true, force: true });
    }
  });

  test("T-01 blocked case of the picture, on the hash of a card in a repository", () => {
    blockedPictureRedrawn((repo, id) => {
      const card = loadCards(repo).find((candidate) => candidate.id === id);
      return card !== undefined && card.ok ? card.hash : null;
    });
  });

  test("T-01 blocked: the picture on a card is redrawn after approval", () => {
    for (const file of ["X-01.txt", "X-01.spec.json"]) {
      const at = approvedRepository();
      try {
        assert.equal(shownState(at), "approved");
        appendFileSync(join(at.repo, "figures", file), " ");
        assert.equal(shownState(at), "changed", `figures/${file} changed by one byte`);
      } finally {
        rmSync(at.folder, { recursive: true, force: true });
      }
    }
  });

  test("T-01 blocked: the card file itself is edited after approval", () => {
    const at = approvedRepository();
    try {
      appendFileSync(join(at.repo, "laws", "X-01.md"), "\n");
      assert.equal(shownState(at), "changed", "the card file changed by one byte");
    } finally {
      rmSync(at.folder, { recursive: true, force: true });
    }
  });

  test("T-01 allowed: a file the card does not list changes", () => {
    const at = approvedRepository();
    try {
      appendFileSync(join(at.repo, "src", "start.ts"), "export const more = 1;\n");
      writeFileSync(join(at.repo, "test", "another.test.ts"), "new file\n");
      assert.equal(shownState(at), "approved");
    } finally {
      rmSync(at.folder, { recursive: true, force: true });
    }
  });

  test("T-01 a missing frozen file is an error, not an empty file", () => {
    const at = approvedRepository();
    try {
      rmSync(join(at.repo, "test", "x01.test.ts"));
      const missing = loadCards(at.repo)[0];
      assert.equal(missing?.ok, false, "a card with a missing frozen file must not get a hash");
      assert.equal(shownState(at), "broken");

      writeFileSync(join(at.repo, "test", "x01.test.ts"), "");
      assert.equal(loadCards(at.repo)[0]?.ok, true, "an empty frozen file is a file");
      assert.equal(shownState(at), "changed");
    } finally {
      rmSync(at.folder, { recursive: true, force: true });
    }
  });
}
