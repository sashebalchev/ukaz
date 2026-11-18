// The check of law T-11 (laws/T-11.md): one signing server. Every approval passes through it, and it
// cannot approve anything itself.
// This file and its bite are frozen with the card, so everything the check means is written here.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { assertionBody, decisionSummary, requestIdFrom } from "../../server/page/pure.js";
import { startServer } from "../../server/server.ts";
import { hashCard } from "../../src/hash.ts";
import { verifyRepo } from "../../src/verify.ts";

// What is under test, on the server's side: a way to start the signing server on a state folder.
// url ends in "/". The page and the laptop reach everything under it.
export type Server = { url: string; stop: () => Promise<void> };
export type Start = (state: string, signers: string | null) => Promise<Server>;

// What is under test, on the laptop's side: does this repository verify against this signers file?
export type Verify = (repo: string, signersFile: string) => boolean;

// A software passkey. It does with a key in memory what a phone does with the key in its chip, and it
// remembers every challenge it signed, with the answer it gave.
export type Phone = {
  credentialId: Buffer;
  privateKey: KeyObject;
  publicKey: KeyObject;
  signed: Map<string, string>; // challenge -> the text of the passkey file for its answer
};

// A temporary folder. The signers file names the phone's passkey and the laptop's SSH key. The other
// passkey and the other SSH key are named nowhere. laptopSigned: every manifest that the laptop key
// signed in these tests, with its signature.
export type World = {
  folder: string;
  signers: string;
  phone: Phone;
  stranger: Phone;
  laptopKey: string;
  strangerKey: string;
  laptopSigned: Map<string, string>;
};

// What the page gets for one request, and what it shows.
type ShownCard = { id: string; retire: boolean; hash: string | null; title: string; text: string; figure: { path: string; text: string } | null; files: { path: string; bytes: number }[] };
type Shown = { id: string; state: string; by: string | null; manifest: string | null; cards: ShownCard[] };
type Reply = { status: number; body: Record<string, unknown> };
// How a visit of the phone to the page ended.
type Visit = { shown: Shown; offered: Reply; manifest: string | null; posted: Reply | null };

const CASES = 100;
const CLI = join(import.meta.dirname, "../../src/cli.ts");
const PAGE = join(import.meta.dirname, "../../server/page");
const SERVER = join(import.meta.dirname, "../../server/server.ts");
const ORIGIN = "https://laws.example.test";
const RP_ID = "laws.example.test";
const IDS = ["A-01", "B-02", "C-03"];
let count = 0;

// ---- The phone: a software passkey, and a person who uses the page. ----

export function newPhone(): Phone {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return { credentialId: randomBytes(16), privateKey, publicKey, signed: new Map() };
}

// What the phone and its browser hand to the page when it asks for a signature over this challenge.
// verified: the phone checked a finger or the screen lock.
export function passkeyAnswers(phone: Phone, challenge: string, verified = true): Parameters<typeof assertionBody>[0] {
  const sha256 = (data: string | Uint8Array): Buffer => createHash("sha256").update(data).digest();
  const clientDataJSON = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge, origin: ORIGIN, crossOrigin: false }));
  const authenticatorData = Buffer.concat([sha256(RP_ID), Buffer.from([verified ? 0x05 : 0x01, 0, 0, 0, 0])]);
  const signature = sign("sha256", Buffer.concat([authenticatorData, sha256(clientDataJSON)]), { key: phone.privateKey, dsaEncoding: "der" });
  const credential = { rawId: phone.credentialId, response: { authenticatorData, clientDataJSON, signature } };
  phone.signed.set(challenge, passkeyFile(assertionBody(credential)));
  return credential;
}

// The text of a <name>.passkey.json file for the four parts that the page posts.
function passkeyFile(parts: ReturnType<typeof assertionBody>): string {
  const { credentialId, authenticatorData, clientDataJSON, signature } = parts;
  return `${JSON.stringify({ credentialId, authenticatorData, clientDataJSON, signature }, null, 2)}\n`;
}

// The challenge that stands for a manifest: base64url(sha256("laws manifest v1\n" + the manifest bytes)).
export function challengeOf(manifest: string): string {
  return createHash("sha256").update("laws manifest v1\n").update(manifest).digest("base64url");
}

// What a person does on the page, with the page's own functions: open the request, read it, accept
// these cards and reject the others, and sign the list that the server offers with the passkey.
export async function visit(server: Server, phone: Phone, id: string, accept: string[], verified = true): Promise<Visit> {
  assert.equal(requestIdFrom(`?r=${id}`), id, "the page must take the request id from its address");
  const shown = (await call(server, `api/requests/${id}`)).body as unknown as Shown;
  return decide(server, phone, shown, accept, verified);
}

// The same, for a page that was loaded earlier and still shows what it showed then.
export async function decide(server: Server, phone: Phone, shown: Shown, accept: string[], verified = true): Promise<Visit> {
  const decisions = new Map(shown.cards.map((card) => [card.id, accept.includes(card.id) ? "accept" : "reject"]));
  const summary = decisionSummary(shown.cards, decisions);
  assert.ok(summary.complete, "every card must be decided before the page asks for the list");
  const offered = await call(server, `api/requests/${shown.id}/options`, { accept: summary.accepted });
  const { manifest, challenge } = offered.body;
  if (offered.status !== 200 || typeof manifest !== "string" || typeof challenge !== "string") return { shown, offered, manifest: null, posted: null };
  const posted = await call(server, `api/requests/${shown.id}/assertion`, assertionBody(passkeyAnswers(phone, challenge, verified)));
  return { shown, offered, manifest, posted };
}

// ---- The laptop: what its fingerprint helper does after the finger matched. ----

// Fetches the request from the server, computes the hashes here from those bytes, signs a manifest of
// these cards with an SSH key, and hands both to the server. lines: put other lines on the manifest.
export async function laptopApproves(server: Server, world: World, id: string, cards: string[], key = world.laptopKey, lines?: string[]): Promise<Reply> {
  const fetched = (await call(server, `api/requests/${id}/request`)).body as { cards?: { id: string; card: string; files: { path: string; bytes: string }[] }[] };
  const computed = (fetched.cards ?? [])
    .filter((card) => cards.includes(card.id))
    .map((card) => {
      const files = card.files.map((file) => ({ path: file.path, bytes: Buffer.from(file.bytes, "base64") }));
      return `${card.id} ${hashCard(Buffer.from(card.card, "base64"), files)}`;
    });
  const manifest = `signed: ${new Date().toISOString()}\n${(lines ?? computed).sort().map((line) => `${line}\n`).join("")}`;
  const signed = spawnSync("ssh-keygen", ["-Y", "sign", "-f", key, "-n", "laws"], { input: manifest, encoding: "utf8" });
  assert.equal(signed.status, 0, `ssh-keygen failed: ${signed.stderr}`);
  if (key === world.laptopKey) world.laptopSigned.set(manifest, signed.stdout);
  return call(server, `api/requests/${id}/signature`, { manifest, signature: signed.stdout });
}

// ---- The property. The bite runs the same functions against broken servers and broken ways to verify. ----

// Blocked by the law: the server's store is rewritten so that the signature for one list sits next to
// another list. laws verify fails.
export async function blockedStoreRewritten(start: Start, verify: Verify, world: World): Promise<void> {
  await withServer(start, world, async (server, state) => {
    const repo = newRepository(world, IDS);
    const id = await post(server, requestFor(repo, IDS));
    const signed = await visit(server, world.phone, id, ["A-01"]);
    assert.equal(signed.posted?.status, 200, "the phone could not sign one accepted card");

    // Root on the server puts the full list where the signed list was. The signature stays.
    const timeLine = (signed.manifest ?? "").split("\n")[0];
    writeFileSync(join(state, id, "manifest"), `${timeLine}\n${IDS.map((card) => `${card} ${hashOf(repo, card)}\n`).join("")}`);
    await fetchAndStore(server, id, repo);
    assert.equal(verify(repo, world.signers), false, "the server's store was rewritten and a list the passkey never signed verified");
  });
}

// Blocked by the law: three cards are sent and two are accepted on the page. The third is not in the
// signed list. The list is built from the accepted cards and from nothing else that the page sends.
export async function blockedThirdCardNotAccepted(start: Start, verify: Verify, world: World): Promise<void> {
  await withServer(start, world, async (server) => {
    const repo = newRepository(world, IDS);
    const id = await post(server, requestFor(repo, IDS));
    const { offered, manifest, posted } = await visit(server, world.phone, id, ["A-01", "C-03"]);
    const expected = `A-01 ${hashOf(repo, "A-01")}\nC-03 ${hashOf(repo, "C-03")}\n`;
    assert.equal(manifest?.split("\n").slice(1).join("\n"), expected, "three cards were sent, two were accepted, and the list to sign is not those two");
    assert.match(manifest?.split("\n")[0] ?? "", /^signed: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, "the list to sign must start with its time");
    assert.equal(offered.body["challenge"], challengeOf(manifest ?? ""), "the challenge is not the hash of the list that the page shows");
    assert.equal(posted?.status, 200);

    // The laptop gets that same list, and with it the third card is still waiting.
    const result = await fetchAndStore(server, id, repo);
    assert.equal(result.body["manifest"], manifest, "the laptop got another list than the phone signed");
    assert.equal(verify(repo, world.signers), false, "the third card was not accepted and the repository verified");
    rmSync(join(repo, "laws", "B-02.md"));
    assert.equal(verify(repo, world.signers), true, "the two accepted cards are not approved");
  });

  // What else a page could send does not get onto the list.
  await withServer(start, world, async (server) => {
    const repo = newRepository(world, IDS);
    const id = await post(server, requestFor(repo, IDS));
    const good = { id: "A-01", hash: hashOf(repo, "A-01") };
    const attempts: unknown[] = [
      { accept: [] },
      { accept: [good, { id: "Z-99", hash: "0".repeat(64) }] },
      { accept: [good, good] },
      { accept: [{ id: "B-02", hash: hashOf(repo, "A-01") }] },
      { accept: [{ ...good, title: "another title" }] },
      { accept: [good], manifest: `signed: 2026-01-01T00:00:00.000Z\nZ-99 ${"0".repeat(64)}\n` },
      { accept: [good], time: "2020-01-01T00:00:00.000Z" },
      { accept: "A-01" },
      [good],
    ];
    for (const attempt of attempts) {
      const reply = await call(server, `api/requests/${id}/options`, attempt);
      assert.notEqual(reply.status, 200, `the server offered a list for: ${JSON.stringify(attempt)}`);
      assert.equal(reply.body["challenge"], undefined);
    }
  });
}

// Blocked by the law: a card's bytes are changed on the server after the page showed it. The hash in
// the signed list no longer matches the card in the repository. And what the page shows always comes
// with the hash of exactly the bytes it shows.
export async function blockedBytesChangedOnServer(start: Start, verify: Verify, world: World): Promise<void> {
  await withServer(start, world, async (server, state) => {
    const repo = newRepository(world, ["A-01"]);
    const id = await post(server, requestFor(repo, ["A-01"]));
    const before = (await call(server, `api/requests/${id}`)).body as unknown as Shown;
    assert.equal(before.cards[0]?.text, readFileSync(join(repo, "laws", "A-01.md"), "utf8"), "the page does not show the card as it was sent");
    assert.equal(before.cards[0]?.hash, hashOf(repo, "A-01"), "the page does not show the hash of the bytes that were sent");

    // Root on the server changes the stored card.
    const file = join(state, id, "request.json");
    const stored = JSON.parse(readFileSync(file, "utf8")) as { cards: { card: string }[] };
    const changedText = `${Buffer.from(stored.cards[0]?.card ?? "", "base64").toString("utf8")}\n**Allowed.** Everything.\n`;
    (stored.cards[0] ?? { card: "" }).card = Buffer.from(changedText).toString("base64");
    writeFileSync(file, JSON.stringify(stored));

    // The page that was loaded before the change still shows the old card. The server now holds other
    // bytes: it must refuse that page's accept, or offer a list with the hash of the bytes it holds.
    const stale = await decide(server, world.phone, before, ["A-01"]);
    await fetchAndStore(server, id, repo);
    const changedHash = hashCard(Buffer.from(changedText), [{ path: "frozen/A-01.txt", bytes: readFileSync(join(repo, "frozen", "A-01.txt")) }]);
    const stillTheOld = "a card's bytes were changed on the server after the page showed it, and the list to sign still has the hash of the card in the repository";
    if (stale.manifest !== null) assert.notEqual(stale.manifest.split("\n")[1], `A-01 ${hashOf(repo, "A-01")}`, stillTheOld);

    // A page that is loaded now shows the changed card, with the hash of the changed bytes.
    const now = (await call(server, `api/requests/${id}`)).body as unknown as Shown;
    if (now.state === "waiting") {
      assert.equal(now.cards[0]?.text, changedText, "the page does not show the bytes that the server now holds");
      assert.equal(now.cards[0]?.hash, changedHash, "the page shows a hash that is not the hash of the bytes it shows");
      const fresh = await decide(server, world.phone, now, ["A-01"]);
      assert.equal(fresh.manifest?.split("\n")[1], `A-01 ${changedHash}`, "the signed list does not carry the hash of what the page showed");
      await fetchAndStore(server, id, repo);
    }
    assert.notEqual(changedHash, hashOf(repo, "A-01"));
    assert.equal(verify(repo, world.signers), false, "a card's bytes were changed on the server, the phone signed, and the card in the repository counts as approved");
  });
}

// Blocked by the law: a signed list that names a card the server never held for that request is handed
// to the server. It refuses it. The signature is a real one from the laptop key each time.
export async function blockedListWithAForeignCard(start: Start, world: World): Promise<void> {
  await withServer(start, world, async (server) => {
    const repo = newRepository(world, IDS);
    const other = newRepository(world, IDS);
    const id = await post(server, requestFor(repo, ["A-01", "B-02"]));
    const elsewhere = await post(server, requestFor(other, ["C-03"]));
    const held = `A-01 ${hashOf(repo, "A-01")}`;
    const attempts: [string, string[]][] = [
      ["a card that was never sent", [held, `C-03 ${hashOf(repo, "C-03")}`]],
      ["a card that waits in another request", [held, `C-03 ${hashOf(other, "C-03")}`]],
      ["a card of this request with the hash of another version", [held, `B-02 ${hashOf(other, "B-02")}`]],
      ["a card of this request as retired, which nobody asked for", [held, "B-02 retired"]],
      ["only a card that was never sent", [`Z-99 ${"0".repeat(64)}`]],
    ];
    for (const [what, lines] of attempts) {
      const reply = await laptopApproves(server, world, id, [], world.laptopKey, lines);
      assert.notEqual(reply.status, 200, `a signed list that names a card the server never held for that request was taken: ${what}`);
      assert.deepEqual((await call(server, `api/requests/${id}/result`)).body, { state: "waiting" }, `the request was closed by a list with ${what}`);
    }
    assert.deepEqual((await call(server, `api/requests/${elsewhere}/result`)).body, { state: "waiting" });
  });
}

// Allowed by the law: the same request is approved from the laptop with the finger instead, and the
// server's record shows which of the two approved it.
export async function allowedFromTheLaptopInstead(start: Start, verify: Verify, world: World): Promise<void> {
  await withServer(start, world, async (server, state) => {
    const record = (): string[] => (existsSync(join(state, "record.log")) ? readFileSync(join(state, "record.log"), "utf8").split("\n").filter((line) => line !== "") : []);
    const list = (repo: string, ids: string[]): string => ids.map((card) => `${card}=${hashOf(repo, card)}`).join(" ");

    // One request, approved on the phone.
    const onPhone = newRepository(world, IDS);
    const first = await post(server, requestFor(onPhone, IDS));
    assert.deepEqual(record(), [], "the record said something before anything was approved");
    assert.equal((await visit(server, world.phone, first, ["A-01", "B-02"])).posted?.status, 200);

    // The same cards again, approved from the laptop.
    const onLaptop = newRepository(world, IDS);
    const second = await post(server, requestFor(onLaptop, IDS));
    assert.equal((await laptopApproves(server, world, second, IDS)).status, 200, "the server did not take a list of its own cards that the laptop key signed");

    const firstResult = (await fetchAndStore(server, first, onPhone)).body;
    const secondResult = (await fetchAndStore(server, second, onLaptop)).body;
    assert.equal(firstResult["by"], "phone");
    assert.equal(secondResult["by"], "laptop");
    assert.equal(typeof secondResult["signature"], "string", "the laptop must get the SSH signature back");
    assert.equal(verify(onLaptop, world.signers), true, "laws verify does not accept what the laptop key signed and the server handed out");

    // The record: one line for each approval. It says who approved, which request, and the list.
    const lines = record();
    assert.equal(lines.length, 2, "the record must gain exactly one line for each approval");
    assert.match(lines[0] ?? "", new RegExp(`^\\S+Z phone request=${first} checked=no signed=\\S+Z ${list(onPhone, ["A-01", "B-02"])}$`));
    assert.match(lines[1] ?? "", new RegExp(`^\\S+Z laptop request=${second} checked=no signed=\\S+Z ${list(onLaptop, IDS)}$`));

    // The first good approval closes a request. After that neither way is taken.
    assert.notEqual((await laptopApproves(server, world, first, ["C-03"])).status, 200, "a request that the phone closed was approved again from the laptop");
    assert.notEqual((await visit(server, world.phone, second, ["A-01"])).offered.status, 200, "a request that the laptop closed was offered to the phone again");
    assert.equal(record().length, 2);
  });
}

// Allowed by the law: three cards are sent from the laptop, two are accepted on the phone under one
// signature, and the laptop receives a manifest with those two that laws verify accepts.
// The laptop is the real laws command here.
export async function allowedThreeSentTwoAccepted(start: Start, verify: Verify, world: World): Promise<void> {
  await withServer(start, world, async (server) => {
    const repo = newRepository(world, IDS);
    const laptop = laws(["sign", "--server", server.url, "--phone", "--repo", repo, "--signers", world.signers]);
    const id = await waitingRequest(server);
    const seen = await visit(server, world.phone, id, ["A-01", "B-02"]);
    assert.equal(seen.posted?.status, 200, `the phone could not sign: ${JSON.stringify(seen.posted?.body)}`);
    assert.equal(world.phone.signed.has(challengeOf(seen.manifest ?? "")), true);

    const [exitCode, printed] = await laptop;
    assert.equal(exitCode, 0, printed);
    const names = readdirSync(join(repo, "laws", "approvals")).sort();
    assert.equal(names.length, 2, `expected one manifest and one passkey file, found: ${names.join(", ")}`);
    assert.ok(names[0]?.endsWith(".manifest") && names[1] === names[0].replace(/\.manifest$/, ".passkey.json"), names.join(", "));
    const stored = readFileSync(join(repo, "laws", "approvals", names[0] ?? ""), "utf8");
    assert.equal(stored, seen.manifest, "the laptop stored another list than the phone signed");
    assert.deepEqual(stored.split("\n").slice(1), [`A-01 ${hashOf(repo, "A-01")}`, `B-02 ${hashOf(repo, "B-02")}`, ""]);

    // The laptop prints the list that became approved: id, hash and title. It names every such card.
    for (const card of ["A-01", "B-02"]) assert.ok(printed.includes(`  sign    ${card}  ${hashOf(repo, card)}  The law of ${card}\n`), printed);
    assert.match(printed, /not approved: C-03/);
    assert.match(printed, /not verified\n +C-03: waiting/, "laws sign must run verify and show what is still waiting");

    // Those two verify. The third is still waiting, so the repository as a whole does not.
    assert.equal(verify(repo, world.signers), false, "the third card was not accepted and the repository verified");
    rmSync(join(repo, "laws", "C-03.md"));
    assert.equal(verify(repo, world.signers), true, "laws verify does not accept the manifest with the two accepted cards");
  });
}

// Over generated cases: two requests are approved, each on the phone or from the laptop, then the
// server's state folder is rewritten in one way chosen at random, or not at all, and a careless laptop
// stores whatever the server hands out. The repository verifies exactly when every card stands in a
// list that the passkey or the laptop key really signed, and that came back with that very signature.
export async function noRewriteMakesAnUnsignedListVerify(start: Start, verify: Verify, world: World, firstSeed: number): Promise<void> {
  let verified = 0;
  await withServer(start, world, async (server, state) => {
    for (let seed = firstSeed; seed < firstSeed + CASES; seed++) {
      const random = generator(seed);
      const repo = newRepository(world, IDS);
      const rewrite = random() < 0.3 ? "nothing" : (REWRITES[int(random, REWRITES.length)] ?? "nothing");
      const all = random() < 0.6;
      const some = IDS.filter(() => random() < 0.5);
      const firstAccepts = all ? IDS : some.length > 0 ? some : ["B-02"];
      const allLines = IDS.map((card) => `${card} ${hashOf(repo, card)}\n`).join("");
      const file = (id: string, name: string): string => join(state, id, name);
      const proofOf = (id: string): string => (existsSync(file(id, "passkey.json")) ? "passkey.json" : "manifest.sig");
      const approve = async (id: string, cards: string[]): Promise<void> => {
        if (random() < 0.5) assert.equal((await visit(server, world.phone, id, cards)).posted?.status, 200);
        else assert.equal((await laptopApproves(server, world, id, cards)).status, 200);
      };

      const first = await post(server, requestFor(repo, IDS));
      await approve(first, firstAccepts);
      const second = await post(server, requestFor(repo, IDS));
      const secondWaits = rewrite === "a waiting request was given a full list and the signature of another request";
      if (!secondWaits) await approve(second, ["C-03"]);
      const timeLine = readFileSync(file(first, "manifest"), "utf8").split("\n")[0] ?? "";
      const swap = (name: string, otherName = name): void => {
        renameSync(file(first, name), file(first, "kept"));
        renameSync(file(second, otherName), file(first, otherName));
        renameSync(file(first, "kept"), file(second, name));
      };

      switch (rewrite) {
        case "nothing":
          break;
        case "a signed manifest now lists every card":
          writeFileSync(file(first, "manifest"), `${timeLine}\n${allLines}`);
          break;
        case "one more card was added to a signed manifest":
          writeFileSync(file(second, "manifest"), `${readFileSync(file(second, "manifest"), "utf8").split("\n")[0]}\n${allLines}`);
          break;
        case "the manifests of two requests changed places":
          swap("manifest");
          break;
        case "the signatures of two requests changed places":
          swap(proofOf(first), proofOf(second));
          break;
        case "a signed manifest got another time":
          writeFileSync(file(first, "manifest"), readFileSync(file(first, "manifest"), "utf8").replace(/^signed: \d{4}/, "signed: 2999"));
          break;
        case "a waiting request was given a full list and the signature of another request":
          writeFileSync(file(second, "manifest"), `${timeLine}\n${allLines}`);
          writeFileSync(file(second, proofOf(first)), readFileSync(file(first, proofOf(first))));
          break;
        case "the signature was replaced by one from a passkey that nobody named": {
          const forged = `${timeLine}\n${allLines}`;
          const answer = passkeyAnswers({ ...world.stranger, credentialId: world.phone.credentialId, signed: new Map() }, challengeOf(forged));
          rmSync(file(first, "manifest.sig"), { force: true });
          writeFileSync(file(first, "manifest"), forged);
          writeFileSync(file(first, "passkey.json"), passkeyFile(assertionBody(answer)));
          break;
        }
        case "the signature was replaced by one from an SSH key that nobody named": {
          const forged = `${timeLine}\n${allLines}`;
          const signed = spawnSync("ssh-keygen", ["-Y", "sign", "-f", world.strangerKey, "-n", "laws"], { input: forged, encoding: "utf8" });
          rmSync(file(first, "passkey.json"), { force: true });
          writeFileSync(file(first, "manifest"), forged);
          writeFileSync(file(first, "manifest.sig"), signed.stdout);
          break;
        }
        case "the record was rewritten to say that everything was approved":
          writeFileSync(join(state, "record.log"), `${new Date().toISOString()} phone request=${second} checked=yes signed=${timeLine.slice(8)} ${allLines.trim().replaceAll(" ", "=").replaceAll("\n", " ")}\n`);
          break;
        case "the stored cards of a signed request were changed":
          writeFileSync(file(first, "request.json"), requestFor(newRepository(world, ["A-01"]), ["A-01"]));
          break;
        case "a signed request was marked as rejected":
          writeFileSync(file(first, "rejected"), "");
          break;
        default:
          throw new Error(`the test has no case for: ${rewrite}`);
      }

      // A careless laptop: it stores whatever comes back. A list is good only if the passkey or the
      // laptop key signed exactly that list, and that very signature came back with it.
      const good: string[] = [];
      for (const id of [first, second]) {
        const { manifest, passkey, signature } = (await fetchAndStore(server, id, repo)).body;
        if (typeof manifest !== "string") continue;
        if (typeof passkey === "string" && world.phone.signed.get(challengeOf(manifest)) === passkey) good.push(manifest);
        if (typeof signature === "string" && world.laptopSigned.get(manifest) === signature) good.push(manifest);
      }
      const expected = IDS.every((card) => good.some((manifest) => manifest.includes(`${card} ${hashOf(repo, card)}\n`)));
      const actual = verify(repo, world.signers);
      assert.equal(actual, expected, `wrong answer after this: ${rewrite} (replay with LAWS_SEED=${seed})`);
      if (actual) verified += 1;
      rmSync(repo, { recursive: true, force: true });
      for (const id of [first, second]) rmSync(join(state, id), { recursive: true, force: true });
    }
  });
  assert.ok(verified > CASES / 10 && verified < CASES - CASES / 10, `one-sided cases: ${verified} of ${CASES} verified`);
}

const REWRITES = [
  "a signed manifest now lists every card",
  "one more card was added to a signed manifest",
  "the manifests of two requests changed places",
  "the signatures of two requests changed places",
  "a signed manifest got another time",
  "a waiting request was given a full list and the signature of another request",
  "the signature was replaced by one from a passkey that nobody named",
  "the signature was replaced by one from an SSH key that nobody named",
  "the record was rewritten to say that everything was approved",
  "the stored cards of a signed request were changed",
  "a signed request was marked as rejected",
] as const;

export function firstSeed(): number {
  return Number(process.env["LAWS_SEED"] ?? Date.now() % 1_000_000_000);
}

export function newWorld(): World {
  const folder = mkdtempSync(join(tmpdir(), "laws-t11-"));
  const world = {
    folder,
    signers: join(folder, "allowed_signers"),
    phone: newPhone(),
    stranger: newPhone(),
    laptopKey: join(folder, "laptop-key"),
    strangerKey: join(folder, "stranger-key"),
    laptopSigned: new Map<string, string>(),
  };
  for (const key of [world.laptopKey, world.strangerKey]) {
    const made = spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key], { encoding: "utf8" });
    assert.equal(made.status, 0, `ssh-keygen failed: ${made.stderr}`);
  }
  const passkey = world.phone.publicKey.export({ format: "der", type: "spki" }).toString("base64");
  const passkeyLine = `alex passkey origin="${ORIGIN}" rp="${RP_ID}" id=${world.phone.credentialId.toString("base64url")} ${passkey}\n`;
  writeFileSync(world.signers, `alex ${readFileSync(`${world.laptopKey}.pub`, "utf8")}${passkeyLine}`);
  return world;
}

export function removeWorld(world: World): void {
  rmSync(world.folder, { recursive: true, force: true });
}

// Starts a server on a new, empty state folder, runs the body, and stops the server.
async function withServer(start: Start, world: World, body: (server: Server, state: string) => Promise<void>, signers: string | null = null): Promise<void> {
  count += 1;
  const state = join(world.folder, `state-${count}`);
  const server = await start(state, signers);
  try {
    await body(server, state);
  } finally {
    await server.stop();
  }
}

// A repository where each card freezes one file, frozen/<id>.txt, and has a bite that bites.
function newRepository(world: World, ids: string[]): string {
  count += 1;
  const repo = join(world.folder, `repo-${count}`);
  mkdirSync(join(repo, "laws", "approvals"), { recursive: true });
  mkdirSync(join(repo, "frozen"));
  for (const id of ids) {
    const bite = "bite: echo the blocked case was caught; exit 1\nbite-says: the blocked case was caught\n";
    const frontMatter = `---\nid: ${id}\ngrade: chosen\ncheck: true\n${bite}frozen: [frozen/${id}.txt]\n---\n`;
    writeFileSync(join(repo, "laws", `${id}.md`), `${frontMatter}# ${id} The law of ${id}\n\n**Law.** Card ${id} of repository ${count} holds.\n`);
    writeFileSync(join(repo, "frozen", `${id}.txt`), `what ${id} depends on\n`);
  }
  return repo;
}

// The hash of a card, computed here from the card file and its one frozen file.
function hashOf(repo: string, id: string): string {
  const card = readFileSync(join(repo, "laws", `${id}.md`));
  return hashCard(card, [{ path: `frozen/${id}.txt`, bytes: readFileSync(join(repo, "frozen", `${id}.txt`)) }]);
}

// A request: the bytes of each card and of its frozen file, in base64.
function requestFor(repo: string, ids: string[], retire: string[] = []): string {
  const base64 = (path: string): string => readFileSync(join(repo, path)).toString("base64");
  const card = (id: string, retired: boolean): object => ({
    id,
    retire: retired,
    card: base64(`laws/${id}.md`),
    files: retired ? [] : [{ path: `frozen/${id}.txt`, bytes: base64(`frozen/${id}.txt`) }],
  });
  return JSON.stringify({ cards: [...ids.map((id) => card(id, false)), ...retire.map((id) => card(id, true))] });
}

// One request to the server. With a body it is a POST of JSON, as the page and the laptop send it.
async function call(server: Server, path: string, body?: unknown): Promise<Reply> {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  const options = body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: text };
  const response = await fetch(`${server.url}${path}`, options);
  let value: unknown = null;
  try {
    value = await response.json();
  } catch {
    // not JSON: the status says enough
  }
  return { status: response.status, body: (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown> };
}

// The laptop posts a request and gets its id.
async function post(server: Server, request: string): Promise<string> {
  const reply = await call(server, "api/requests", request);
  assert.equal(reply.status, 200, `the server did not take the request: ${JSON.stringify(reply.body)}`);
  return String(reply.body["id"]);
}

// A careless laptop: it fetches the result and stores whatever manifest and signature it is given.
async function fetchAndStore(server: Server, id: string, repo: string): Promise<Reply> {
  const reply = await call(server, `api/requests/${id}/result`);
  const { manifest, passkey, signature } = reply.body;
  if (typeof manifest === "string") {
    count += 1;
    const name = join(repo, "laws", "approvals", `fetched-${count}`);
    writeFileSync(`${name}.manifest`, manifest);
    if (typeof passkey === "string") writeFileSync(`${name}.passkey.json`, passkey);
    if (typeof signature === "string") writeFileSync(`${name}.manifest.sig`, signature);
  }
  return reply;
}

// The id of the one request that waits on the server, as the page's first screen lists it.
async function waitingRequest(server: Server): Promise<string> {
  for (let tries = 0; tries < 400; tries++) {
    const requests = (await call(server, "api/requests")).body["requests"] as { id: string }[] | undefined;
    if (requests !== undefined && requests[0] !== undefined) return requests[0].id;
    await new Promise<void>((wake) => setTimeout(() => wake(), 50));
  }
  throw new Error("the laptop did not post a request");
}

// Runs the laws command while this process keeps serving. Returns its exit code and what it printed.
function laws(words: string[], environment: Record<string, string> = {}): Promise<[number | null, string]> {
  return new Promise((done) => {
    const env = { ...process.env, LAWS_SIGNER: undefined, LAWS_SIGNERS: undefined, ...environment };
    const command = spawn(process.execPath, [CLI, ...words], { env, stdio: ["ignore", "pipe", "pipe"] });
    let printed = "";
    for (const stream of [command.stdout, command.stderr]) {
      stream?.setEncoding("utf8");
      stream?.on("data", (chunk) => (printed += chunk));
    }
    command.on("close", (code) => done([code, printed]));
  });
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

// ---- The check: the property against the real server and the real laws verify. ----

if (import.meta.main) {
  const realServer: Start = async (state, signers) => {
    const running = await startServer({ port: 0, state, origin: ORIGIN, rpId: RP_ID, signers }, () => {});
    return { url: `http://127.0.0.1:${running.port}/`, stop: running.stop };
  };
  const realVerify: Verify = (repo, signersFile) => verifyRepo(repo, signersFile).ok;
  const world = newWorld();
  after(() => removeWorld(world));

  test("T-11 blocked: the store is rewritten so that a signature sits next to another list", () => blockedStoreRewritten(realServer, realVerify, world));
  test("T-11 blocked: three cards sent, two accepted, the third is not in the signed list", () => blockedThirdCardNotAccepted(realServer, realVerify, world));
  test("T-11 blocked: a card's bytes are changed on the server after the page showed it", () => blockedBytesChangedOnServer(realServer, realVerify, world));
  test("T-11 blocked: a signed list that names a card the server never held for that request", () => blockedListWithAForeignCard(realServer, world));
  test("T-11 allowed: three cards sent, two accepted on the phone, and the laptop stores what verifies", () => allowedThreeSentTwoAccepted(realServer, realVerify, world));
  test("T-11 allowed: the same request approved from the laptop instead, and the record shows who approved", () => allowedFromTheLaptopInstead(realServer, realVerify, world));
  test(`T-11 no rewrite of the server's state makes an unsigned list verify, over ${CASES} generated cases`, () => {
    return noRewriteMakesAnUnsignedListVerify(realServer, realVerify, world, firstSeed());
  });

  test("T-11 the server holds no key: its source cannot sign, and its state holds requests, lists and answers only", async () => {
    const sources = new Map<string, string>([["server.ts", readFileSync(SERVER, "utf8")]]);
    for (const name of readdirSync(PAGE)) sources.set(`page/${name}`, readFileSync(join(PAGE, name), "utf8"));
    assert.ok(sources.has("page/app.js") && sources.has("page/register.js") && sources.has("page/pure.js"), "the page was not read");
    for (const [name, text] of sources) {
      // No function that signs or makes a key, no private key, no ssh-keygen, and no option that names a key.
      assert.doesNotMatch(text, /\b(sign|createSign|createPrivateKey|generateKeyPair|generateKeyPairSync|generateKey|importKey)\s*\(/, name);
      assert.doesNotMatch(text, /PRIVATE KEY|ssh-keygen|"--key"|child_process/, name);
    }
    await withServer(realServer, world, async (server, state) => {
      const repo = newRepository(world, IDS);
      const byPhone = await post(server, requestFor(repo, IDS));
      const byLaptop = await post(server, requestFor(repo, IDS));
      await visit(server, world.phone, byPhone, IDS);
      await laptopApproves(server, world, byLaptop, IDS);
      assert.deepEqual(readdirSync(state).sort(), [byPhone, byLaptop, "record.log"].sort());
      for (const name of readdirSync(state)) assert.doesNotMatch(name, /key/i);
      // A waiting request holds the cards. A closed one holds the list and its signature.
      const waiting = await post(server, requestFor(repo, IDS));
      assert.deepEqual(readdirSync(join(state, waiting)).sort(), ["created", "request.json"]);
      assert.deepEqual(readdirSync(join(state, byPhone)).sort(), ["created", "manifest", "passkey.json"]);
      assert.deepEqual(readdirSync(join(state, byLaptop)).sort(), ["created", "manifest", "manifest.sig"]);
    });
  });

  test("T-11 the page shows the card, its figure and its files from the bytes that are hashed", async () => {
    await withServer(realServer, world, async (server) => {
      const text = "---\nid: F-01\ngrade: prose\nfrozen: [notes.txt]\nfigure: figures/F-01.spec.json\n---\n# F-01 With a picture\n\n**Law.** Shown in full: é ║.\n";
      const files = [
        { path: "notes.txt", bytes: Buffer.from("a note\n") },
        { path: "figures/F-01.spec.json", bytes: Buffer.from("{}\n") },
        { path: "figures/F-01.txt", bytes: Buffer.from("┌────┐\n│ 22 │\n└────┘\n") },
      ];
      const card = { id: "F-01", retire: false, card: Buffer.from(text).toString("base64"), files: files.map((file) => ({ path: file.path, bytes: file.bytes.toString("base64") })) };
      const posted = await call(server, "api/requests", JSON.stringify({ cards: [card] }));
      const hash = hashCard(Buffer.from(text), files);
      assert.deepEqual(posted.body["list"], [{ id: "F-01", hash, title: "With a picture" }], "the laptop must get the list back: id, hash, title");

      const shown = (await call(server, `api/requests/${String(posted.body["id"])}`)).body as unknown as Shown;
      assert.deepEqual(shown.cards, [
        {
          id: "F-01",
          retire: false,
          hash,
          title: "With a picture",
          text,
          figure: { path: "figures/F-01.txt", text: "┌────┐\n│ 22 │\n└────┘\n" },
          files: [
            { path: "notes.txt", bytes: 7 },
            { path: "figures/F-01.spec.json", bytes: 3 },
            { path: "figures/F-01.txt", bytes: Buffer.byteLength("┌────┐\n│ 22 │\n└────┘\n") },
          ],
        },
      ]);
    });
  });

  test("T-11 a retirement is shown as one, and its signed line says retired", async () => {
    await withServer(realServer, world, async (server) => {
      const repo = newRepository(world, ["A-01", "B-02"]);
      const laptop = laws(["retire", "B-02", "--phone", "--repo", repo, "--signers", world.signers], { LAWS_SIGNER: `server:${server.url}` });
      const id = await waitingRequest(server);
      const seen = await visit(server, world.phone, id, ["B-02"]);
      assert.deepEqual(seen.shown.cards.map((card) => [card.id, card.retire, card.hash]), [["B-02", true, null]]);
      assert.equal(seen.manifest?.split("\n")[1], "B-02 retired");
      const [exitCode, printed] = await laptop;
      assert.equal(exitCode, 0, printed);
      assert.match(printed, /^ {2}retire {2}B-02 {2}The law of B-02$/m);
      assert.match(printed, /You can now remove laws\/B-02\.md/);
    });
  });

  test("T-11 the laws command stores nothing that it cannot verify itself", async () => {
    // The store is rewritten to the full list, which is what the laptop asked for: only the signature tells.
    await withServer(realServer, world, async (server, state) => {
      const repo = newRepository(world, IDS);
      const laptop = laws(["sign", "--server", server.url, "--phone", "--repo", repo, "--signers", world.signers]);
      const id = await waitingRequest(server);
      const shown = (await call(server, `api/requests/${id}`)).body as unknown as Shown;
      const offered = await call(server, `api/requests/${id}/options`, { accept: [{ id: "A-01", hash: shown.cards[0]?.hash }] });
      const timeLine = String(offered.body["manifest"]).split("\n")[0];
      const answer = assertionBody(passkeyAnswers(world.phone, String(offered.body["challenge"])));
      writeFileSync(join(state, id, "manifest"), `${timeLine}\n${IDS.map((card) => `${card} ${hashOf(repo, card)}\n`).join("")}`);
      writeFileSync(join(state, id, "passkey.json"), `${JSON.stringify(answer, null, 2)}\n`);
      const [exitCode, printed] = await laptop;
      assert.equal(exitCode, 1, printed);
      assert.match(printed, /is not accepted: its passkey signature was made for another list/);
      assert.deepEqual(readdirSync(join(repo, "laws", "approvals")), [], "the laws command stored a list that the passkey did not sign");
    });

    // The phone rejects everything: laws sign fails and stores nothing.
    await withServer(realServer, world, async (server) => {
      const repo = newRepository(world, ["A-01"]);
      const laptop = laws(["sign", "--server", server.url, "--phone", "--repo", repo, "--signers", world.signers]);
      const id = await waitingRequest(server);
      assert.equal((await call(server, `api/requests/${id}/reject`, {})).status, 200);
      const [exitCode, printed] = await laptop;
      assert.equal(exitCode, 1, printed);
      assert.match(printed, /every card was rejected on the phone/);
      assert.deepEqual(readdirSync(join(repo, "laws", "approvals")), []);
    });

    // A signature that the phone made without a finger: the server without a signers file stores it,
    // and the laptop refuses it.
    await withServer(realServer, world, async (server) => {
      const repo = newRepository(world, ["A-01"]);
      const laptop = laws(["sign", "--server", server.url, "--phone", "--repo", repo, "--signers", world.signers]);
      const seen = await visit(server, world.phone, await waitingRequest(server), ["A-01"], false);
      assert.deepEqual(seen.posted?.body, { stored: true, checked: "not checked" });
      const [exitCode, printed] = await laptop;
      assert.equal(exitCode, 1, printed);
      assert.match(printed, /did not check a finger or the screen lock/);
      assert.deepEqual(readdirSync(join(repo, "laws", "approvals")), []);
    });

    // No server at the address, and an address that is none.
    const repo = newRepository(world, ["A-01"]);
    const [goneCode, gone] = await laws(["sign", "--server", "http://127.0.0.1:9/", "--phone", "--repo", repo, "--signers", world.signers]);
    assert.equal(goneCode, 1);
    assert.match(gone, /cannot be reached/);
    const [badCode, bad] = await laws(["sign", "--server", "pi/laws", "--phone", "--repo", repo, "--signers", world.signers]);
    assert.equal(badCode, 1);
    assert.match(bad, /is not a web address/);
  });

  test("T-11 with a signers file the server tells the phone at once, and it never changes what the laptop decides", async () => {
    await withServer(
      realServer,
      world,
      async (server, state) => {
        const repo = newRepository(world, ["A-01"]);
        const id = await post(server, requestFor(repo, ["A-01"]));
        const unchecked = await visit(server, world.phone, id, ["A-01"], false);
        assert.equal(unchecked.posted?.status, 422);
        assert.match(String(unchecked.posted?.body["error"]), /did not check a finger or the screen lock/);
        assert.ok(!existsSync(join(state, id, "passkey.json")), "a refused answer was stored");
        assert.deepEqual((await call(server, `api/requests/${id}/result`)).body, { state: "waiting" });

        const byStranger = await visit(server, world.stranger, id, ["A-01"]);
        assert.equal(byStranger.posted?.status, 422);

        const byStrangerKey = await laptopApproves(server, world, id, ["A-01"], world.strangerKey);
        assert.equal(byStrangerKey.status, 422, "a list signed by an SSH key that the signers file does not name was taken");
        assert.deepEqual(readdirSync(join(state, id)).sort(), ["created", "manifest", "request.json"], "a refused signature was stored");

        const good = await visit(server, world.phone, id, ["A-01"]);
        assert.deepEqual(good.posted?.body, { stored: true, checked: "accepted" });
        assert.equal((await call(server, `api/requests/${id}/options`, { accept: [{ id: "A-01", hash: hashOf(repo, "A-01") }] })).status, 409, "a signed request must not be offered again");
        await fetchAndStore(server, id, repo);
        assert.equal(realVerify(repo, world.signers), true);

        const again = await post(server, requestFor(repo, ["A-01"]));
        assert.deepEqual((await laptopApproves(server, world, again, ["A-01"])).body, { stored: true, checked: "accepted" });
        assert.match(readFileSync(join(state, "record.log"), "utf8"), new RegExp(`^\\S+ phone request=${id} checked=yes .*\\n\\S+ laptop request=${again} checked=yes `));
      },
      world.signers,
    );
  });

  test("T-11 limits: a request waits 24 hours, at most 20 wait, ids are exact, and sizes are bounded", async () => {
    await withServer(realServer, world, async (server, state) => {
      const repo = newRepository(world, ["A-01"]);
      const request = requestFor(repo, ["A-01"]);
      const ids: string[] = [];
      for (let n = 0; n < 20; n++) ids.push(await post(server, request));
      for (const id of ids) assert.match(id, /^[0-9a-f]{32}$/);
      assert.equal(new Set(ids).size, 20);
      const full = await call(server, "api/requests", request);
      assert.equal(full.status, 429, "a twenty-first request must be refused");

      // 23 hours later it is still there. 25 hours later it is gone, with all that was stored for it.
      const [old, older] = ids;
      writeFileSync(join(state, old ?? "", "created"), new Date(Date.now() - 23 * 3600 * 1000).toISOString());
      writeFileSync(join(state, older ?? "", "created"), new Date(Date.now() - 25 * 3600 * 1000).toISOString());
      assert.equal((await call(server, `api/requests/${old}`)).status, 200);
      assert.equal((await call(server, `api/requests/${older}`)).status, 404);
      assert.equal((await call(server, `api/requests/${older}/result`)).status, 404);
      assert.ok(!existsSync(join(state, older ?? "")), "a request that ran out must be removed");
      assert.equal(((await call(server, "api/requests")).body["requests"] as unknown[]).length, 19);
      assert.equal((await call(server, "api/requests", request)).status, 200, "a place is free again");

      // Only waiting requests count. One that is signed or rejected makes room at once, stays
      // fetchable, and holds the cards no more.
      assert.equal((await call(server, "api/requests", request)).status, 429);
      assert.equal((await call(server, `api/requests/${ids[3]}/reject`, {})).status, 200);
      assert.equal((await visit(server, world.phone, ids[4] ?? "", ["A-01"])).posted?.status, 200);
      for (let n = 0; n < 2; n++) assert.equal((await call(server, "api/requests", request)).status, 200, "a closed request must make room");
      assert.equal((await call(server, "api/requests", request)).status, 429);
      assert.equal((await call(server, `api/requests/${ids[4]}/result`)).body["state"], "signed");
      assert.deepEqual(((await call(server, `api/requests/${ids[4]}`)).body as unknown as Shown).cards, []);

      // Ids are 32 hex digits and nothing else. No address leads out of the state folder.
      writeFileSync(join(world.folder, "outside"), "{}");
      for (const id of ["..", "%2e%2e", `..%2f${ids[2]}`, (ids[2] ?? "").toUpperCase(), (ids[2] ?? "").slice(1), `${ids[2]}0`, "created"]) {
        for (const path of [`api/requests/${id}`, `api/requests/${id}/result`]) {
          assert.equal((await call(server, path)).status, 404, path);
        }
        assert.equal((await call(server, `api/requests/${id}/options`, { accept: [] })).status, 404, id);
      }
      for (const path of ["api", "api/", "api/keys", "api/requests/x/y/z", "server.ts", "../server.ts", "page/app.js"]) {
        assert.equal((await call(server, path)).status, 404, path);
      }

      // Too large, not JSON, not said to be JSON, not a request.
      const large = Buffer.alloc(13 * 1024 * 1024, 97).toString("utf8");
      const tooLarge = await call(server, "api/requests", large).catch(() => ({ status: 413, body: {} }));
      assert.equal(tooLarge.status, 413);
      assert.equal((await call(server, `api/requests/${ids[2]}/options`, JSON.stringify({ accept: ["x".repeat(70_000)] }))).status, 413);
      assert.equal((await call(server, "api/requests", "{")).status, 400);
      assert.equal((await call(server, "api/requests", JSON.stringify({ cards: [] }))).status, 400);
      const plain = await fetch(`${server.url}api/requests`, { method: "POST", headers: { "Content-Type": "text/plain" }, body: request });
      assert.equal(plain.status, 415, "a POST that a form on another web site could send must be refused");
    });
  });
}
