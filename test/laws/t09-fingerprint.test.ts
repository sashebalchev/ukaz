// The check of law T-09 (laws/T-09.md): on the laptop, one touch of the named finger approves one list
// that waits on the server.
// This file and its bite are frozen with the card, so everything the check means is written here.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { startServer } from "../../server/server.ts";
import { fprintdFinger, readSettings, startLaptopSigner } from "../../signer/laptop.ts";
import { hashCard } from "../../src/hash.ts";
import { verifyRepo } from "../../src/verify.ts";

// The settings of the helper: where it listens, the signing server it belongs to, its key, its log,
// and whose finger it asks for.
export type Settings = { socket: string; server: string; key: string; log: string; user: string; finger: string };

// A stand-in for the fingerprint reader and for the person in front of it.
export type Reader = {
  // What the helper calls: is this finger of this user on the reader within so many milliseconds?
  check: (finger: string, user: string, milliseconds: number) => Promise<{ match: boolean; detail: string }>;
  // Every time the reader was asked. hadList: the list had reached the calling program by then.
  asked: { finger: string; user: string; hadList: boolean }[];
  listsSeen: number; // how many lists have reached calling programs; the test's caller counts them
  hung: boolean; // a reader that never answers
  eager: string | null; // the person holds this finger on the reader: it is there the moment the reader asks
  touch: (finger: string) => void; // the person puts this finger on the reader. Nobody waiting: it is lost
  nextAsk: () => Promise<void>; // resolves when the reader waits for a finger the next time
};

// What is under test: a way to start the helper with these settings, this reader, and this time limit
// for the finger. In the law the limit is 30 seconds; the tests use a shorter one.
export type Start = (settings: Settings, reader: Reader, milliseconds: number) => Promise<{ stop: () => Promise<void> }>;

// A temporary folder: a repository with cards, the real signing server that the helper belongs to, a
// second server that some local program runs, and the helper with its reader.
export type World = { folder: string; repo: string; signers: string; server: string; other: string; settings: Settings; reader: Reader };
type Line = { id: string; hash: string | null; title: string };
// What one call came to: the list that the helper answered with, then "approved" or a refusal.
type Outcome = { list: Line[] | null; finger: string | null; approved: boolean; refused: string | null };

const CLI = join(import.meta.dirname, "../../src/cli.ts");
const NAMED = "right-index-finger";
const OTHER = "left-index-finger"; // enrolled as well: the finger that sudo would also take
const LIMIT = 600; // milliseconds that the helper waits for the finger in these tests
const SOON = 1500; // milliseconds within which an answer that is due "at once" must be there
const NOWHERE = "0123456789abcdef0123456789abcdef"; // an id under which nothing waits

// ---- The property. The bite runs the same functions against broken helpers. ----

// Allowed by the law: two cards wait on the server, the named finger touches the reader, and the server
// then holds one manifest with one signature that laws verify accepts. The helper's log gains one line
// that lists those two cards.
export async function allowedTwoCardsOneTouch(start: Start): Promise<void> {
  await withHelper(start, ["A-01", "A-02"], async (world) => {
    const { reader } = world;
    const id = await post(world.server, requestFor(world, ["A-02", "A-01"]));
    const pending = call(world, { approve: id });
    await asked(reader);
    assert.deepEqual(logLines(world), [], "the log said something before the finger was on the reader");
    assert.deepEqual(await held(world, id), { state: "waiting" }, "the server held a signature before the finger was on the reader");
    reader.touch(NAMED);
    const outcome = await pending;

    // The helper fetched the cards from the server, computed the hashes itself, and answered with id,
    // hash and title.
    const expected = ["A-01", "A-02"].map((card) => ({ id: card, hash: hashOf(world, card), title: `The law of ${card}` }));
    assert.deepEqual(outcome.list, expected, "the list is not the two cards with their hashes and titles");
    assert.equal(outcome.finger, NAMED, "the answer does not say which finger is asked for");

    // It asked the reader once, for the named finger of the named user, and only after the list was sent.
    assert.deepEqual(reader.asked, [{ finger: NAMED, user: "alex", hadList: true }]);
    assert.equal(outcome.refused, null, `the helper refused two cards that wait on the server: ${outcome.refused}`);
    assert.equal(outcome.approved, true);

    // The server holds one manifest: the time, then exactly that list. And one signature, which laws
    // verify accepts.
    const result = await held(world, id);
    assert.equal(result["state"], "signed", "the server holds no signature after the named finger touched the reader");
    assert.equal(result["by"], "laptop");
    const manifest = String(result["manifest"]).split("\n");
    assert.match(manifest[0] ?? "", /^signed: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, "the manifest must start with its time");
    assert.deepEqual(manifest.slice(1), [...expected.map((line) => `${line.id} ${line.hash}`), ""]);
    assert.equal(verifies(world), false, "nothing is stored yet, and the repository verified");
    store(world, result);
    assert.equal(verifies(world), true, "laws verify does not accept the manifest and the signature that the server holds");

    // The helper's log gained one line, with the time, and it lists those two cards.
    const log = logLines(world);
    assert.equal(log.length, 1, "the log must gain exactly one line");
    assert.match(log[0] ?? "", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "the log line has no time");
    assert.match(log[0] ?? "", / signed /);
    for (const line of expected) assert.ok(log[0]?.includes(`${line.id}=${line.hash}`), `the log line does not list ${line.id} with its hash`);
  });
}

// Blocked by the law: a local program hands the helper cards of its own, which do not wait on the
// server. Nothing is signed. The named finger is on the reader all the time here: only the helper
// stands in the way.
export async function blockedCardsOfItsOwn(start: Start): Promise<void> {
  await withHelper(start, ["A-01", "A-02"], async (world) => {
    const { reader } = world;
    reader.eager = NAMED;
    const waiting = await post(world.server, requestFor(world, ["A-01"]));
    const own = JSON.parse(requestFor(world, ["A-02"])) as { cards: unknown[] };
    // The local program also runs a server of its own, and its cards wait there.
    const elsewhere = await post(world.other, requestFor(world, ["A-02"]));

    const calls: [string, unknown][] = [
      ["cards in place of the id of a request", own],
      ["cards next to the id of a request that waits", { approve: waiting, cards: own.cards }],
      ["an id under which nothing waits", { approve: NOWHERE }],
      ["the id of a request that waits on another server", { approve: elsewhere }],
      ["the address of another server next to an id", { approve: elsewhere, server: world.other }],
      ["an id that is a path", { approve: `../../${waiting}` }],
      ["an address in place of an id", { approve: `${world.other}api/requests/${elsewhere}` }],
      ["a manifest of its own to sign", { approve: waiting, manifest: `signed: 2026-01-01T00:00:00.000Z\nA-02 ${hashOf(world, "A-02")}\n` }],
    ];
    for (const [what, message] of calls) {
      const outcome = await call(world, message);
      assertNothingSigned(world, outcome, `a local program handed the helper ${what}, and the helper signed`);
      assert.deepEqual(reader.asked, [], `a local program handed the helper ${what}, and the reader was asked`);
    }
    assert.deepEqual(await held(world, waiting), { state: "waiting" });
    assert.equal(logLines(world).length, calls.length, "every refusal must be written to the log");
  });
}

// Blocked by the law: the reader reports a match for a different finger than the named one.
export async function blockedAnotherFinger(start: Start): Promise<void> {
  await withHelper(start, ["A-01", "A-02"], async (world) => {
    const { reader } = world;
    const id = await post(world.server, requestFor(world, ["A-01", "A-02"]));
    const pending = call(world, { approve: id });
    await asked(reader);
    reader.touch(OTHER);
    const outcome = await pending;
    assertNothingSigned(world, outcome, "the laptop signer signed although the named finger did not match after the list was sent");
    assert.deepEqual(await held(world, id), { state: "waiting" }, "the server got a signature although another finger touched the reader");
    assert.equal(logLines(world).length, 1, "the refusal must be written to the log");
    assert.match(logLines(world)[0] ?? "", /refused.*A-01=.*A-02=/, "the log line must say what was refused");
  });
}

// Blocked by the law: nobody touches the reader for the time limit. Nothing is signed, also not by a
// touch that comes later, and also not if the reader itself never answers.
export async function blockedNoTouch(start: Start): Promise<void> {
  for (const hung of [false, true]) {
    await withHelper(start, ["A-01"], async (world) => {
      const { reader } = world;
      reader.hung = hung;
      const id = await post(world.server, requestFor(world, ["A-01"]));
      const pending = call(world, { approve: id });
      await asked(reader);
      const outcome = await within(LIMIT + SOON, pending);
      if (outcome === null) {
        reader.touch(NAMED);
        const late = await within(SOON, pending);
        const then = late?.approved ? ", and a touch after the limit was signed" : "";
        throw new Error(`nobody touched the reader, and after the time limit the helper was still waiting${then}`);
      }
      assertNothingSigned(world, outcome, "the helper signed although nobody touched the reader");
      reader.touch(NAMED); // too late: nobody is waiting for it
      assert.deepEqual(await held(world, id), { state: "waiting" });
      assert.match(logLines(world).join("\n"), /refused/, "the refusal must be written to the log");
    });
  }
}

// Blocked by the law: a second call while the first one waits for the finger. It is refused at once.
export async function blockedSecondCall(start: Start): Promise<void> {
  await withHelper(start, ["A-01", "A-02"], async (world) => {
    const { reader } = world;
    const first = await post(world.server, requestFor(world, ["A-01"]));
    const second = await post(world.server, requestFor(world, ["A-02"]));
    const pending = call(world, { approve: first });
    await asked(reader);
    const refused = await within(LIMIT / 2, call(world, { approve: second }));
    if (refused === null) throw new Error("a second call was not refused at once while the first one waited for the finger");
    assertNothingSigned(world, refused, "a second call was signed while the first one waited for the finger");
    assert.equal(reader.asked.length, 1, "the reader was asked for the second call");

    reader.touch(NAMED);
    assert.equal((await pending).approved, true, "the touch must approve the first request");
    assert.equal(String((await held(world, first))["manifest"]).split("\n")[1], `A-01 ${hashOf(world, "A-01")}`);
    assert.deepEqual(await held(world, second), { state: "waiting" }, "one touch approved the second request as well");
    const log = logLines(world);
    assert.equal(log.filter((line) => line.includes(" signed ")).length, 1, "one touch, one signing in the log");
    assert.ok(log.some((line) => line.includes("refused")), "the refusal of the second call must be in the log");
  });
}

// One match signs one list: no match is kept for a later call, and a touch from before a call counts
// for nothing.
export async function oneMatchSignsOneList(start: Start): Promise<void> {
  await withHelper(start, ["A-01", "A-02"], async (world) => {
    const { reader } = world;
    const first = await post(world.server, requestFor(world, ["A-01"]));
    const second = await post(world.server, requestFor(world, ["A-02"]));

    reader.touch(NAMED); // meant for something else, before any call
    const before = call(world, { approve: first });
    await asked(reader);
    assertNothingSigned(world, await before, "a touch from before the call signed a list");

    const touched = call(world, { approve: first });
    await asked(reader);
    reader.touch(NAMED);
    assert.equal((await touched).approved, true, "the named finger touched the reader and nothing was approved");

    const after = call(world, { approve: second });
    await asked(reader);
    const outcome = await after;
    assert.equal(outcome.approved, false, "one match signed a second list");
    assert.deepEqual(await held(world, second), { state: "waiting" }, "one match signed a second list");
    assert.equal(reader.asked.length, 3, "the reader must be asked again for every call");
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
    eager: null,
    check: async (finger, user, milliseconds) => {
      const turn = reader.asked.length;
      const entry = { finger, user, hadList: false };
      reader.asked.push(entry);
      // A helper that keeps the law has sent the list already. It needs a moment to arrive.
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
        if (reader.eager !== null) waiting(reader.eager);
      });
    },
    touch: (finger) => waiting?.(finger),
    nextAsk: () => new Promise((resolve) => wake.push(resolve)),
  };
  return reader;
}

// Waits until the helper asks the reader. A broken helper may never ask: then this gives up, and the
// test goes on to see what such a helper answers.
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

// Starts two signing servers and the helper on a new world, runs the body, and stops and removes
// everything. The helper's key does not exist yet: the helper makes it when it starts.
async function withHelper(start: Start, ids: string[], body: (world: World) => Promise<void>): Promise<void> {
  const folder = mkdtempSync(join(tmpdir(), "laws-t09-"));
  const running: { stop: () => Promise<void> }[] = [];
  try {
    const repo = join(folder, "repo");
    mkdirSync(join(repo, "laws", "approvals"), { recursive: true });
    mkdirSync(join(repo, "frozen"));
    for (const id of ids) {
      const bite = "bite: echo the blocked case was caught; exit 1\nbite-says: the blocked case was caught\n";
      const frontMatter = `---\nid: ${id}\ngrade: chosen\ncheck: true\n${bite}frozen: [frozen/${id}.txt]\n---\n`;
      writeFileSync(join(repo, "laws", `${id}.md`), `${frontMatter}# ${id} The law of ${id}\n`);
      writeFileSync(join(repo, "frozen", `${id}.txt`), `what ${id} depends on\n`);
    }
    const site = { origin: "https://laws.example.test", rpId: "laws.example.test", signers: null };
    const server = await startServer({ port: 0, state: join(folder, "server"), ...site }, () => {});
    running.push(server);
    const other = await startServer({ port: 0, state: join(folder, "other-server"), ...site }, () => {});
    running.push(other);
    const address = `http://127.0.0.1:${server.port}/`;
    const settings = { socket: join(folder, "socket"), server: address, key: join(folder, "key"), log: join(folder, "helper.log"), user: "alex", finger: NAMED };
    const world = { folder, repo, signers: join(folder, "allowed_signers"), server: address, other: `http://127.0.0.1:${other.port}/`, settings, reader: newReader() };
    running.push(await start(settings, world.reader, LIMIT));
    // The signers file names the key that the helper made.
    writeFileSync(world.signers, `owner ${readFileSync(`${settings.key}.pub`, "utf8")}`);
    await body(world);
  } finally {
    for (const one of running.reverse()) await one.stop();
    rmSync(folder, { recursive: true, force: true });
  }
}

// A request, as the laws command posts it to the server: the bytes of each card and of its frozen file.
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

// Posts a request to a signing server, so that it waits there. Returns its id.
async function post(server: string, request: string): Promise<string> {
  const response = await fetch(`${server}api/requests`, { method: "POST", headers: { "Content-Type": "application/json" }, body: request });
  const { id } = (await response.json()) as { id?: string };
  assert.equal(response.status, 200, "the signing server did not take the test's request");
  return String(id);
}

// What the server holds for a request: waiting, or the manifest with its signature.
async function held(world: World, id: string): Promise<Record<string, unknown>> {
  return (await (await fetch(`${world.server}api/requests/${id}/result`)).json()) as Record<string, unknown>;
}

// One call to the helper, as one line, and its answers: first the list, then approved or a refusal.
function call(world: World, message: unknown): Promise<Outcome> {
  return new Promise((done) => {
    const outcome: Outcome = { list: null, finger: null, approved: false, refused: null };
    const socket = createConnection(world.settings.socket);
    let text = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${JSON.stringify(message)}\n`));
    socket.on("data", (chunk) => {
      text += chunk;
      for (let at = text.indexOf("\n"); at !== -1; at = text.indexOf("\n")) {
        const answer = JSON.parse(text.slice(0, at)) as Record<string, unknown>;
        text = text.slice(at + 1);
        if (Array.isArray(answer["list"])) {
          outcome.list = answer["list"] as Line[];
          outcome.finger = String(answer["finger"]);
          world.reader.listsSeen += 1;
        }
        if (answer["approved"] === true) outcome.approved = true;
        if (typeof answer["refused"] === "string") outcome.refused = answer["refused"];
      }
    });
    socket.on("error", (error) => {
      outcome.refused ??= `no connection: ${error.message}`;
    });
    socket.on("close", () => {
      if (!outcome.approved) outcome.refused ??= "the helper hung up";
      done(outcome);
    });
  });
}

// Not approved, a refusal, and no log line that says "signed".
function assertNothingSigned(world: World, outcome: Outcome, why: string): void {
  assert.equal(outcome.approved, false, why);
  assert.ok(outcome.refused !== null, `${why}: the call was not refused`);
  assert.ok(!logLines(world).some((line) => line.includes(" signed ")), `${why}: the log shows a signing`);
}

// The hash of a card, computed here from the card file and its one frozen file.
function hashOf(world: World, id: string): string {
  const card = readFileSync(join(world.repo, "laws", `${id}.md`));
  return hashCard(card, [{ path: `frozen/${id}.txt`, bytes: readFileSync(join(world.repo, "frozen", `${id}.txt`)) }]);
}

// What the laws command does with what the server holds: the manifest and its signature go into laws/approvals/.
function store(world: World, result: Record<string, unknown>): void {
  writeFileSync(join(world.repo, "laws", "approvals", "batch.manifest"), String(result["manifest"]));
  writeFileSync(join(world.repo, "laws", "approvals", "batch.manifest.sig"), String(result["signature"]));
}

function verifies(world: World): boolean {
  return verifyRepo(world.repo, world.signers).ok;
}

function logLines(world: World): string[] {
  if (!existsSync(world.settings.log)) return [];
  return readFileSync(world.settings.log, "utf8").split("\n").filter((line) => line !== "");
}

// ---- The check: the property against the real helper, the real finger check, and the laws command. ----

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

// Waits until something is true, for a few seconds at most.
async function until(what: string, isTrue: () => boolean | Promise<boolean>): Promise<void> {
  for (let tries = 0; tries < 400; tries++) {
    if (await isTrue()) return;
    await sleep(25);
  }
  throw new Error(`this did not happen in time: ${what}`);
}

// The id of the one request that waits on the server.
async function waitingRequest(world: World): Promise<string> {
  let id = "";
  await until("the laws command posts its request", async () => {
    const { requests } = (await (await fetch(`${world.server}api/requests`)).json()) as { requests: { id: string }[] };
    id = requests[0]?.id ?? "";
    return id !== "";
  });
  return id;
}

async function rejectOnThePhone(world: World, id: string): Promise<void> {
  await fetch(`${world.server}api/requests/${id}/reject`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
}

// A stand-in for the signing server, to see how the helper reads answers. answers: what it says to
// "<method> <the end of the address>". posted: every signature that the helper handed to it.
type Fake = { address: string; answers: Map<string, { status: number; text: string; location?: string }>; posted: { manifest: string; signature: string }[]; stop: () => Promise<void> };

async function fakeServer(): Promise<Fake> {
  const fake: Fake = { address: "", answers: new Map(), posted: [], stop: async () => {} };
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const action = `${request.method} ${(request.url ?? "").split("/").at(-1)}`;
      if (action === "POST signature") fake.posted.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as { manifest: string; signature: string });
      const answer = fake.answers.get(action) ?? { status: 404, text: '{"error":"nothing here"}' };
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (answer.location !== undefined) headers["Location"] = answer.location;
      response.writeHead(answer.status, headers);
      response.end(answer.text);
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  fake.address = `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}/`;
  fake.stop = () =>
    new Promise((done) => {
      server.closeAllConnections();
      server.close(() => done());
    });
  return fake;
}

// A stand-in for the fprintd-verify program: a shell script.
function fakeProgram(folder: string, name: string, script: string): string {
  const file = join(folder, name);
  writeFileSync(file, `#!/bin/sh\n${script}\n`);
  chmodSync(file, 0o755);
  return file;
}

if (import.meta.main) {
  const quiet = (): void => {};
  const real: Start = (settings, reader, milliseconds) =>
    startLaptopSigner(settings, reader.check, quiet, { fingerMilliseconds: milliseconds, loopbackHttp: true });

  test("T-09 allowed: two cards wait on the server, the named finger, one manifest and one signature that laws verify accepts", () => allowedTwoCardsOneTouch(real));
  test("T-09 blocked: a local program hands the helper cards of its own", () => blockedCardsOfItsOwn(real));
  test("T-09 blocked: the reader reports another finger than the named one", () => blockedAnotherFinger(real));
  test("T-09 blocked: nobody touches the reader within the time limit", () => blockedNoTouch(real));
  test("T-09 blocked: a second call while the first one waits for the finger", () => blockedSecondCall(real));
  test("T-09 one match signs one list, and no match is kept", () => oneMatchSignsOneList(real));

  test("T-09 the settings: one finger by name, and an https address for the server", async () => {
    const folder = mkdtempSync(join(tmpdir(), "laws-t09-settings-"));
    try {
      const settings = { socket: join(folder, "socket"), server: "https://pi.example.ts.net/laws/", key: join(folder, "key"), log: join(folder, "log"), user: "alex", finger: NAMED };
      const words = (changed: Partial<Settings>): string[] => {
        const all = { ...settings, ...changed };
        return ["--socket", all.socket, "--server", all.server, "--key", all.key, "--log", all.log, "--user", all.user, "--finger", all.finger];
      };
      assert.deepEqual(readSettings(words({})), settings);
      const startsWith = async (changed: Partial<Settings>, switches: { loopbackHttp?: boolean }): Promise<boolean> => {
        try {
          await (await startLaptopSigner({ ...settings, ...changed }, newReader().check, quiet, switches)).stop();
          return true;
        } catch {
          return false;
        }
      };

      // "any" and names that fprintd does not know are refused, on the command line and at the start.
      for (const finger of ["any", "thumb", "right-index", "", "Right-Index-Finger"]) {
        assert.throws(() => readSettings(words({ finger })), /is not one finger/, finger);
        assert.equal(await startsWith({ finger }, {}), false, `the helper started with --finger ${finger}`);
      }
      // The server must be https. Plain http is taken only with the switch for tests, which the
      // command line cannot set, and then only for this machine itself.
      for (const server of ["http://pi.example.ts.net/laws/", "http://127.0.0.1:8123/", "pi.example.ts.net", "https://pi.example.ts.net/laws/?x=1", "ftp://pi.example.ts.net/"]) {
        assert.throws(() => readSettings(words({ server })), /--server/, server);
        assert.equal(await startsWith({ server }, {}), false, `the helper started with --server ${server}`);
      }
      assert.equal(await startsWith({ server: "http://pi.example.ts.net/laws/" }, { loopbackHttp: true }), false, "the switch for tests let plain http to another machine through");
      assert.ok(!existsSync(settings.key), "a helper that did not start made a key");
      assert.throws(() => readSettings(words({}).slice(0, -2)), /--finger is missing/);
      assert.throws(() => readSettings(words({}).slice(2)), /--socket is missing/);
      assert.throws(() => readSettings([...words({}), "--seconds", "3600"]), /unknown option/);
      assert.throws(() => readSettings([...words({}), "--http", "yes"]), /unknown option/);
      assert.equal(await startsWith({}, {}), true, "the helper must start with good settings");
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  test("T-09 the key is made at the first start, for the owner only, and kept after that", async () => {
    const folder = mkdtempSync(join(tmpdir(), "laws-t09-key-"));
    try {
      const settings = { socket: join(folder, "socket"), server: "https://pi.example.ts.net/laws/", key: join(folder, "key"), log: join(folder, "log"), user: "alex", finger: NAMED };
      const printed: string[] = [];
      const first = await startLaptopSigner(settings, newReader().check, (line) => printed.push(line));
      assert.equal(statSync(settings.socket).mode & 0o777, 0o660, "the socket is for its owner and its group");
      await first.stop();
      assert.equal(statSync(settings.key).mode & 0o777, 0o600, "the key must be readable by its owner only");
      const publicKey = readFileSync(`${settings.key}.pub`, "utf8").split(" ").slice(0, 2).join(" ");
      assert.ok(printed.includes(`alex namespaces="laws" ${publicKey}`), "the helper must print the line for the signers file");

      const key = readFileSync(settings.key, "utf8");
      await (await startLaptopSigner(settings, newReader().check, quiet)).stop();
      assert.equal(readFileSync(settings.key, "utf8"), key, "a second start must keep the key");
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  test("T-09 the helper computes the hashes from the bytes that the server sends, and hands the signature to the server itself", async () => {
    const fake = await fakeServer();
    try {
      await withHelper(
        (settings, reader, milliseconds) => real({ ...settings, server: fake.address }, reader, milliseconds),
        ["A-01"],
        async (world) => {
          world.reader.eager = NAMED;
          // Bytes that are in no file of this machine.
          const cardBytes = Buffer.from("---\nid: B-07\ngrade: chosen\ncheck: true\nfrozen: [not/on/this/disk.txt]\n---\n# B-07 Elsewhere\n");
          const fileBytes = Buffer.from("bytes that only the server holds\n");
          const card = { id: "B-07", retire: false, card: cardBytes.toString("base64"), files: [{ path: "not/on/this/disk.txt", bytes: fileBytes.toString("base64") }] };
          const retired = { id: "A-01", retire: true, card: readFileSync(join(world.repo, "laws", "A-01.md")).toString("base64"), files: [] };
          fake.answers.set("GET request", { status: 200, text: JSON.stringify({ cards: [card, retired] }) });
          fake.answers.set("POST signature", { status: 200, text: '{"stored":true,"checked":"not checked"}' });

          const outcome = await call(world, { approve: NOWHERE });
          const hash = hashCard(cardBytes, [{ path: "not/on/this/disk.txt", bytes: fileBytes }]);
          assert.deepEqual(outcome.list, [
            { id: "A-01", hash: null, title: "The law of A-01" },
            { id: "B-07", hash, title: "Elsewhere" },
          ]);
          assert.equal(outcome.approved, true, String(outcome.refused));

          // What the server got: exactly that list under its time, and a signature by the helper's key.
          assert.equal(fake.posted.length, 1, "the helper must hand one signature to the server");
          const { manifest, signature } = fake.posted[0] ?? { manifest: "", signature: "" };
          assert.deepEqual(manifest.split("\n").slice(1), ["A-01 retired", `B-07 ${hash}`, ""]);
          const file = join(world.folder, "posted.sig");
          writeFileSync(file, signature);
          const options = ["-Y", "verify", "-f", world.signers, "-I", "owner", "-n", "laws", "-s", file];
          assert.equal(spawnSync("ssh-keygen", options, { input: manifest, encoding: "utf8" }).status, 0, "the signature that the server got is not by the helper's key over that manifest");
          assert.match(logLines(world)[0] ?? "", new RegExp(` signed request=${NOWHERE} A-01=retired B-07=${hash}$`));
        },
      );
    } finally {
      await fake.stop();
    }
  });

  test("T-09 what the server answers is read strictly: anything else is refused before the reader is asked", async () => {
    const fake = await fakeServer();
    try {
      await withHelper(
        (settings, reader, milliseconds) => real({ ...settings, server: fake.address }, reader, milliseconds),
        ["A-01", "A-02"],
        async (world) => {
          world.reader.eager = NAMED;
          const good = JSON.parse(requestFor(world, ["A-01"])) as { cards: Record<string, unknown>[] };
          const card = good.cards[0] ?? {};
          // A real request waits on the real server. A redirect to it must not be followed.
          const waiting = await post(world.server, requestFor(world, ["A-01"]));
          const answers: { status: number; text: string; location?: string }[] = [
            { status: 200, text: "not json" },
            { status: 200, text: "<html>a page</html>" },
            { status: 200, text: "{}" },
            { status: 200, text: JSON.stringify({ cards: [] }) },
            { status: 200, text: JSON.stringify({ cards: [card], extra: true }) },
            { status: 200, text: JSON.stringify({ cards: [card, card] }) },
            { status: 200, text: JSON.stringify({ cards: [{ ...card, id: "A-02" }] }) },
            { status: 200, text: JSON.stringify({ cards: [{ ...card, files: [] }] }) },
            { status: 200, text: JSON.stringify({ cards: [{ ...card, files: [{ path: "frozen/A-01.txt", bytes: "####" }] }] }) },
            { status: 200, text: JSON.stringify({ cards: [{ ...card, path: "/etc/passwd" }] }) },
            { status: 200, text: JSON.stringify({ cards: [{ ...card, files: [{ path: "frozen/A-01.txt", bytes: Buffer.alloc(1024 * 1024 + 1, 97).toString("base64") }] }] }) },
            { status: 200, text: `{"cards":[],"padding":"${"x".repeat(13 * 1024 * 1024)}"}` },
            { status: 500, text: '{"error":"the server failed"}' },
            { status: 404, text: '{"error":"there is no such request"}' },
            { status: 302, text: "{}", location: `${world.server}api/requests/${waiting}/request` },
            { status: 201, text: JSON.stringify(good) },
          ];
          for (const answer of answers) {
            fake.answers.set("GET request", answer);
            const outcome = await call(world, { approve: NOWHERE });
            assertNothingSigned(world, outcome, `the helper signed after the server answered: ${answer.status} ${answer.text.slice(0, 80)}`);
          }
          assert.deepEqual(world.reader.asked, [], "the reader was asked although the server's answer was not a request");
          assert.deepEqual(fake.posted, []);
          assert.equal(logLines(world).length, answers.length, "every refusal must be written to the log");
        },
      );
    } finally {
      await fake.stop();
    }
  });

  test("T-09 a signature that the server does not take is said so, and the log keeps both lines", async () => {
    await withHelper(real, ["A-01"], async (world) => {
      const id = await post(world.server, requestFor(world, ["A-01"]));
      const pending = call(world, { approve: id });
      await asked(world.reader);
      await rejectOnThePhone(world, id); // the request is closed on the server while the helper waits
      world.reader.touch(NAMED);
      const outcome = await pending;
      assert.equal(outcome.approved, false);
      assert.match(outcome.refused ?? "", /the signing server did not take the signature: this request was rejected/);
      assert.deepEqual(await held(world, id), { state: "rejected" });
      const log = logLines(world);
      assert.equal(log.length, 2);
      assert.match(log[0] ?? "", new RegExp(` signed request=${id} A-01=`));
      assert.match(log[1] ?? "", new RegExp(` refused:not-delivered request=${id} A-01=`));
    });
  });

  test("T-09 a program that calls and then goes away gets nothing signed, also when the finger comes", async () => {
    await withHelper(real, ["A-01"], async (world) => {
      const id = await post(world.server, requestFor(world, ["A-01"]));
      const socket = createConnection(world.settings.socket);
      socket.on("connect", () => socket.write(`${JSON.stringify({ approve: id })}\n`));
      socket.on("error", () => {});
      socket.setEncoding("utf8");
      socket.on("data", () => {
        world.reader.listsSeen += 1;
        socket.destroy(); // it has the list, and hangs up
      });
      await asked(world.reader);
      await sleep(50);
      world.reader.touch(NAMED);
      await until("the helper writes its log line", () => logLines(world).length > 0);
      assert.equal(logLines(world).length, 1);
      assert.match(logLines(world)[0] ?? "", new RegExp(` refused:caller-gone request=${id} A-01=`));
      assert.deepEqual(await held(world, id), { state: "waiting" });
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

  test("T-09 laws sign posts to the server, prints the list and the finger, and stores what the server then holds", async () => {
    await withHelper(real, ["A-01", "A-02"], async (world) => {
      const { reader } = world;
      const approvals = (): string[] => readdirSync(join(world.repo, "laws", "approvals")).sort();
      const sign = ["sign", "--server", world.server, "--laptop", world.settings.socket];

      // The named finger. The list is printed first, then the line that names the finger.
      reader.eager = NAMED;
      const [exitCode, printed] = await laws(world, sign);
      assert.equal(exitCode, 0, printed);
      const list = `  sign    A-01  ${hashOf(world, "A-01")}  The law of A-01\n  sign    A-02  ${hashOf(world, "A-02")}  The law of A-02\n`;
      const finger = "put your right index finger on the fingerprint reader now.";
      assert.ok(printed.includes(list), printed);
      assert.match(printed, new RegExp(`^ {2}${world.server.replaceAll(".", "\\.")}\\?r=[0-9a-f]{32}$`, "m"), "the address for the phone must be printed as well");
      assert.ok(printed.indexOf(list) < printed.indexOf(finger), "the list must be printed before the person is asked for the finger");
      assert.match(printed, /approved A-01, A-02 with your finger on the laptop: stored laws\/approvals\/\S+\.manifest and \.manifest\.sig/);
      assert.match(printed, /verified: every card is approved as it is now\n$/, "laws sign must run verify at the end");
      assert.deepEqual(approvals().map((name) => name.replace(/^[^.]+\.[^.]+/, "")), [".manifest", ".manifest.sig"]);
      assert.equal(verifies(world), true, "what laws sign stored does not verify");

      // A retirement, with the server from LAWS_SIGNER.
      const [retiredCode, retired] = await laws(world, ["retire", "A-02", "--laptop", world.settings.socket], { LAWS_SIGNER: `server:${world.server}` });
      assert.equal(retiredCode, 0, retired);
      assert.match(retired, /^ {2}retire {2}A-02 {2}The law of A-02$/m);
      rmSync(join(world.repo, "laws", "A-02.md"));
      assert.equal(verifies(world), true, "a card that was retired with the finger could not be removed");
      assert.equal(logLines(world).filter((line) => line.includes(" signed ")).length, 2);

      // The wrong finger: laws sign says so and goes on waiting for the phone. Rejected there, it
      // fails, and nothing is stored.
      writeFileSync(join(world.repo, "frozen", "A-01.txt"), "changed, so it waits again\n");
      const before = approvals();
      reader.eager = OTHER;
      const waiting = laws(world, sign);
      await until("the helper refuses the other finger", () => logLines(world).some((line) => line.includes("refused:no-match")));
      await rejectOnThePhone(world, await waitingRequest(world));
      const [refusedCode, refused] = await waiting;
      assert.equal(refusedCode, 1, refused);
      assert.match(refused, /the fingerprint helper did not approve: the reader did not see the right-index-finger.*You can still sign on the phone/);
      assert.match(refused, /every card was rejected on the phone/);
      assert.deepEqual(approvals(), before);

      // --phone: the finger is not offered at all.
      reader.eager = NAMED;
      const calls = reader.asked.length;
      const onPhone = laws(world, ["sign", "--server", world.server, "--phone"]);
      await rejectOnThePhone(world, await waitingRequest(world));
      const [phoneCode, phonePrinted] = await onPhone;
      assert.equal(phoneCode, 1, phonePrinted);
      assert.doesNotMatch(phonePrinted, /fingerprint reader/);
      assert.equal(reader.asked.length, calls, "--phone was given and the reader was asked");

      // A helper that is named and not there, and options that do not go together.
      const [goneCode, gone] = await laws(world, ["sign", "--server", world.server, "--laptop", join(world.folder, "no-socket")]);
      assert.equal(goneCode, 1);
      assert.match(gone, /there is no fingerprint helper at/);
      for (const words of [[...sign, "--phone"], ["sign", "--signer", "true", "--laptop", world.settings.socket], [...sign, "--signer", "true"]]) {
        assert.equal((await laws(world, words))[0], 1, words.join(" "));
      }
      assert.deepEqual(approvals(), before);
    });
  });

  test("T-09 the real program refuses to start with --finger any, and with a server that is not https", () => {
    const program = join(import.meta.dirname, "../../signer/laptop.ts");
    const folder = mkdtempSync(join(tmpdir(), "laws-t09-start-"));
    try {
      const words = (server: string, finger: string): string[] => ["--socket", join(folder, "socket"), "--server", server, "--key", join(folder, "key"), "--log", join(folder, "log"), "--user", "alex", "--finger", finger];
      const any = spawnSync(process.execPath, [program, ...words("https://pi.example.ts.net/laws/", "any")], { encoding: "utf8", timeout: 20000 });
      assert.equal(any.status, 1);
      assert.match(any.stderr, /"any" is refused on purpose/);
      const plain = spawnSync(process.execPath, [program, ...words("http://127.0.0.1:8123/", NAMED)], { encoding: "utf8", timeout: 20000 });
      assert.equal(plain.status, 1);
      assert.match(plain.stderr, /must be an https address/);
      assert.ok(!existsSync(join(folder, "key")) && !existsSync(join(folder, "socket")));
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
}
