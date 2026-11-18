// The check of law T-04 (laws/T-04.md): the signer signs only what it computed and showed.
// This file and its bite are frozen with the card, so everything the check means is written here.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { hashCard } from "../../src/hash.ts";

// What is under test: a signer program, given as the command and its first words.
export type Signer = string[];

type World = { folder: string; repo: string; key: string; signers: string; log: string };
type Answer = { exitCode: number | null; printed: string; out: string };

const REAL_SIGNER = join(import.meta.dirname, "../../signer/signer.ts");
const IDS = ["A-01", "A-02", "A-03"];
const ONE_MEGABYTE = 1024 * 1024;
let outCount = 0;

// ---- The property. The bite runs the same functions against a broken signer. ----

// Allowed by the law: three cards are signed, and the log gains one entry that lists those three.
export function allowedThreeCards(signer: Signer): void {
  withWorld((world) => {
    const before = snapshot(world.repo);
    const answer = sign(signer, world, ["A-03", "A-01", "A-02"]);
    assert.equal(answer.exitCode, 0, `the signer refused three good cards:\n${answer.printed}`);

    // It signed exactly the list of ids and hashes, and the hashes are what the files give.
    const lines = IDS.map((id) => hashLine(world.repo, id));
    const manifest = readFileSync(join(answer.out, "manifest"), "utf8");
    assert.equal(manifest, lines.map((line) => `${line}\n`).join(""), "the manifest is not the three cards with their hashes");
    assertSignatureIsGood(world, answer.out);

    // It showed the id, the title and the hash of each card.
    for (const line of lines) {
      const [id, hash] = line.split(" ");
      const shown = answer.printed.split("\n").find((printed) => printed.includes(`${id}`) && printed.includes(`${hash}`));
      assert.ok(shown?.includes(`The law of ${id}`), `the signer did not show id, hash and title of ${id}:\n${answer.printed}`);
    }

    // The log gained one entry, with the time, the key and the three cards.
    const log = logLines(world);
    assert.equal(log.length, 1, "the log must gain exactly one entry");
    for (const line of lines) {
      const [id, hash] = line.split(" ");
      assert.ok(log[0]?.includes(`${id}`) && log[0]?.includes(`${hash}`), `the log entry does not list ${id} with its hash`);
    }
    assert.ok(log[0]?.includes(fingerprint(world)), "the log entry does not name the key");
    assert.match(log[0] ?? "", /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "the log entry has no time");

    assert.equal(snapshot(world.repo), before, "the signer changed something inside the repository");

    // The hashes come from the files: after an edit, the next signature covers another hash.
    appendFileSync(join(world.repo, "frozen", "A-02.txt"), "x");
    const again = sign(signer, world, ["A-02"]);
    assert.equal(readFileSync(join(again.out, "manifest"), "utf8"), `${hashLine(world.repo, "A-02")}\n`);
    assert.notEqual(hashLine(world.repo, "A-02"), lines[1], "the test edit must change the hash");
    assert.equal(logLines(world).length, 2, "the second signing must add one more log entry");
  });
}

// Blocked by the law: a card lists a frozen file that is a symbolic link to a file outside the
// repository. The signer refuses the whole batch.
export function blockedFrozenLinkToOutside(signer: Signer): void {
  withWorld((world) => {
    const outside = join(world.folder, "outside.txt");
    writeFileSync(outside, "not part of the repository\n");
    rmSync(join(world.repo, "frozen", "A-02.txt"));
    symlinkSync(outside, join(world.repo, "frozen", "A-02.txt"));
    assertNothingSigned(world, sign(signer, world, IDS), "a frozen file is a link to a file outside the repository");
  });
}

// The card file itself is a link to a file outside the repository.
export function refusesCardLinkToOutside(signer: Signer): void {
  withWorld((world) => {
    const outside = join(world.folder, "outside-card.md");
    writeFileSync(outside, readFileSync(join(world.repo, "laws", "A-01.md")));
    rmSync(join(world.repo, "laws", "A-01.md"));
    symlinkSync(outside, join(world.repo, "laws", "A-01.md"));
    assertNothingSigned(world, sign(signer, world, IDS), "a card file is a link to a file outside the repository");
  });
}

// A file of exactly 1 MB is signed. One byte more is refused.
export function refusesFilesOverOneMegabyte(signer: Signer): void {
  withWorld((world) => {
    writeFileSync(join(world.repo, "frozen", "A-03.txt"), Buffer.alloc(ONE_MEGABYTE, 97));
    assert.equal(sign(signer, world, IDS).exitCode, 0, "a frozen file of exactly 1 MB must be accepted");
    rmSync(world.log);
    appendFileSync(join(world.repo, "frozen", "A-03.txt"), "a");
    assertNothingSigned(world, sign(signer, world, IDS), "a frozen file is larger than 1 MB");
  });
}

function withWorld(body: (world: World) => void): void {
  const folder = mkdtempSync(join(tmpdir(), "laws-t04-"));
  try {
    const world = {
      folder,
      repo: join(folder, "repo"),
      key: join(folder, "key"),
      signers: join(folder, "allowed_signers"),
      log: join(folder, "signer.log"),
    };
    mkdirSync(join(world.repo, "laws"), { recursive: true });
    mkdirSync(join(world.repo, "frozen"));
    for (const id of IDS) {
      const frontMatter = `---\nid: ${id}\ngrade: chosen\ncheck: true\nbite: false\nfrozen: [frozen/${id}.txt]\n---\n`;
      writeFileSync(join(world.repo, "laws", `${id}.md`), `${frontMatter}# ${id} The law of ${id}\n`);
      writeFileSync(join(world.repo, "frozen", `${id}.txt`), `what ${id} depends on\n`);
    }
    run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", world.key]);
    writeFileSync(world.signers, `tester ${readFileSync(`${world.key}.pub`, "utf8")}`);
    body(world);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

// Runs the signer on these cards. Each call gets a new empty --out folder unless one is given.
function sign(signer: Signer, world: World, ids: string[], place: { out?: string; log?: string } = {}): Answer {
  outCount += 1;
  const out = place.out ?? join(world.folder, `out-${outCount}`);
  mkdirSync(out, { recursive: true });
  const [program, ...firstWords] = signer;
  const words = ["--repo", world.repo, "--key", world.key, "--log", place.log ?? world.log, "--out", out, ...ids];
  const result = spawnSync(program ?? "", [...firstWords, ...words], { encoding: "utf8" });
  return { exitCode: result.status, printed: result.stdout + result.stderr, out };
}

function assertNothingSigned(world: World, answer: Answer, why: string): void {
  assert.notEqual(answer.exitCode, 0, `the signer did not refuse although ${why}:\n${answer.printed}`);
  assert.ok(!existsSync(join(answer.out, "manifest.sig")), `the signer left a signature although ${why}`);
  assert.ok(!existsSync(join(answer.out, "manifest")), `the signer left a manifest although ${why}`);
  assert.deepEqual(logLines(world), [], `the signer wrote to its log although ${why}`);
}

// "<id> <hash>", computed here from the card file and its one frozen file.
function hashLine(repo: string, id: string): string {
  const card = readFileSync(join(repo, "laws", `${id}.md`));
  const frozen = [{ path: `frozen/${id}.txt`, bytes: readFileSync(join(repo, "frozen", `${id}.txt`)) }];
  return `${id} ${hashCard(card, frozen)}`;
}

function assertSignatureIsGood(world: World, out: string): void {
  const options = ["-Y", "verify", "-f", world.signers, "-I", "tester", "-n", "laws", "-s", join(out, "manifest.sig")];
  const verified = spawnSync("ssh-keygen", options, { input: readFileSync(join(out, "manifest")), encoding: "utf8" });
  assert.equal(verified.status, 0, `the signature over the manifest is not good: ${verified.stderr}`);
}

function logLines(world: World): string[] {
  if (!existsSync(world.log)) return [];
  return readFileSync(world.log, "utf8").split("\n").filter((line) => line !== "");
}

function fingerprint(world: World): string {
  return run("ssh-keygen", ["-l", "-f", world.key]).split(" ")[1] ?? "no fingerprint";
}

// Every path under a folder with what it holds, to see whether anything changed.
function snapshot(folder: string): string {
  const seen: string[] = [];
  const walk = (path: string): void => {
    const info = lstatSync(path);
    if (info.isDirectory()) {
      seen.push(`${path} folder`);
      for (const name of readdirSync(path).sort()) walk(join(path, name));
    } else if (info.isSymbolicLink()) {
      seen.push(`${path} link`);
    } else {
      seen.push(`${path} ${createHash("sha256").update(readFileSync(path)).digest("hex")}`);
    }
  };
  walk(folder);
  return seen.join("\n");
}

function run(program: string, options: string[]): string {
  const result = spawnSync(program, options, { encoding: "utf8" });
  assert.equal(result.status, 0, `${program} ${options.join(" ")} failed: ${result.stderr}`);
  return result.stdout;
}

// ---- The check: the property against the real signer. ----

if (import.meta.main) {
  const real: Signer = [process.execPath, REAL_SIGNER];

  test("T-04 allowed: three cards signed, one log entry that lists them", () => allowedThreeCards(real));
  test("T-04 blocked: a frozen file that is a link to outside the repository", () => blockedFrozenLinkToOutside(real));
  test("T-04 a card file that is a link to outside the repository is refused", () => refusesCardLinkToOutside(real));
  test("T-04 a file over 1 MB is refused", () => refusesFilesOverOneMegabyte(real));

  test("T-04 a link that stays inside the repository is read", () => {
    withWorld((world) => {
      const before = hashLine(world.repo, "A-02");
      writeFileSync(join(world.repo, "frozen", "kept-elsewhere.txt"), readFileSync(join(world.repo, "frozen", "A-02.txt")));
      rmSync(join(world.repo, "frozen", "A-02.txt"));
      symlinkSync("kept-elsewhere.txt", join(world.repo, "frozen", "A-02.txt"));
      const answer = sign(real, world, ["A-02"]);
      assert.equal(answer.exitCode, 0, answer.printed);
      assert.equal(readFileSync(join(answer.out, "manifest"), "utf8"), `${before}\n`);
    });
  });

  test("T-04 a folder, a missing file and a broken card are refused", () => {
    withWorld((world) => {
      rmSync(join(world.repo, "frozen", "A-01.txt"));
      mkdirSync(join(world.repo, "frozen", "A-01.txt"));
      assertNothingSigned(world, sign(real, world, IDS), "a frozen path is a folder");
    });
    withWorld((world) => {
      rmSync(join(world.repo, "frozen", "A-03.txt"));
      assertNothingSigned(world, sign(real, world, IDS), "a frozen file is missing");
    });
    withWorld((world) => {
      writeFileSync(join(world.repo, "laws", "A-02.md"), "---\nid: A-02\ngrade: chosen\nsurprise: yes\n---\n# A-02 Broken\n");
      assertNothingSigned(world, sign(real, world, IDS), "a card has an unknown key");
    });
    withWorld((world) => {
      assertNothingSigned(world, sign(real, world, ["A-01", "../repo/laws/A-02"]), "an id is a path");
      assertNothingSigned(world, sign(real, world, ["A-01", "A-09"]), "there is no such card");
      assertNothingSigned(world, sign(real, world, []), "no card was named");
    });
  });

  test("T-04 the signer never writes inside the repository", () => {
    withWorld((world) => {
      const before = snapshot(world.repo);
      mkdirSync(join(world.repo, "out"));
      const withOutInside = sign(real, world, IDS, { out: join(world.repo, "out") });
      assert.notEqual(withOutInside.exitCode, 0, "--out inside the repository must be refused");
      rmSync(join(world.repo, "out"), { recursive: true });

      const withLogInside = sign(real, world, IDS, { log: join(world.repo, "laws", "signer.log") });
      assert.notEqual(withLogInside.exitCode, 0, "--log inside the repository must be refused");
      assert.ok(!existsSync(join(withLogInside.out, "manifest.sig")));

      // A link outside the repository that leads into it is refused as well.
      symlinkSync(join(world.repo, "laws"), join(world.folder, "looks-outside"));
      const throughLink = sign(real, world, IDS, { log: join(world.folder, "looks-outside", "signer.log") });
      assert.notEqual(throughLink.exitCode, 0, "--log that leads into the repository must be refused");

      assert.equal(snapshot(world.repo), before, "the signer changed something inside the repository");
      assert.deepEqual(logLines(world), []);
    });
  });
}
