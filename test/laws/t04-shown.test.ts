// The check of law T-04 (laws/T-04.md): the signing side signs only the list it computed and showed.
// "The signing side" is the laptop's fingerprint helper and the phone page, both fed by the signing
// server. This file and its bite are frozen with the card, so everything the check means is written here.
//
// Each side is asked about a request that waits on a real signing server. It answers with the list that it
// showed and the list that it would sign (null: nothing is signed). The law says: what is signed is what
// was shown, what was shown is computed from the bytes of the request, and with no list nothing is signed.
// T-09 (the helper) and T-11 (the page and the server) check the same from their own sides, in more detail.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { decisionSummary } from "../../server/page/pure.js";
import { startServer } from "../../server/server.ts";
import { startLaptopSigner } from "../../signer/laptop.ts";
import { hashCard } from "../../src/hash.ts";

// One line of the list: a card, the hash computed from its bytes, and its title.
export type Line = { id: string; hash: string; title: string };
// What a side shows, and what it would sign: the text of the manifest, or null if it signs nothing.
export type Approval = { shown: Line[] | null; signed: string | null };
// A side, ready: approve(id, between) shows the list of that request and signs. between() runs after the
// list was shown and before anything is signed, and a test uses it to change what the server holds.
export type Running = { approve: (id: string, between: () => Promise<void>) => Promise<Approval>; stop: () => Promise<void> };
// A temporary folder with a real signing server. state is the server's own folder.
export type World = { folder: string; state: string; server: string };
// What is under test: a way to start one side against this world.
export type Side = (world: World) => Promise<Running>;

const ORIGIN = "https://laws.example.test";
const RP_ID = "laws.example.test";
const NOWHERE = "0123456789abcdef0123456789abcdef"; // an id under which nothing waits
const CARDS = [
  { id: "A-01", title: "The first law", files: { "frozen/A-01.txt": "what A-01 depends on\n" } },
  { id: "B-02", title: "The second law", files: { "frozen/B-02.txt": "one\n", "frozen/B-02-more.txt": "two\n" } },
  { id: "C-03", title: "The third law", files: { "frozen/C-03.txt": "what C-03 depends on\n" } },
];

// ---- The property. The bite runs the same functions against broken sides. ----

// Allowed by the law: three cards wait on the server. The side shows id, title and the hash that is
// computed from the bytes of the card and of its frozen files, and what it signs is exactly that list.
export async function allowedShownIsSigned(side: Side): Promise<void> {
  await withSide(side, async (world, running) => {
    const id = await post(world.server);
    const done = await running.approve(id, async () => {});
    const expected = CARDS.map((card) => ({ id: card.id, title: card.title, hash: hashOfCard(card) }));
    assert.deepEqual(done.shown, expected, "the list that was shown is not computed from the bytes of the three cards");
    assert.ok(done.signed !== null, "nothing was signed for three cards that the side showed");
    assert.deepEqual(linesOf(done.signed), expected.map(({ id: card, hash }) => ({ id: card, hash })), "a list that was not shown was signed");
    assert.match(done.signed.split("\n")[0] ?? "", /^signed: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, "the signed list does not start with its time");
  });
}

// Blocked by the law: the side is asked about a request that does not wait on the server, or no longer
// waits there (it was rejected). It has no list, so nothing is signed, and a request that does wait stays unsigned.
export async function blockedNoList(side: Side): Promise<void> {
  await withSide(side, async (world, running) => {
    const waiting = await post(world.server);
    const unknown = await running.approve(NOWHERE, async () => {});
    assert.equal(unknown.signed, null, "something was signed for a request that does not exist: there was no list");
    assert.deepEqual(await stateOf(world, waiting), { state: "waiting" }, "an unrelated request was signed");

    const closed = await post(world.server);
    await fetch(`${world.server}api/requests/${closed}/reject`, { method: "POST", headers: JSON_TYPE, body: "{}" });
    assert.deepEqual(await stateOf(world, closed), { state: "rejected" }, "the test could not close its request");
    const afterwards = await running.approve(closed, async () => {});
    assert.equal(afterwards.signed, null, "something was signed for a request that was closed: there was no list");
    assert.deepEqual(await stateOf(world, waiting), { state: "waiting" }, "the request that waits was signed");
  });
}

// Blocked by the law: the bytes of a card change on the server after the side showed the list. Whatever
// the side signs next, it is not another list than the one that was shown.
export async function blockedChangedAfterShowing(side: Side): Promise<void> {
  await withSide(side, async (world, running) => {
    const id = await post(world.server);
    const done = await running.approve(id, async () => changeStoredBytes(world, id));
    assert.ok(done.shown !== null, "the side showed no list");
    if (done.signed !== null) {
      const shown = done.shown.map(({ id: card, hash }) => ({ id: card, hash }));
      assert.deepEqual(linesOf(done.signed), shown, "a list that was not shown was signed, after the bytes changed");
    }
  });
}

// ---- The sides: the real ones, and the pieces that the bite breaks. ----

// What a request holds, read the way a side reads it: the cards with their hashes computed from the bytes.
export async function honestList(server: string, id: string): Promise<Line[] | null> {
  const reply = await fetch(`${server}api/requests/${id}/request`);
  if (reply.status !== 200) return null;
  const { cards } = (await reply.json()) as { cards: { id: string; card: string; files: { path: string; bytes: string }[] }[] };
  return cards.map(({ id: card, card: bytes, files }) => {
    const raw = Buffer.from(bytes, "base64");
    const hash = hashCard(raw, files.map((file) => ({ path: file.path, bytes: Buffer.from(file.bytes, "base64") })));
    return { id: card, hash, title: /^# \S+ (.*)$/m.exec(raw.toString("utf8"))?.[1] ?? "" };
  });
}

export function manifestOfLines(lines: { id: string; hash: string }[]): string {
  return `signed: ${new Date().toISOString()}\n${lines.map((line) => `${line.id} ${line.hash}\n`).join("")}`;
}

// The laptop's fingerprint helper, the real program, with a reader that always matches the named finger.
export const helperSide: Side = async (world) => {
  let between: () => Promise<void> = async () => {};
  const settings = { socket: join(world.folder, "socket"), server: world.server, key: join(world.folder, "key"), log: join(world.folder, "helper.log"), user: "alex", finger: "right-index-finger" };
  const reader = async (): Promise<{ match: boolean; detail: string }> => {
    await between(); // the list has been sent by now
    return { match: true, detail: "verify-match" };
  };
  const service = await startLaptopSigner(settings, reader, () => {}, { fingerMilliseconds: 3000, loopbackHttp: true });
  return {
    approve: async (id, hook) => {
      between = hook;
      const talk = await callHelper(settings.socket, id);
      const result = (await (await fetch(`${world.server}api/requests/${id}/result`)).json()) as { state: string; manifest?: string };
      return { shown: talk.list, signed: talk.approved && result.state === "signed" ? (result.manifest ?? null) : null };
    },
    stop: service.stop,
  };
};

// The phone's page, with its own functions: it opens the request, shows each card, accepts all of them,
// and asks the server for the list that the passkey would sign. The passkey signs the challenge, which
// must be the hash of exactly that list.
export const phoneSide: Side = async (world) => ({
  approve: async (id, between) => {
    const opened = await fetch(`${world.server}api/requests/${id}`);
    if (opened.status !== 200) return { shown: null, signed: null };
    const { cards } = (await opened.json()) as { cards: (Line & { retire: boolean })[] };
    const shown = cards.map(({ id: card, hash, title }) => ({ id: card, hash, title }));
    await between();
    const summary = decisionSummary(cards, new Map(cards.map((card) => [card.id, "accept"])));
    const reply = await fetch(`${world.server}api/requests/${id}/options`, { method: "POST", headers: JSON_TYPE, body: JSON.stringify({ accept: summary.accepted }) });
    const offered = (await reply.json()) as { manifest?: string; challenge?: string };
    if (reply.status !== 200 || typeof offered.manifest !== "string") return { shown, signed: null };
    const challenge = createHash("sha256").update("laws manifest v1\n").update(offered.manifest).digest("base64url");
    assert.equal(offered.challenge, challenge, "the phone is asked to sign something else than the list that it was offered");
    return { shown, signed: offered.manifest };
  },
  stop: async () => {},
});

const JSON_TYPE = { "Content-Type": "application/json" };

// ---- Helpers. ----

export function linesOf(manifest: string): { id: string; hash: string }[] {
  return manifest
    .split("\n")
    .slice(1)
    .filter((line) => line !== "")
    .map((line) => ({ id: line.split(" ")[0] ?? "", hash: line.split(" ")[1] ?? "" }));
}

function cardBytes(card: (typeof CARDS)[number]): Buffer {
  const paths = Object.keys(card.files).join(", ");
  const head = `---\nid: ${card.id}\ngrade: chosen\ncheck: true\nbite: echo the blocked case was caught; exit 1\nbite-says: the blocked case was caught\nfrozen: [${paths}]\n---\n`;
  return Buffer.from(`${head}# ${card.id} ${card.title}\n`);
}

function hashOfCard(card: (typeof CARDS)[number]): string {
  return hashCard(cardBytes(card), Object.entries(card.files).map(([path, text]) => ({ path, bytes: Buffer.from(text) })));
}

// The request that the laws command would post for the three cards.
function requestText(): string {
  const cards = CARDS.map((card) => ({
    id: card.id,
    retire: false,
    card: cardBytes(card).toString("base64"),
    files: Object.entries(card.files).map(([path, text]) => ({ path, bytes: Buffer.from(text).toString("base64") })),
  }));
  return JSON.stringify({ cards });
}

async function post(server: string): Promise<string> {
  const reply = await fetch(`${server}api/requests`, { method: "POST", headers: JSON_TYPE, body: requestText() });
  assert.equal(reply.status, 200, "the signing server did not take the test's request");
  return String(((await reply.json()) as { id: string }).id);
}

async function stateOf(world: World, id: string): Promise<Record<string, unknown>> {
  return (await (await fetch(`${world.server}api/requests/${id}/result`)).json()) as Record<string, unknown>;
}

// Whoever has the server's folder can change what a request holds: here, the bytes of one frozen file.
function changeStoredBytes(world: World, id: string): void {
  const file = join(world.state, id, "request.json");
  const request = JSON.parse(readFileSync(file, "utf8")) as { cards: { files: { bytes: string }[] }[] };
  const first = request.cards[0]?.files[0];
  assert.ok(first !== undefined, "the stored request has no file to change");
  first.bytes = Buffer.from("changed on the server\n").toString("base64");
  writeFileSync(file, JSON.stringify(request));
}

// One call to the helper: the list that it answered with, then whether it approved.
function callHelper(socket: string, id: string): Promise<{ list: Line[] | null; approved: boolean }> {
  return new Promise((done) => {
    const outcome: { list: Line[] | null; approved: boolean } = { list: null, approved: false };
    const connection = createConnection(socket);
    let text = "";
    connection.setEncoding("utf8");
    connection.on("connect", () => connection.write(`${JSON.stringify({ approve: id })}\n`));
    connection.on("data", (chunk) => {
      text += chunk;
      for (let at = text.indexOf("\n"); at !== -1; at = text.indexOf("\n")) {
        const answer = JSON.parse(text.slice(0, at)) as Record<string, unknown>;
        text = text.slice(at + 1);
        if (Array.isArray(answer["list"])) outcome.list = answer["list"] as Line[];
        if (answer["approved"] === true) outcome.approved = true;
      }
    });
    connection.on("error", () => {});
    connection.on("close", () => done(outcome));
  });
}

// A real signing server and one side, in a new folder. Both stop when the body is done.
async function withSide(side: Side, body: (world: World, running: Running) => Promise<void>): Promise<void> {
  const folder = mkdtempSync(join(tmpdir(), "laws-t04-"));
  const stops: (() => Promise<void>)[] = [];
  try {
    const state = join(folder, "server");
    const server = await startServer({ port: 0, state, origin: ORIGIN, rpId: RP_ID, signers: null }, () => {});
    stops.push(server.stop);
    const world = { folder, state, server: `http://127.0.0.1:${server.port}/` };
    mkdirSync(join(folder, "frozen"), { recursive: true });
    const running = await side(world);
    stops.push(running.stop);
    await body(world, running);
  } finally {
    for (const stop of stops.reverse()) await stop();
    rmSync(folder, { recursive: true, force: true });
  }
}

// ---- The check: the property against the real helper and the real page and server. ----

if (import.meta.main) {
  for (const [name, side] of [["the laptop's helper", helperSide], ["the phone's page", phoneSide]] as const) {
    test(`T-04 allowed: ${name} shows the list computed from the bytes and signs exactly it`, () => allowedShownIsSigned(side));
    test(`T-04 blocked: ${name} is asked about a request that does not wait: nothing is signed`, () => blockedNoList(side));
    test(`T-04 blocked: ${name}: the bytes change after the list was shown, and no other list is signed`, () => blockedChangedAfterShowing(side));
  }
}
