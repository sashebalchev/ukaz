// The check of law T-09 (laws/T-09.md): on the laptop, one touch of the named finger signs one list,
// after the list was sent.
// This file and its bite are frozen with the card, so everything the check means is written here.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fprintdFinger, readSettings, startLaptopSigner } from "../../signer/laptop.ts";
import { hashCard } from "../../src/hash.ts";
import { verifyRepo } from "../../src/verify.ts";

// The settings of the service: where it listens, its key, its log, and whose finger it asks for.
export type Settings = { socket: string; key: string; log: string; user: string; finger: string };

// A stand-in for the fingerprint reader and for the person in front of it.
export type Reader = {
  // What the service calls: is this finger of this user on the reader within so many milliseconds?
  check: (finger: string, user: string, milliseconds: number) => Promise<{ match: boolean; detail: string }>;
  // Every time the reader was asked. hadList: the list had reached the asking program by then.
  asked: { finger: string; user: string; hadList: boolean }[];
  listsSeen: number; // how many lists have reached asking programs; the test's client counts them
  hung: boolean; // a reader that never answers
  touch: (finger: string) => void; // the person puts this finger on the reader. Nobody waiting: it is lost
  nextAsk: () => Promise<void>; // resolves when the reader waits for a finger the next time
};

// What is under test: a way to start the laptop signer with these settings, this reader, and this time
// limit for the finger. In the law the limit is 30 seconds; the tests use a shorter one.
export type Start = (settings: Settings, reader: Reader, milliseconds: number) => Promise<{ stop: () => Promise<void> }>;

type World = { folder: string; repo: string; signers: string; settings: Settings };
type Line = { id: string; hash: string | null; title: string };
// What one request came to: the list that the service answered with, then a signature or a refusal.
type Outcome = { list: Line[] | null; finger: string | null; manifest: string | null; signature: string | null; refused: string | null };

const CLI = join(import.meta.dirname, "../../src/cli.ts");
const NAMED = "right-index-finger";
const OTHER = "left-index-finger"; // enrolled as well: the finger that sudo would also take
const LIMIT = 600; // milliseconds that the service waits for the finger in these tests
const SOON = 1500; // milliseconds within which an answer that is due "at once" must be there

// ---- The property. The bite runs the same functions against broken services. ----

// Allowed by the law: two cards are sent, the named finger touches the reader, and the answer is one
// manifest with one signature that laws verify accepts. The log gains one line that lists those two cards.
export async function allowedTwoCardsOneTouch(start: Start): Promise<void> {
  await withService(start, ["A-01", "A-02"], async (world, reader) => {
    const pending = ask(world, reader, requestFor(world, ["A-02", "A-01"]));
    await asked(reader);
    assert.deepEqual(logLines(world), [], "the log said something before the finger was on the reader");
    reader.touch(NAMED);
    const outcome = await pending;

    // The service computed the hashes itself, from the bytes, and answered with id, hash and title.
    const expected = ["A-01", "A-02"].map((id) => ({ id, hash: hashOf(world, id), title: `The law of ${id}` }));
    assert.deepEqual(outcome.list, expected, "the list is not the two cards with their hashes and titles");
    assert.equal(outcome.finger, NAMED, "the answer does not say which finger is asked for");

    // It asked the reader once, for the named finger of the named user, and only after the list was sent.
    assert.deepEqual(reader.asked, [{ finger: NAMED, user: "alex", hadList: true }]);

    // One manifest: the time, then exactly that list. One signature, which laws verify accepts.
    assert.equal(outcome.refused, null, `the laptop signer refused two good cards: ${outcome.refused}`);
    const manifest = (outcome.manifest ?? "").split("\n");
    assert.match(manifest[0] ?? "", /^signed: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, "the manifest must start with its time");
    assert.deepEqual(manifest.slice(1), [...expected.map((line) => `${line.id} ${line.hash}`), ""]);
    assert.equal(verifies(world), false, "nothing is stored yet, and the repository verified");
    store(world, outcome);
    assert.equal(verifies(world), true, "laws verify does not accept the manifest and the signature that came back");

    // The log gained one line, with the time, and it lists those two cards.
    const log = logLines(world);
    assert.equal(log.length, 1, "the log must gain exactly one line");
    assert.match(log[0] ?? "", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "the log line has no time");
    assert.match(log[0] ?? "", / signed /);
    for (const line of expected) assert.ok(log[0]?.includes(`${line.id}=${line.hash}`), `the log line does not list ${line.id} with its hash`);
  });
}

// Blocked by the law: a request arrives and the reader reports a match for a different finger than the
// named one. Nothing is signed.
export async function blockedAnotherFinger(start: Start): Promise<void> {
  await withService(start, ["A-01", "A-02"], async (world, reader) => {
    const pending = ask(world, reader, requestFor(world, ["A-01", "A-02"]));
    await asked(reader);
    reader.touch(OTHER);
    const outcome = await pending;
    assertNothingSigned(world, outcome, "the laptop signer signed although the named finger did not match after the list was sent");
    assert.equal(logLines(world).length, 1, "the refusal must be written to the log");
    assert.match(logLines(world)[0] ?? "", /refused.*A-01=.*A-02=/, "the log line must say what was refused");
  });
}

// Blocked by the law: nobody touches the reader for the time limit. Nothing is signed, also not by a
// touch that comes later, and also not if the reader itself never answers.
export async function blockedNoTouch(start: Start): Promise<void> {
  for (const hung of [false, true]) {
    await withService(start, ["A-01"], async (world, reader) => {
      reader.hung = hung;
      const pending = ask(world, reader, requestFor(world, ["A-01"]));
      await asked(reader);
      const outcome = await within(LIMIT + SOON, pending);
      if (outcome === null) {
        reader.touch(NAMED);
        const late = await within(SOON, pending);
        const then = late?.signature ? ", and a touch after the limit was signed" : "";
        throw new Error(`nobody touched the reader, and after the time limit the laptop signer was still waiting${then}`);
      }
      assertNothingSigned(world, outcome, "the laptop signer signed although nobody touched the reader");
      reader.touch(NAMED); // too late: nobody is waiting for it
      assert.match(logLines(world).join("\n"), /refused/, "the refusal must be written to the log");
    });
  }
}

// Blocked by the law: a second request while the first one waits for the finger. It is refused at once.
export async function blockedSecondRequest(start: Start): Promise<void> {
  await withService(start, ["A-01", "A-02"], async (world, reader) => {
    const first = ask(world, reader, requestFor(world, ["A-01"]));
    await asked(reader);
    const second = await within(LIMIT / 2, ask(world, reader, requestFor(world, ["A-02"])));
    if (second === null) throw new Error("a second request was not refused at once while the first one waited for the finger");
    assertNothingSigned(world, second, "a second request was signed while the first one waited for the finger");
    assert.equal(reader.asked.length, 1, "the reader was asked for the second request");

    reader.touch(NAMED);
    const outcome = await first;
    assert.equal(outcome.manifest?.split("\n")[1], `A-01 ${hashOf(world, "A-01")}`, "the touch must sign the first list");
    assert.equal(outcome.manifest?.split("\n").length, 3, "the touch signed more than the first list");
    const log = logLines(world);
    assert.equal(log.filter((line) => line.includes(" signed ")).length, 1, "one touch, one signing in the log");
    assert.ok(log.some((line) => line.includes("refused")), "the refusal of the second request must be in the log");
  });
}

// One match signs one list: no match is kept for a later request, and a touch from before a request
// counts for nothing.
export async function oneMatchSignsOneList(start: Start): Promise<void> {
  await withService(start, ["A-01", "A-02"], async (world, reader) => {
    reader.touch(NAMED); // meant for something else, before any request
    const before = ask(world, reader, requestFor(world, ["A-01"]));
    await asked(reader);
    assertNothingSigned(world, await before, "a touch from before the request signed a list");

    const touched = ask(world, reader, requestFor(world, ["A-01"]));
    await asked(reader);
    reader.touch(NAMED);
    assert.ok((await touched).signature !== null, "the named finger touched the reader and nothing was signed");

    const after = ask(world, reader, requestFor(world, ["A-02"]));
    await asked(reader);
    const outcome = await after;
    assert.equal(outcome.signature, null, "one match signed a second list");
    assert.equal(reader.asked.length, 3, "the reader must be asked again for every request");
    assert.equal(logLines(world).filter((line) => line.includes(" signed ")).length, 1, "the log must show one signing");
  });
}

// A reader with two enrolled fingers. Asked for one finger, it reports a match only for that one.
// Asked for "any", as sudo asks, it takes every enrolled finger.
export function newReader(): Reader {
  const enrolled = [NAMED, OTHER];
  let waiting: ((touched: string) => void) | null = null;
  let wake: (() => void)[] = [];
  const reader: Reader = {
    asked: [],
    listsSeen: 0,
    hung: false,
    check: async (finger, user, milliseconds) => {
      const turn = reader.asked.length;
      const entry = { finger, user, hadList: false };
      reader.asked.push(entry);
      // A service that keeps the law has sent the list already. It needs a moment to arrive.
      for (let tries = 0; tries < 100 && reader.listsSeen <= turn; tries++) await sleep(5);
      entry.hadList = reader.listsSeen > turn;
      return new Promise((done) => {
        const timer = setTimeout(() => {
          waiting = null;
          if (!reader.hung) done({ match: false, detail: "no touch in time" });
        }, milliseconds);
        timer.unref();
        waiting = (touched) => {
          clearTimeout(timer);
          waiting = null;
          const match = enrolled.includes(touched) && (finger === "any" || finger === touched);
          if (!reader.hung) done({ match, detail: match ? "verify-match" : "verify-no-match" });
        };
        for (const resolve of wake) resolve();
        wake = [];
      });
    },
    touch: (finger) => waiting?.(finger),
    nextAsk: () => new Promise((resolve) => wake.push(resolve)),
  };
  return reader;
}

// Waits until the service asks the reader. A broken service may never ask: then this gives up, and the
// test goes on to see what such a service answers.
function asked(reader: Reader): Promise<void | null> {
  return within(SOON, reader.nextAsk());
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((wake) => setTimeout(() => wake(), milliseconds));
}

// The promise's value, or null if it is not there within the time.
function within<Value>(milliseconds: number, promise: Promise<Value>): Promise<Value | null> {
  return Promise.race([promise, sleep(milliseconds).then(() => null)]);
}

// A temporary folder: a repository with these cards, each with one frozen file, and the service's
// socket, key and log. The key does not exist yet: the service makes it when it starts.
function newWorld(ids: string[]): World {
  const folder = mkdtempSync(join(tmpdir(), "laws-t09-"));
  const repo = join(folder, "repo");
  mkdirSync(join(repo, "laws", "approvals"), { recursive: true });
  mkdirSync(join(repo, "frozen"));
  for (const id of ids) {
    const bite = "bite: echo the blocked case was caught; exit 1\nbite-says: the blocked case was caught\n";
    const frontMatter = `---\nid: ${id}\ngrade: chosen\ncheck: true\n${bite}frozen: [frozen/${id}.txt]\n---\n`;
    writeFileSync(join(repo, "laws", `${id}.md`), `${frontMatter}# ${id} The law of ${id}\n`);
    writeFileSync(join(repo, "frozen", `${id}.txt`), `what ${id} depends on\n`);
  }
  const settings = { socket: join(folder, "socket"), key: join(folder, "key"), log: join(folder, "signer.log"), user: "alex", finger: NAMED };
  return { folder, repo, signers: join(folder, "allowed_signers"), settings };
}

// Starts the service on a new world, runs the body, and stops and removes everything.
async function withService(start: Start, ids: string[], body: (world: World, reader: Reader) => Promise<void>): Promise<void> {
  const world = newWorld(ids);
  const reader = newReader();
  const service = await start(world.settings, reader, LIMIT);
  try {
    // The signers file names the key that the service made.
    writeFileSync(world.signers, `owner ${readFileSync(`${world.settings.key}.pub`, "utf8")}`);
    await body(world, reader);
  } finally {
    await service.stop();
    rmSync(world.folder, { recursive: true, force: true });
  }
}

// A request: the bytes of each card and of its frozen file, in base64. No path of this machine is in it.
function requestFor(world: World, ids: string[], retire: string[] = []): string {
  const base64 = (path: string): string => readFileSync(join(world.repo, path)).toString("base64");
  const card = (id: string, retired: boolean): object => ({
    id,
    retire: retired,
    card: base64(`laws/${id}.md`),
    files: retired ? [] : [{ path: `frozen/${id}.txt`, bytes: base64(`frozen/${id}.txt`) }],
  });
  return JSON.stringify({ cards: [...ids.map((id) => card(id, false)), ...retire.map((id) => card(id, true))] });
}

// Sends one request, as one line, and reads the answers: first the list, then a signature or a refusal.
function ask(world: World, reader: Reader, request: string): Promise<Outcome> {
  return new Promise((done) => {
    const outcome: Outcome = { list: null, finger: null, manifest: null, signature: null, refused: null };
    const socket = createConnection(world.settings.socket);
    let text = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${request}\n`));
    socket.on("data", (chunk) => {
      text += chunk;
      for (let at = text.indexOf("\n"); at !== -1; at = text.indexOf("\n")) {
        const message = JSON.parse(text.slice(0, at)) as Record<string, unknown>;
        text = text.slice(at + 1);
        if (Array.isArray(message["list"])) {
          outcome.list = message["list"] as Line[];
          outcome.finger = String(message["finger"]);
          reader.listsSeen += 1;
        }
        if (typeof message["manifest"] === "string") outcome.manifest = message["manifest"];
        if (typeof message["signature"] === "string") outcome.signature = message["signature"];
        if (typeof message["refused"] === "string") outcome.refused = message["refused"];
      }
    });
    socket.on("error", (error) => {
      outcome.refused ??= `no connection: ${error.message}`;
    });
    socket.on("close", () => {
      outcome.refused ??= outcome.signature === null ? "the service hung up" : null;
      done(outcome);
    });
  });
}

// No signature, no manifest, a refusal, and no log line that says "signed".
function assertNothingSigned(world: World, outcome: Outcome, why: string): void {
  assert.equal(outcome.signature, null, why);
  assert.equal(outcome.manifest, null, why);
  assert.ok(outcome.refused !== null, `${why}: the request was not refused`);
  assert.ok(!logLines(world).some((line) => line.includes(" signed ")), `${why}: the log shows a signing`);
}

// The hash of a card, computed here from the card file and its one frozen file.
function hashOf(world: World, id: string): string {
  const card = readFileSync(join(world.repo, "laws", `${id}.md`));
  return hashCard(card, [{ path: `frozen/${id}.txt`, bytes: readFileSync(join(world.repo, "frozen", `${id}.txt`)) }]);
}

// What the laws command does with a good answer: the manifest and its signature go into laws/approvals/.
function store(world: World, outcome: Outcome): void {
  writeFileSync(join(world.repo, "laws", "approvals", "batch.manifest"), outcome.manifest ?? "");
  writeFileSync(join(world.repo, "laws", "approvals", "batch.manifest.sig"), outcome.signature ?? "");
}

function verifies(world: World): boolean {
  return verifyRepo(world.repo, world.signers).ok;
}

function logLines(world: World): string[] {
  if (!existsSync(world.settings.log)) return [];
  return readFileSync(world.settings.log, "utf8").split("\n").filter((line) => line !== "");
}

// ---- The check: the property against the real service, the real finger check, and the laws command. ----

// Runs the laws command while this process keeps serving. Returns its exit code and what it printed.
function laws(world: World, words: string[], environment: Record<string, string> = {}): Promise<[number | null, string]> {
  return new Promise((done) => {
    const env = { ...process.env, LAWS_SIGNER: undefined, LAWS_SIGNERS: undefined, ...environment };
    const options = [CLI, ...words, "--repo", world.repo, "--signers", world.signers];
    const command = spawn(process.execPath, options, { env, stdio: ["ignore", "pipe", "pipe"] });
    let printed = "";
    for (const stream of [command.stdout, command.stderr]) {
      stream?.setEncoding("utf8");
      stream?.on("data", (chunk) => (printed += chunk));
    }
    command.on("close", (code) => done([code, printed]));
  });
}

// A stand-in for the fprintd-verify program: a shell script.
function fakeProgram(folder: string, name: string, script: string): string {
  const file = join(folder, name);
  writeFileSync(file, `#!/bin/sh\n${script}\n`);
  chmodSync(file, 0o755);
  return file;
}

if (import.meta.main) {
  const real: Start = (settings, reader, milliseconds) => startLaptopSigner(settings, reader.check, () => {}, milliseconds);

  test("T-09 allowed: two cards, the named finger, one manifest and one signature that laws verify accepts", () => allowedTwoCardsOneTouch(real));
  test("T-09 blocked: the reader reports another finger than the named one", () => blockedAnotherFinger(real));
  test("T-09 blocked: nobody touches the reader within the time limit", () => blockedNoTouch(real));
  test("T-09 blocked: a second request while the first one waits for the finger", () => blockedSecondRequest(real));
  test("T-09 one match signs one list, and no match is kept", () => oneMatchSignsOneList(real));

  test("T-09 the finger must be one finger by name: any and unknown names are refused at start", async () => {
    const world = newWorld(["A-01"]);
    try {
      const words = (finger: string): string[] => ["--socket", world.settings.socket, "--key", world.settings.key, "--log", world.settings.log, "--user", "alex", "--finger", finger];
      assert.equal(readSettings(words(NAMED)).finger, NAMED);
      for (const finger of ["any", "thumb", "right-index", "", "Right-Index-Finger"]) {
        assert.throws(() => readSettings(words(finger)), /is not one finger/, finger);
        let started = false;
        try {
          await (await startLaptopSigner({ ...world.settings, finger }, newReader().check, () => {})).stop();
          started = true;
        } catch {
          // refused, as it must be
        }
        assert.ok(!started, `the service started with --finger ${finger}`);
      }
      assert.throws(() => readSettings(words(NAMED).slice(0, -2)), /--finger is missing/);
      assert.throws(() => readSettings([...words(NAMED), "--seconds", "3600"]), /unknown option/);
      assert.ok(!existsSync(world.settings.key), "a service that did not start made a key");
    } finally {
      rmSync(world.folder, { recursive: true, force: true });
    }
  });

  test("T-09 the key is made at the first start, for the owner only, and kept after that", async () => {
    const world = newWorld(["A-01"]);
    try {
      const printed: string[] = [];
      const first = await startLaptopSigner(world.settings, newReader().check, (line) => printed.push(line), LIMIT);
      assert.equal(statSync(world.settings.socket).mode & 0o777, 0o660, "the socket is for its owner and its group");
      await first.stop();
      assert.equal(statSync(world.settings.key).mode & 0o777, 0o600, "the key must be readable by its owner only");
      const publicKey = readFileSync(`${world.settings.key}.pub`, "utf8").split(" ").slice(0, 2).join(" ");
      assert.ok(printed.includes(`alex namespaces="laws" ${publicKey}`), "the service must print the line for the signers file");

      const key = readFileSync(world.settings.key, "utf8");
      const second = await startLaptopSigner(world.settings, newReader().check, () => {}, LIMIT);
      await second.stop();
      assert.equal(readFileSync(world.settings.key, "utf8"), key, "a second start must keep the key");
    } finally {
      rmSync(world.folder, { recursive: true, force: true });
    }
  });

  test("T-09 the hashes come from the bytes that were sent: the service opens no path of the client", async () => {
    await withService(real, ["A-01"], async (world, reader) => {
      // The files exist nowhere under these names: the request is made by hand, with other bytes.
      const frontMatter = "---\nid: B-07\ngrade: chosen\ncheck: true\nfrozen: [/etc/hostname-is-not-read.txt]\n---\n";
      const absolute = { id: "B-07", retire: false, card: Buffer.from(`${frontMatter}# B-07 Elsewhere\n`).toString("base64"), files: [] };
      const refused = await ask(world, reader, JSON.stringify({ cards: [absolute] }));
      assertNothingSigned(world, refused, "a card that names an absolute path was signed");

      const cardBytes = Buffer.from("---\nid: B-07\ngrade: chosen\ncheck: true\nfrozen: [not/on/this/disk.txt]\n---\n# B-07 Elsewhere\n");
      const fileBytes = Buffer.from("bytes that were only ever sent\n");
      const card = { id: "B-07", retire: false, card: cardBytes.toString("base64"), files: [{ path: "not/on/this/disk.txt", bytes: fileBytes.toString("base64") }] };
      const pending = ask(world, reader, JSON.stringify({ cards: [card] }));
      await asked(reader);
      reader.touch(NAMED);
      const outcome = await pending;
      const expected = hashCard(cardBytes, [{ path: "not/on/this/disk.txt", bytes: fileBytes }]);
      assert.deepEqual(outcome.list, [{ id: "B-07", hash: expected, title: "Elsewhere" }]);
      assert.equal(outcome.manifest?.split("\n")[1], `B-07 ${expected}`);
    });
  });

  test("T-09 a request that is not exact is refused before the reader is asked, and the log says so", async () => {
    await withService(real, ["A-01", "A-02"], async (world, reader) => {
      const good = JSON.parse(requestFor(world, ["A-01"])) as { cards: Record<string, unknown>[] };
      const card = good.cards[0] ?? {};
      const megabyte = Buffer.alloc(1024 * 1024 + 1, 97).toString("base64");
      const bad: unknown[] = [
        "not json",
        {},
        { cards: [] },
        { cards: [card], extra: true },
        { cards: [card, card] },
        { cards: [{ ...card, id: "../A-01" }] },
        { cards: [{ ...card, id: "A-02" }] },
        { cards: [{ ...card, files: [] }] },
        { cards: [{ ...card, files: [...(card["files"] as object[]), { path: "frozen/A-02.txt", bytes: "" }] }] },
        { cards: [{ ...card, files: [...(card["files"] as object[]), ...(card["files"] as object[])] }] },
        { cards: [{ ...card, files: [{ path: "frozen/A-01.txt", bytes: megabyte }] }] },
        { cards: [{ ...card, files: [{ path: "frozen/A-01.txt", bytes: "####" }] }] },
        { cards: [{ ...card, card: `${String(card["card"])}=` }] },
        { cards: [{ ...card, retire: "no" }] },
        { cards: [{ ...card, retire: true }] },
        { cards: [{ id: card["id"], card: card["card"], files: card["files"] }] },
        { cards: [{ ...card, path: "/etc/passwd" }] },
      ];
      for (const request of bad) {
        const text = typeof request === "string" ? request : JSON.stringify(request);
        const outcome = await ask(world, reader, text);
        assertNothingSigned(world, outcome, `a request that is not exact was signed: ${text.slice(0, 200)}`);
      }
      assert.deepEqual(reader.asked, [], "the reader was asked for a request that is not exact");
      assert.equal(logLines(world).length, bad.length, "every refusal must be written to the log");
      for (const line of logLines(world)) assert.match(line, / refused:bad-request /);
    });
  });

  test("T-09 a retirement is listed as one and signed as a retired line", async () => {
    await withService(real, ["A-01", "A-02"], async (world, reader) => {
      const pending = ask(world, reader, requestFor(world, ["A-01"], ["A-02"]));
      await asked(reader);
      reader.touch(NAMED);
      const outcome = await pending;
      assert.deepEqual(outcome.list?.[1], { id: "A-02", hash: null, title: "The law of A-02" });
      assert.deepEqual(outcome.manifest?.split("\n").slice(1), [`A-01 ${hashOf(world, "A-01")}`, "A-02 retired", ""]);
      assert.match(logLines(world)[0] ?? "", / signed A-01=[0-9a-f]{64} A-02=retired$/);
    });
  });

  test("T-09 a program that asks and then goes away gets nothing signed, also when the finger comes", async () => {
    await withService(real, ["A-01"], async (world, reader) => {
      const socket = createConnection(world.settings.socket);
      socket.on("connect", () => socket.write(`${requestFor(world, ["A-01"])}\n`));
      socket.on("error", () => {});
      socket.setEncoding("utf8");
      socket.on("data", () => {
        reader.listsSeen += 1;
        socket.destroy(); // it has the list, and hangs up
      });
      await asked(reader);
      await sleep(50);
      reader.touch(NAMED);
      await sleep(100);
      assert.equal(logLines(world).length, 1);
      assert.match(logLines(world)[0] ?? "", / refused:client-gone A-01=/);
    });
  });

  test("T-09 the real finger check: a match is exit 0 together with verify-match for the named finger, and nothing else", async () => {
    const folder = mkdtempSync(join(tmpdir(), "laws-t09-fprintd-"));
    try {
      const said = join(folder, "said");
      const cases: [string, string, boolean][] = [
        ["match", `echo "$@" > '${said}'; echo 'Verifying: ${NAMED}'; echo 'Verify result: verify-match (done)'`, true],
        ["retry-then-match", "echo 'Verify result: verify-retry-scan (not done)'; echo 'Verify result: verify-match (done)'", true],
        ["no-match", "echo 'Verify result: verify-no-match (done)'; exit 1", false],
        ["match-but-failed", "echo 'Verify result: verify-match (done)'; exit 1", false],
        ["quiet-success", "exit 0", false],
        ["no-match-but-zero", "echo 'Verify result: verify-no-match (done)'; exit 0", false],
        ["match-on-stderr", "echo 'Verify result: verify-match (done)' >&2; exit 0", false],
        ["any-finger", "echo 'Verifying: any'; echo 'Verify result: verify-match (done)'", false],
        ["other-finger", `echo 'Verifying: ${OTHER}'; echo 'Verify result: verify-match (done)'`, false],
        ["killed", "kill -9 $$", false],
      ];
      for (const [name, script, expected] of cases) {
        const result = await fprintdFinger(fakeProgram(folder, name, script))(NAMED, "alex", 5000);
        assert.equal(result.match, expected, `${name}: ${result.detail}`);
      }
      assert.equal(readFileSync(said, "utf8"), `-f ${NAMED} alex\n`, "the program must be asked for the named finger of the named user");
      assert.equal((await fprintdFinger(join(folder, "no-such-program"))(NAMED, "alex", 5000)).match, false);

      // No touch: at the time limit the program is killed, with what it started.
      const child = join(folder, "child.pid");
      const waits = fakeProgram(folder, "waits", `sleep 60 &\necho $! > '${child}'\necho 'Verify started!'\nwait`);
      const began = Date.now();
      const late = await fprintdFinger(waits)(NAMED, "alex", 300);
      assert.equal(late.match, false);
      assert.match(late.detail, /no touch in time/);
      assert.ok(Date.now() - began < 3000, "the time limit did not stop the program");
      await sleep(100);
      const pid = Number(readFileSync(child, "utf8"));
      assert.throws(() => process.kill(pid, 0), /ESRCH/, "what the program started was still running after the time limit");
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  test("T-09 laws sign --laptop prints the list, names the finger, and stores what verifies", async () => {
    await withService(real, ["A-01", "A-02"], async (world, reader) => {
      const touchWhenAsked = (finger: string): void => void reader.nextAsk().then(() => reader.touch(finger));

      // The wrong finger: laws sign fails and stores nothing.
      touchWhenAsked(OTHER);
      const [refusedCode, refused] = await laws(world, ["sign", "--laptop", world.settings.socket]);
      assert.equal(refusedCode, 1, refused);
      assert.match(refused, /the laptop signer refused: the reader did not see the right-index-finger/);
      assert.equal(verifies(world), false);

      // The named finger. The list is printed first, then the line that names the finger.
      touchWhenAsked(NAMED);
      const [exitCode, printed] = await laws(world, ["sign", "--laptop", world.settings.socket]);
      assert.equal(exitCode, 0, printed);
      const list = `  sign    A-01  ${hashOf(world, "A-01")}  The law of A-01\n  sign    A-02  ${hashOf(world, "A-02")}  The law of A-02\n`;
      const finger = "Put your right index finger on the fingerprint reader now.";
      assert.ok(printed.includes(list), printed);
      assert.ok(printed.indexOf(list) < printed.indexOf(finger), "the list must be printed before the person is asked for the finger");
      assert.equal(verifies(world), true, "what laws sign stored does not verify");
      assert.deepEqual((await laws(world, ["gate"]))[1], "open\n");

      // The same socket from LAWS_SIGNER, and a retirement.
      touchWhenAsked(NAMED);
      const [retiredCode, retired] = await laws(world, ["retire", "A-02"], { LAWS_SIGNER: `laptop:${world.settings.socket}` });
      assert.equal(retiredCode, 0, retired);
      assert.match(retired, /^ {2}retire {2}A-02 {2}The law of A-02$/m);
      rmSync(join(world.repo, "laws", "A-02.md"));
      assert.equal(verifies(world), true, "a card that was retired through the laptop signer could not be removed");
      assert.equal(logLines(world).filter((line) => line.includes(" signed ")).length, 2);

      // A signer command and the laptop signer together are refused, and so is a socket that is not there.
      const [bothCode] = await laws(world, ["sign", "A-01", "--laptop", world.settings.socket, "--signer", "true"]);
      assert.equal(bothCode, 1);
      const [goneCode, gone] = await laws(world, ["sign", "A-01", "--laptop", join(world.folder, "no-socket")]);
      assert.equal(goneCode, 1);
      assert.match(gone, /cannot be reached/);
    });
  });

  test("T-09 the real program refuses to start with --finger any", () => {
    const program = join(import.meta.dirname, "../../signer/laptop.ts");
    const folder = mkdtempSync(join(tmpdir(), "laws-t09-start-"));
    try {
      const words = ["--socket", join(folder, "socket"), "--key", join(folder, "key"), "--log", join(folder, "log"), "--user", "alex", "--finger", "any"];
      const result = spawnSync(process.execPath, [program, ...words], { encoding: "utf8", timeout: 20000 });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /"any" is refused on purpose/);
      assert.ok(!existsSync(join(folder, "key")));
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
}
