// The check of law T-04 (laws/T-04.md): the signer signs only what it computed and showed.
// This file and its bite are frozen with the card, so everything the check means is written here.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
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
import { runSigner } from "../../signer/signer.ts";

// What is under test: a signer. It gets the words of its command line and what the person at the
// terminal types when asked (null: there is no terminal). It gives back its exit code and what it printed.
export type Signer = (words: string[], typed: string | null) => { exitCode: number; printed: string };

type World = { folder: string; repo: string; key: string; signers: string; log: string };
type Answer = { exitCode: number; printed: string; out: string };
type Request = { approve?: string[]; retire?: string[]; typed?: string | null; out?: string; log?: string };

const REAL_SIGNER = join(import.meta.dirname, "../../signer/signer.ts");
const IDS = ["A-01", "A-02", "A-03"];
const ONE_MEGABYTE = 1024 * 1024;
let outCount = 0;

// ---- The property. The bite runs the same functions against broken signers. ----

// Allowed by the law: three cards are signed, and the log gains one entry that lists those three.
export function allowedThreeCards(signer: Signer): void {
  withWorld((world) => {
    const before = snapshot(world.repo);
    const answer = ask(signer, world, { approve: ["A-03", "A-01", "A-02"], typed: "sign" });
    assert.equal(answer.exitCode, 0, `the signer refused three good cards:\n${answer.printed}`);

    // It signed exactly the list of ids and hashes, under the time of signing, and the hashes are what the files give.
    const lines = IDS.map((id) => hashLine(world.repo, id));
    const manifest = readFileSync(join(answer.out, "manifest"), "utf8").split("\n");
    assert.match(manifest[0] ?? "", /^signed: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, "the manifest must start with its time");
    assert.deepEqual(manifest.slice(1), [...lines, ""], "the manifest is not the three cards with their hashes");
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
    assert.match(log[0] ?? "", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "the log entry has no time");

    assert.equal(snapshot(world.repo), before, "the signer changed something inside the repository");

    // The hashes come from the files: after an edit, the next signature covers another hash.
    appendFileSync(join(world.repo, "frozen", "A-02.txt"), "x");
    const again = ask(signer, world, { approve: ["A-02"], typed: "sign" });
    assert.equal(readFileSync(join(again.out, "manifest"), "utf8").split("\n")[1], hashLine(world.repo, "A-02"));
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
    const answer = ask(signer, world, { approve: IDS, typed: "sign" });
    assertNothingSigned(world, answer, "a frozen file is a link to a file outside the repository");
  });
}

// Blocked by the law: the signer is started by a program that has no terminal. It refuses and signs
// nothing, and the refusal is in the log.
export function blockedNoTerminal(signer: Signer): void {
  withWorld((world) => {
    const answer = ask(signer, world, { approve: IDS, typed: null });
    assertNothingSigned(world, answer, "there is no terminal to confirm at");
    const log = logLines(world);
    assert.equal(log.length, 1, "the refusal must be written to the log");
    assert.match(log[0] ?? "", /refused/);
    assert.match(log[0] ?? "", /A-01.*A-02.*A-03/, "the log entry must say what was refused");
  });
}

// The signer signs only on the exact word: "sign", or "retire" when the list only retires.
export function signsOnlyOnTheExactWord(signer: Signer): void {
  withWorld((world) => {
    for (const typed of ["", "yes", "y", "Sign", "sign ", " sign", "sign\r", "retire"]) {
      const answer = ask(signer, world, { approve: IDS, typed });
      assertNothingSigned(world, answer, `${JSON.stringify(typed)} was typed and not the word sign`);
    }
    const retireWithTheWrongWord = ask(signer, world, { retire: ["A-02"], typed: "sign" });
    assertNothingSigned(world, retireWithTheWrongWord, "sign was typed for a list that only retires");
    assert.equal(logLines(world).length, 9, "every refusal must be written to the log");
  });
}

// The card file itself is a link to a file outside the repository.
export function refusesCardLinkToOutside(signer: Signer): void {
  withWorld((world) => {
    const outside = join(world.folder, "outside-card.md");
    writeFileSync(outside, readFileSync(join(world.repo, "laws", "A-01.md")));
    rmSync(join(world.repo, "laws", "A-01.md"));
    symlinkSync(outside, join(world.repo, "laws", "A-01.md"));
    const answer = ask(signer, world, { approve: IDS, typed: "sign" });
    assertNothingSigned(world, answer, "a card file is a link to a file outside the repository");
  });
}

function newWorld(): World {
  const folder = mkdtempSync(join(tmpdir(), "laws-t04-"));
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
    const frontMatter = `---\nid: ${id}\ngrade: chosen\ncheck: true\nfrozen: [frozen/${id}.txt]\n---\n`;
    writeFileSync(join(world.repo, "laws", `${id}.md`), `${frontMatter}# ${id} The law of ${id}\n`);
    writeFileSync(join(world.repo, "frozen", `${id}.txt`), `what ${id} depends on\n`);
  }
  run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", world.key]);
  writeFileSync(world.signers, `tester ${readFileSync(`${world.key}.pub`, "utf8")}`);
  return world;
}

function withWorld(body: (world: World) => void): void {
  const world = newWorld();
  try {
    body(world);
  } finally {
    rmSync(world.folder, { recursive: true, force: true });
  }
}

// The words of a signer command line. Each call gets a new empty --out folder unless one is given.
function wordsFor(world: World, request: Request): { words: string[]; out: string } {
  outCount += 1;
  const out = request.out ?? join(world.folder, `out-${outCount}`);
  mkdirSync(out, { recursive: true });
  const retire = (request.retire ?? []).flatMap((id) => ["--retire", id]);
  const places = ["--repo", world.repo, "--key", world.key, "--log", request.log ?? world.log, "--out", out];
  return { words: [...places, ...(request.approve ?? []), ...retire], out };
}

function ask(signer: Signer, world: World, request: Request): Answer {
  const { words, out } = wordsFor(world, request);
  return { ...signer(words, request.typed ?? null), out };
}

// No signature, no manifest, and no log entry that says "signed".
function assertNothingSigned(world: World, answer: Answer, why: string): void {
  assert.notEqual(answer.exitCode, 0, `the signer did not refuse although ${why}:\n${answer.printed}`);
  assert.ok(!existsSync(join(answer.out, "manifest.sig")), `the signer left a signature although ${why}`);
  assert.ok(!existsSync(join(answer.out, "manifest")), `the signer left a manifest although ${why}`);
  assert.ok(!logLines(world).some((line) => line.includes(" signed ")), `the signer logged a signing although ${why}`);
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
  // The real signer, with a stand-in for the terminal: it answers the question with what was "typed".
  const real: Signer = (words, typed) => {
    const printed: string[] = [];
    const exitCode = runSigner(words, () => typed, (line) => printed.push(line));
    return { exitCode, printed: printed.join("\n") };
  };

  test("T-04 allowed: three cards signed, one log entry that lists them", () => allowedThreeCards(real));
  test("T-04 blocked: a frozen file that is a link to outside the repository", () => blockedFrozenLinkToOutside(real));
  test("T-04 blocked: no terminal, nothing is signed", () => blockedNoTerminal(real));
  test("T-04 the signer signs only on the exact word", () => signsOnlyOnTheExactWord(real));
  test("T-04 a card file that is a link to outside the repository is refused", () => refusesCardLinkToOutside(real));

  test("T-04 blocked: the real program, started with no terminal, refuses and signs nothing", async () => {
    const world = newWorld();
    try {
      // "detached" starts the program in a session of its own, which has no terminal.
      const { words, out } = wordsFor(world, { approve: IDS });
      const program = spawn(process.execPath, [REAL_SIGNER, ...words], { detached: true, stdio: "ignore" });
      const exitCode = await new Promise<number | null>((done) => program.on("exit", (code) => done(code)));
      assertNothingSigned(world, { exitCode: exitCode ?? -1, printed: "", out }, "the program has no terminal");
      assert.match(logLines(world)[0] ?? "", /refused:no-terminal/);
    } finally {
      rmSync(world.folder, { recursive: true, force: true });
    }
  });

  test("T-04 the question is asked after the whole list is shown, and before anything is signed", () => {
    withWorld((world) => {
      const { words, out } = wordsFor(world, { approve: IDS });
      const printed: string[] = [];
      let shownWhenAsked = "";
      let askedFor = "";
      const exitCode = runSigner(
        words,
        (word) => {
          askedFor = word;
          shownWhenAsked = printed.join("\n");
          assert.ok(!existsSync(join(out, "manifest.sig")), "a signature existed before the question");
          assert.deepEqual(logLines(world), [], "the log said something before the question");
          return word;
        },
        (line) => printed.push(line),
      );
      assert.equal(exitCode, 0, printed.join("\n"));
      assert.equal(askedFor, "sign");
      for (const id of IDS) {
        const [, hash] = hashLine(world.repo, id).split(" ");
        assert.match(shownWhenAsked, new RegExp(`sign +${id} +${hash} +The law of ${id}`));
      }
    });
  });

  test("T-04 a retirement is shown as one, needs the word retire, and is signed as a retired line", () => {
    withWorld((world) => {
      const answer = ask(real, world, { retire: ["A-02"], typed: "retire" });
      assert.equal(answer.exitCode, 0, answer.printed);
      assert.match(answer.printed, /^ *retire +A-02 +The law of A-02$/m);
      assert.equal(readFileSync(join(answer.out, "manifest"), "utf8").split("\n")[1], "A-02 retired");
      assertSignatureIsGood(world, answer.out);
      assert.match(logLines(world)[0] ?? "", / signed A-02=retired$/);

      // A list that also approves a card is confirmed with the word sign.
      const mixed = ask(real, world, { approve: ["A-01"], retire: ["A-03"], typed: "sign" });
      assert.equal(mixed.exitCode, 0, mixed.printed);
      assert.deepEqual(readFileSync(join(mixed.out, "manifest"), "utf8").split("\n").slice(1), [
        hashLine(world.repo, "A-01"),
        "A-03 retired",
        "",
      ]);

      // A card that is gone cannot be retired: there is no title to show. A card cannot be named twice.
      rmSync(join(world.repo, "laws", "A-03.md"));
      const gone = ask(real, world, { retire: ["A-03"], typed: "retire" });
      const twice = ask(real, world, { approve: ["A-01"], retire: ["A-01"], typed: "sign" });
      for (const refused of [gone, twice]) {
        assert.notEqual(refused.exitCode, 0, refused.printed);
        assert.ok(!existsSync(join(refused.out, "manifest.sig")));
      }
      assert.equal(logLines(world).length, 2, "only the two signings are in the log");
    });
  });

  test("T-04 the figure and its rendered text are hashed, as the laws command hashes them", () => {
    withWorld((world) => {
      const frontMatter = "---\nid: A-01\ngrade: chosen\nfrozen: [frozen/A-01.txt]\nfigure: figures/A-01.spec.json\n---\n";
      writeFileSync(join(world.repo, "laws", "A-01.md"), `${frontMatter}# A-01 The law of A-01\n`);
      assertNothingSigned(world, ask(real, world, { approve: ["A-01"], typed: "sign" }), "the figure file is missing");

      mkdirSync(join(world.repo, "figures"));
      writeFileSync(join(world.repo, "figures", "A-01.spec.json"), "{}\n");
      writeFileSync(join(world.repo, "figures", "A-01.txt"), "a picture\n");
      const files = ["frozen/A-01.txt", "figures/A-01.spec.json", "figures/A-01.txt"];
      const expected = hashCard(
        readFileSync(join(world.repo, "laws", "A-01.md")),
        files.map((path) => ({ path, bytes: readFileSync(join(world.repo, path)) })),
      );
      const answer = ask(real, world, { approve: ["A-01"], typed: "sign" });
      assert.equal(readFileSync(join(answer.out, "manifest"), "utf8").split("\n")[1], `A-01 ${expected}`);
    });
  });

  test("T-04 a file over 1 MB is refused", () => {
    withWorld((world) => {
      writeFileSync(join(world.repo, "frozen", "A-03.txt"), Buffer.alloc(ONE_MEGABYTE, 97));
      assert.equal(ask(real, world, { approve: IDS, typed: "sign" }).exitCode, 0, "a frozen file of exactly 1 MB must be accepted");
      appendFileSync(join(world.repo, "frozen", "A-03.txt"), "a");
      const answer = ask(real, world, { approve: IDS, typed: "sign" });
      assert.notEqual(answer.exitCode, 0, "a frozen file larger than 1 MB must be refused");
      assert.ok(!existsSync(join(answer.out, "manifest.sig")));
      assert.equal(logLines(world).length, 1, "only the first signing is in the log");
    });
  });

  test("T-04 a link that stays inside the repository is read", () => {
    withWorld((world) => {
      const before = hashLine(world.repo, "A-02");
      writeFileSync(join(world.repo, "frozen", "kept-elsewhere.txt"), readFileSync(join(world.repo, "frozen", "A-02.txt")));
      rmSync(join(world.repo, "frozen", "A-02.txt"));
      symlinkSync("kept-elsewhere.txt", join(world.repo, "frozen", "A-02.txt"));
      const answer = ask(real, world, { approve: ["A-02"], typed: "sign" });
      assert.equal(answer.exitCode, 0, answer.printed);
      assert.equal(readFileSync(join(answer.out, "manifest"), "utf8").split("\n")[1], before);
    });
  });

  test("T-04 a folder, a missing file and a broken card are refused", () => {
    withWorld((world) => {
      rmSync(join(world.repo, "frozen", "A-01.txt"));
      mkdirSync(join(world.repo, "frozen", "A-01.txt"));
      assertNothingSigned(world, ask(real, world, { approve: IDS, typed: "sign" }), "a frozen path is a folder");
    });
    withWorld((world) => {
      rmSync(join(world.repo, "frozen", "A-03.txt"));
      assertNothingSigned(world, ask(real, world, { approve: IDS, typed: "sign" }), "a frozen file is missing");
    });
    withWorld((world) => {
      writeFileSync(join(world.repo, "laws", "A-02.md"), "---\nid: A-02\ngrade: chosen\nsurprise: yes\n---\n# A-02 Broken\n");
      assertNothingSigned(world, ask(real, world, { approve: IDS, typed: "sign" }), "a card has an unknown key");
    });
    withWorld((world) => {
      assertNothingSigned(world, ask(real, world, { approve: ["A-01", "../repo/laws/A-02"], typed: "sign" }), "an id is a path");
      assertNothingSigned(world, ask(real, world, { approve: ["A-01", "A-09"], typed: "sign" }), "there is no such card");
      assertNothingSigned(world, ask(real, world, { typed: "sign" }), "no card was named");
      assert.deepEqual(logLines(world), [], "a batch that is refused before the question is not logged");
    });
  });

  test("T-04 the signer never writes inside the repository", () => {
    withWorld((world) => {
      const before = snapshot(world.repo);
      mkdirSync(join(world.repo, "out"));
      const withOutInside = ask(real, world, { approve: IDS, typed: "sign", out: join(world.repo, "out") });
      assert.notEqual(withOutInside.exitCode, 0, "--out inside the repository must be refused");
      rmSync(join(world.repo, "out"), { recursive: true });

      const withLogInside = ask(real, world, { approve: IDS, typed: "sign", log: join(world.repo, "laws", "signer.log") });
      assert.notEqual(withLogInside.exitCode, 0, "--log inside the repository must be refused");
      assert.ok(!existsSync(join(withLogInside.out, "manifest.sig")));

      // A link outside the repository that leads into it is refused as well.
      symlinkSync(join(world.repo, "laws"), join(world.folder, "looks-outside"));
      const throughLink = ask(real, world, { approve: IDS, typed: "sign", log: join(world.folder, "looks-outside", "signer.log") });
      assert.notEqual(throughLink.exitCode, 0, "--log that leads into the repository must be refused");

      assert.equal(snapshot(world.repo), before, "the signer changed something inside the repository");
      assert.deepEqual(logLines(world), []);
    });
  });
}
