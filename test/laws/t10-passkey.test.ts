// The check of law T-10 (laws/T-10.md): a phone approval is a passkey signature over the exact list.
// This file and its bite are frozen with the card, so everything the check means is written here.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { loadCards } from "../../src/cards.ts";
import { verifyRepo } from "../../src/verify.ts";

// What is under test: does this repository verify against this signers file?
export type Verify = (repo: string, signersFile: string) => boolean;

// A software passkey. It does with a key in memory what a phone does with the key in its chip.
export type Phone = { name: string; origin: string; rpId: string; credentialId: Buffer; privateKey: KeyObject; publicKey: KeyObject };

// How one signature is made. Left out means: the way an honest phone does it at the right address.
export type Touch = {
  verified?: boolean; // the phone checked a finger or the screen lock
  present?: boolean; // somebody touched the phone
  origin?: string; // the web address of the page that asked
  rpId?: string; // the site the phone believes the passkey belongs to
  type?: string; // "webauthn.get" asks for a signature
  crossOrigin?: boolean; // the page sat in a frame of another site
  credentialId?: Buffer;
  counterBytes?: number; // an honest phone writes 4
};

// The four parts of a passkey answer, as the browser hands them to the page.
export type Answer = { credentialId: Buffer; authenticatorData: Buffer; clientDataJSON: Buffer; signature: Buffer };

// A temporary folder. The signers file names the laptop key and the phone's passkey. The other phone
// and the stranger's key are named nowhere.
export type World = { folder: string; signers: string; phone: Phone; otherPhone: Phone; laptopKey: string; strangerKey: string };

const CASES = 200;
const CLI = join(import.meta.dirname, "../../src/cli.ts");
const ORIGIN = "https://laws.example.test";
const RP_ID = "laws.example.test";
const IDS = ["A-01", "B-02", "C-03"];
let repositoryCount = 0;
let batchCount = 0;
let clock = Date.UTC(2026, 0, 1);

// ---- The software passkey. ----

export function newPhone(): Phone {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return { name: "alex", origin: ORIGIN, rpId: RP_ID, credentialId: randomBytes(16), privateKey, publicKey };
}

// What the phone and its browser do when a page asks for a signature over this challenge:
// the browser writes clientDataJSON, the phone writes authenticatorData (the hash of the site name, one
// byte of flags, a counter), and the key signs authenticatorData followed by sha256(clientDataJSON).
export function phoneSigns(phone: Phone, challenge: string, how: Touch = {}): Answer {
  const client = { type: how.type ?? "webauthn.get", challenge, origin: how.origin ?? phone.origin, crossOrigin: how.crossOrigin ?? false };
  const clientDataJSON = Buffer.from(JSON.stringify(client));
  const flags = ((how.present ?? true) ? 0x01 : 0) | ((how.verified ?? true) ? 0x04 : 0);
  const counter = Buffer.alloc(how.counterBytes ?? 4);
  const authenticatorData = Buffer.concat([sha256(how.rpId ?? phone.rpId), Buffer.from([flags]), counter]);
  const signedBytes = Buffer.concat([authenticatorData, sha256(clientDataJSON)]);
  const signature = sign("sha256", signedBytes, { key: phone.privateKey, dsaEncoding: "der" });
  return { credentialId: how.credentialId ?? phone.credentialId, authenticatorData, clientDataJSON, signature };
}

// The challenge that stands for a manifest: base64url(sha256("laws manifest v1\n" + the manifest bytes)).
export function challengeOf(manifest: string): string {
  return createHash("sha256").update("laws manifest v1\n").update(manifest).digest("base64url");
}

// The text of a <name>.passkey.json file.
export function passkeyFile(answer: Answer): string {
  const fields = {
    credentialId: answer.credentialId.toString("base64url"),
    authenticatorData: answer.authenticatorData.toString("base64url"),
    clientDataJSON: answer.clientDataJSON.toString("base64url"),
    signature: answer.signature.toString("base64url"),
  };
  return `${JSON.stringify(fields, null, 2)}\n`;
}

// The line of the signers file that names this passkey.
export function signersLine(phone: Phone, origin = phone.origin, rpId = phone.rpId): string {
  const key = phone.publicKey.export({ format: "der", type: "spki" }).toString("base64");
  return `${phone.name} passkey origin="${origin}" rp="${rpId}" id=${phone.credentialId.toString("base64url")} ${key}\n`;
}

function sha256(data: string | Uint8Array): Buffer {
  return createHash("sha256").update(data).digest();
}

// ---- The property. The bite runs the same functions against broken ways to verify. ----

// Blocked by the law: a real signature from the right passkey is attached to a manifest in which one
// hash was changed.
export function blockedSignatureForAnotherList(verify: Verify, world: World): void {
  const repo = newRepository(world, "blocked-another-list", ["A-01", "B-02"]);
  const approval = approveByPhone(repo, ["A-01", "B-02"], world.phone);
  assert.equal(verify(repo, world.signers), true, "two cards freshly approved on the phone must verify");

  // The card changes, and the manifest is rewritten to the new hash under the old signature.
  appendFileSync(join(repo, "laws", "B-02.md"), "One more sentence.\n");
  const signedLine = readFileSync(approval.manifest, "utf8").split("\n")[0];
  writeFileSync(approval.manifest, `${signedLine}\n${linesNow(repo, ["A-01", "B-02"])}`);
  assert.equal(verify(repo, world.signers), false, "a passkey signature made for another list verified");
}

// Blocked by the law: a signature that the phone made without checking a finger or the screen lock.
export function blockedWithoutFingerOrLock(verify: Verify, world: World): void {
  const unchecked = newRepository(world, "blocked-unchecked", ["A-01"]);
  approveByPhone(unchecked, ["A-01"], world.phone, { verified: false });
  assert.equal(verify(unchecked, world.signers), false, "a signature that the phone made without checking a finger or the screen lock verified");

  const nobody = newRepository(world, "blocked-nobody", ["A-01"]);
  approveByPhone(nobody, ["A-01"], world.phone, { present: false });
  assert.equal(verify(nobody, world.signers), false, "a signature that the phone made with nobody there verified");
}

// Blocked by the law: a signature made at another web address.
export function blockedAnotherAddress(verify: Verify, world: World): void {
  for (const origin of ["https://evil.example.test", "https://laws.example.test:8443", "http://laws.example.test", `${ORIGIN}/`]) {
    const repo = newRepository(world, "blocked-address", ["A-01"]);
    approveByPhone(repo, ["A-01"], world.phone, { origin });
    assert.equal(verify(repo, world.signers), false, `a signature made at another web address (${origin}) verified`);
  }
  const framed = newRepository(world, "blocked-frame", ["A-01"]);
  approveByPhone(framed, ["A-01"], world.phone, { crossOrigin: true });
  assert.equal(verify(framed, world.signers), false, "a signature made inside a frame of another site verified");
}

// The site name that the phone itself writes must be the one in the signers file as well.
export function blockedAnotherSite(verify: Verify, world: World): void {
  const repo = newRepository(world, "blocked-site", ["A-01"]);
  approveByPhone(repo, ["A-01"], world.phone, { rpId: "example.test" });
  assert.equal(verify(repo, world.signers), false, "a signature that the phone made for another site verified");
}

// Blocked by the law: a signature from a passkey that the signers file does not list.
export function blockedUnlistedPasskey(verify: Verify, world: World): void {
  const stranger = newRepository(world, "blocked-unlisted", ["A-01"]);
  // The other passkey is added to a file inside the repository. That file must count for nothing.
  writeFileSync(join(stranger, "laws", "allowed_signers"), signersLine(world.otherPhone));
  approveByPhone(stranger, ["A-01"], world.otherPhone);
  assert.equal(verify(stranger, world.signers), false, "a signature from a passkey that the signers file does not list verified");

  const borrowedName = newRepository(world, "blocked-borrowed-id", ["A-01"]);
  approveByPhone(borrowedName, ["A-01"], world.otherPhone, { credentialId: world.phone.credentialId });
  assert.equal(verify(borrowedName, world.signers), false, "another key that used the id of the listed passkey verified");
}

// Allowed by the law: three cards approved in one batch on the phone under one signature.
export function allowedThreeCardsOneSignature(verify: Verify, world: World): void {
  const repo = newRepository(world, "allowed-three", IDS);
  assert.equal(verify(repo, world.signers), false, "cards that nobody approved verified");
  approveByPhone(repo, IDS, world.phone);
  assert.equal(verify(repo, world.signers), true, "three cards under one passkey signature did not verify");
}

// Allowed by the law: a repository where one manifest was signed with the laptop key and another with
// the passkey.
export function allowedLaptopAndPhone(verify: Verify, world: World): void {
  const repo = newRepository(world, "allowed-mixed", ["A-01", "B-02"]);
  approveByLaptop(repo, ["A-01"], world.laptopKey);
  assert.equal(verify(repo, world.signers), false, "one card of two was approved and the repository verified");
  approveByPhone(repo, ["B-02"], world.phone);
  assert.equal(verify(repo, world.signers), true, "one manifest by the laptop key and one by the passkey did not verify");

  // The stranger's SSH key is still a stranger, also now that the signers file has two kinds of lines.
  const other = newRepository(world, "allowed-mixed-stranger", ["A-01", "B-02"]);
  approveByLaptop(other, ["A-01"], world.strangerKey);
  approveByPhone(other, ["B-02"], world.phone);
  assert.equal(verify(other, world.signers), false, "an SSH key that the signers file does not list verified");
}

// A retirement signed on the phone lets the card's file go. One that the passkey did not sign does not.
export function retirementOnThePhone(verify: Verify, world: World): void {
  const repo = newRepository(world, "retire", ["A-01", "B-02"]);
  approveByLaptop(repo, ["A-01", "B-02"], world.laptopKey);
  approveByPhone(repo, [], world.phone, {}, ["B-02"]);
  rmSync(join(repo, "laws", "B-02.md"));
  assert.equal(verify(repo, world.signers), true, "a card was retired on the phone and removed, and the repository did not verify");

  const forged = newRepository(world, "retire-forged", ["A-01", "B-02"]);
  approveByLaptop(forged, ["A-01", "B-02"], world.laptopKey);
  approveByPhone(forged, [], world.phone, { verified: false }, ["B-02"]);
  rmSync(join(forged, "laws", "B-02.md"));
  assert.equal(verify(forged, world.signers), false, "a retirement that the phone signed without a finger let a card go");
}

// The passkey file has one spelling. Every other way to write the same answer is refused.
export function refusesSloppyFiles(verify: Verify, world: World): void {
  const repo = newRepository(world, "sloppy", ["A-01"]);
  const approval = approveByPhone(repo, ["A-01"], world.phone);
  const good = readFileSync(approval.passkey, "utf8");
  assert.equal(verify(repo, world.signers), true, "a card freshly approved on the phone must verify");
  for (const sloppy of sloppySpellings(good)) {
    writeFileSync(approval.passkey, sloppy);
    assert.equal(verify(repo, world.signers), false, `a sloppy passkey file verified: ${JSON.stringify(sloppy.slice(0, 300))}`);
  }
}

// Over generated cases: every card is listed at its current hash in a manifest with a passkey file, so
// only the passkey test stands between the case and "verified". One thing about the approval is wrong,
// chosen at random, or nothing is. The repository verifies exactly when nothing is wrong.
export function onlyUntouchedPhoneApprovalsCount(verify: Verify, world: World, firstSeed: number): void {
  let verified = 0;
  for (let seed = firstSeed; seed < firstSeed + CASES; seed++) {
    const random = generator(seed);
    const ids = IDS.slice(0, 1 + int(random, 3));
    const repo = newRepository(world, `case-${seed}`, ids);
    const wrong = random() < 0.3 ? "nothing" : (WRONG[int(random, WRONG.length)] ?? "nothing");
    const signers = makeCase(world, repo, ids, wrong, random, seed);

    const actual = verify(repo, signers);
    assert.equal(actual, wrong === "nothing", `wrong answer when this is wrong: ${wrong} (replay with LAWS_SEED=${seed})`);
    if (actual) verified += 1;
    rmSync(repo, { recursive: true, force: true });
  }
  assert.ok(verified > CASES / 10 && verified < CASES - CASES / 10, `one-sided cases: ${verified} of ${CASES} verified`);
}

const WRONG = [
  "the manifest got another time after it was signed",
  "a card changed and the manifest was rewritten to its new hash",
  "the signature was made for another list of cards",
  "the signature was made over the manifest's hash without the laws prefix",
  "the phone checked no finger and no screen lock",
  "nobody was at the phone",
  "the flags byte is random and lacks the finger check",
  "the signature was made at another web address",
  "the signature was made in a frame of another site",
  "the phone signed for another site",
  "the answer is that of a new passkey, not of a signature",
  "another key used the listed passkey's id",
  "the passkey is not in the signers file",
  "one bit of the passkey file's content was flipped",
  "the passkey file is written sloppily",
  "the phone's part is too short",
  "the signers file names another web address for the passkey",
  "the signers file names another site for the passkey",
  "the signers file names another key for the passkey",
] as const;

// Builds one generated case in the repository and returns the signers file to verify it with.
function makeCase(world: World, repo: string, ids: string[], wrong: string, random: () => number, seed: number): string {
  const { phone, otherPhone } = world;
  batchCount += 1;
  clock += 1000 + int(random, 100_000);
  const time = new Date(clock).toISOString();
  const name = `batch-${batchCount}`;
  const manifestNow = (): string => `signed: ${time}\n${linesNow(repo, ids)}`;
  const store = (manifest: string, passkey: string): void => {
    writeFileSync(join(repo, "laws", "approvals", `${name}.manifest`), manifest);
    writeFileSync(join(repo, "laws", "approvals", `${name}.passkey.json`), passkey);
  };
  const storeAnswer = (how: Touch, by: Phone = phone): void => {
    store(manifestNow(), passkeyFile(phoneSigns(by, challengeOf(manifestNow()), how)));
  };
  const ownSigners = (text: string): string => {
    const file = join(world.folder, `signers-${seed}`);
    writeFileSync(file, text);
    return file;
  };

  switch (wrong) {
    case "nothing":
      storeAnswer({});
      break;
    case "the manifest got another time after it was signed": {
      const answer = phoneSigns(phone, challengeOf(manifestNow()));
      store(manifestNow().replace(time, new Date(clock + 1).toISOString()), passkeyFile(answer));
      break;
    }
    case "a card changed and the manifest was rewritten to its new hash": {
      const answer = phoneSigns(phone, challengeOf(manifestNow()));
      const id = ids[int(random, ids.length)] ?? "A-01";
      appendFileSync(random() < 0.5 ? join(repo, "laws", `${id}.md`) : join(repo, "frozen", `${id}.txt`), "x");
      store(manifestNow(), passkeyFile(answer));
      break;
    }
    case "the signature was made for another list of cards": {
      // The same time, and one card less. With a single card: a list that names some other card.
      const fewer = ids.length > 1 ? linesNow(repo, ids.slice(1)) : `Z-99 ${"0".repeat(64)}\n`;
      store(manifestNow(), passkeyFile(phoneSigns(phone, challengeOf(`signed: ${time}\n${fewer}`))));
      break;
    }
    case "the signature was made over the manifest's hash without the laws prefix": {
      const bare = createHash("sha256").update(manifestNow()).digest("base64url");
      store(manifestNow(), passkeyFile(phoneSigns(phone, bare)));
      break;
    }
    case "the phone checked no finger and no screen lock":
      storeAnswer({ verified: false });
      break;
    case "nobody was at the phone":
      storeAnswer({ present: false });
      break;
    case "the flags byte is random and lacks the finger check": {
      // Bits 0x01 (somebody there) and 0x04 (finger or lock checked) must both be set. Here one is not.
      const answer = phoneSigns(phone, challengeOf(manifestNow()));
      const flags = int(random, 256) & (random() < 0.5 ? ~0x04 : ~0x01);
      const data = Buffer.from(answer.authenticatorData);
      data[32] = flags;
      const signature = sign("sha256", Buffer.concat([data, sha256(answer.clientDataJSON)]), { key: phone.privateKey, dsaEncoding: "der" });
      store(manifestNow(), passkeyFile({ ...answer, authenticatorData: data, signature }));
      break;
    }
    case "the signature was made at another web address": {
      const addresses = ["https://evil.example.test", `${ORIGIN}:8443`, `${ORIGIN}/`, "http://laws.example.test", "https://LAWS.example.test", `${ORIGIN}.evil.test`, "null"];
      storeAnswer({ origin: addresses[int(random, addresses.length)] ?? "null" });
      break;
    }
    case "the signature was made in a frame of another site":
      storeAnswer({ crossOrigin: true });
      break;
    case "the phone signed for another site": {
      const sites = ["example.test", "evil.example.test", "laws.example.test.", ORIGIN, ""];
      storeAnswer({ rpId: sites[int(random, sites.length)] ?? "" });
      break;
    }
    case "the answer is that of a new passkey, not of a signature":
      storeAnswer({ type: random() < 0.5 ? "webauthn.create" : "payment.get" });
      break;
    case "another key used the listed passkey's id":
      storeAnswer({ credentialId: phone.credentialId }, otherPhone);
      break;
    case "the passkey is not in the signers file":
      storeAnswer({}, otherPhone);
      break;
    case "one bit of the passkey file's content was flipped": {
      const answer = phoneSigns(phone, challengeOf(manifestNow()));
      const fields = ["credentialId", "authenticatorData", "clientDataJSON", "signature"] as const;
      const field = fields[int(random, fields.length)] ?? "signature";
      const bytes = Buffer.from(answer[field]);
      const at = int(random, bytes.length);
      bytes[at] = (bytes[at] ?? 0) ^ (1 << int(random, 8));
      store(manifestNow(), passkeyFile({ ...answer, [field]: bytes }));
      break;
    }
    case "the passkey file is written sloppily": {
      const good = passkeyFile(phoneSigns(phone, challengeOf(manifestNow())));
      const sloppy = sloppySpellings(good);
      store(manifestNow(), sloppy[int(random, sloppy.length)] ?? "");
      break;
    }
    case "the phone's part is too short":
      storeAnswer({ counterBytes: int(random, 4) });
      break;
    case "the signers file names another web address for the passkey":
      storeAnswer({});
      return ownSigners(signersLine(phone, `${ORIGIN}:8443`, RP_ID));
    case "the signers file names another site for the passkey":
      storeAnswer({});
      return ownSigners(signersLine(phone, ORIGIN, "example.test"));
    case "the signers file names another key for the passkey":
      storeAnswer({});
      return ownSigners(signersLine({ ...otherPhone, credentialId: phone.credentialId }));
    default:
      throw new Error(`the test has no case for: ${wrong}`);
  }
  return world.signers;
}

// Ways to write a good passkey file that a strict reader must refuse: a field missing, a field too
// many, padding, the other base64 alphabet, a last letter with stray bits, text around the JSON, a
// field twice, a field far too long. A reader that is not strict takes several of them for the good file.
export function sloppySpellings(good: string): string[] {
  const fields = JSON.parse(good) as Record<string, string>;
  const write = (changed: unknown): string => `${JSON.stringify(changed, null, 2)}\n`;
  const without = (field: string): string => write(Object.fromEntries(Object.entries(fields).filter(([key]) => key !== field)));
  const padded = (field: string): string => write({ ...fields, [field]: `${fields[field]}=` });
  const signature = Buffer.from(fields["signature"] ?? "", "base64url");
  // "-" and "_" are "+" and "/" in the other base64 alphabet. Some decoders take both.
  const otherAlphabet = Object.entries(fields)
    .filter(([, text]) => /[-_]/.test(text))
    .map(([field, text]) => write({ ...fields, [field]: text.replaceAll("-", "+").replaceAll("_", "/") }));
  // The id has 16 bytes, so its last letter carries four bits that mean nothing. Here one of them is set.
  const id = fields["credentialId"] ?? "";
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const strayBits = write({ ...fields, credentialId: id.slice(0, -1) + letters[letters.indexOf(id.slice(-1)) + 1] });
  return [
    ...otherAlphabet,
    strayBits,
    without("credentialId"),
    without("authenticatorData"),
    without("clientDataJSON"),
    without("signature"),
    write({ ...fields, publicKey: "AAAA" }),
    write({ ...fields, comment: "" }),
    padded("signature"),
    padded("authenticatorData"),
    write({ ...fields, signature: `${fields["signature"]}\n` }),
    write({ ...fields, signature: ` ${fields["signature"]}` }),
    write({ ...fields, clientDataJSON: [fields["clientDataJSON"]] }),
    write({ ...fields, credentialId: "" }),
    write({ ...fields, signature: Buffer.concat([signature, Buffer.alloc(200)]).toString("base64url") }),
    write({ ...fields, clientDataJSON: Buffer.alloc(20_000, 32).toString("base64url") }),
    write([fields]),
    JSON.stringify(fields),
    `${good}\n`,
    ` ${good}`,
    good.replace("{", '{\n  "signature": "AAAA",'),
    `${good.trimEnd().slice(0, -1)}, "signature": "AAAA"}\n`,
    "",
    "null\n",
  ];
}

export function firstSeed(): number {
  return Number(process.env["LAWS_SEED"] ?? Date.now() % 1_000_000_000);
}

export function newWorld(): World {
  const folder = mkdtempSync(join(tmpdir(), "laws-t10-"));
  const world = {
    folder,
    signers: join(folder, "allowed_signers"),
    phone: newPhone(),
    otherPhone: newPhone(),
    laptopKey: join(folder, "laptop-key"),
    strangerKey: join(folder, "stranger-key"),
  };
  run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", world.laptopKey]);
  run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", world.strangerKey]);
  // One file, two kinds of lines: the laptop's SSH key and the phone's passkey.
  writeFileSync(world.signers, `owner ${readFileSync(`${world.laptopKey}.pub`, "utf8")}${signersLine(world.phone)}`);
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

// The text of a manifest for these cards as they are now. Each one is a second later than the one before.
function newManifest(repo: string, ids: string[], retire: string[]): string {
  clock += 1000;
  const lines = [...linesNow(repo, ids).split("\n").filter((line) => line !== ""), ...retire.map((id) => `${id} retired`)];
  return `signed: ${new Date(clock).toISOString()}\n${lines.sort().map((line) => `${line}\n`).join("")}`;
}

// Stores a manifest of these cards as they are now with the phone's signature over it, made in the
// given way. Returns the two files.
function approveByPhone(repo: string, ids: string[], phone: Phone, how: Touch = {}, retire: string[] = []): { manifest: string; passkey: string } {
  batchCount += 1;
  const text = newManifest(repo, ids, retire);
  const manifest = join(repo, "laws", "approvals", `batch-${batchCount}.manifest`);
  const passkey = join(repo, "laws", "approvals", `batch-${batchCount}.passkey.json`);
  writeFileSync(manifest, text);
  writeFileSync(passkey, passkeyFile(phoneSigns(phone, challengeOf(text), how)));
  return { manifest, passkey };
}

// Stores a manifest of these cards as they are now, signed with an SSH key. Returns the manifest file.
function approveByLaptop(repo: string, ids: string[], key: string): string {
  batchCount += 1;
  const manifest = join(repo, "laws", "approvals", `batch-${batchCount}.manifest`);
  writeFileSync(manifest, newManifest(repo, ids, []));
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

// ---- The check: the property against the real code, and the laws command on such a repository. ----

// Runs the laws command and returns its exit code and everything it printed.
function laws(command: string, repo: string, signers: string): [number | null, string] {
  const result = spawnSync(process.execPath, [CLI, command, "--repo", repo, "--signers", signers], { encoding: "utf8" });
  return [result.status, result.stdout + result.stderr];
}

if (import.meta.main) {
  const real: Verify = (repo, signersFile) => verifyRepo(repo, signersFile).ok;
  const world = newWorld();
  after(() => removeWorld(world));

  test("T-10 blocked: a real signature attached to a manifest in which one hash was changed", () => {
    blockedSignatureForAnotherList(real, world);
  });
  test("T-10 blocked: a signature that the phone made without checking a finger or the screen lock", () => {
    blockedWithoutFingerOrLock(real, world);
  });
  test("T-10 blocked: a signature made at another web address", () => blockedAnotherAddress(real, world));
  test("T-10 blocked: a signature that the phone made for another site", () => blockedAnotherSite(real, world));
  test("T-10 blocked: a signature from a passkey that the signers file does not list", () => blockedUnlistedPasskey(real, world));
  test("T-10 allowed: three cards under one passkey signature", () => allowedThreeCardsOneSignature(real, world));
  test("T-10 allowed: one manifest signed with the laptop key and another with the passkey", () => allowedLaptopAndPhone(real, world));
  test("T-10 a retirement can be signed on the phone", () => retirementOnThePhone(real, world));
  test(`T-10 only untouched phone approvals count, over ${CASES} generated cases`, () => {
    onlyUntouchedPhoneApprovalsCount(real, world, firstSeed());
  });

  test("T-10 every sloppy spelling of the passkey file is refused", () => refusesSloppyFiles(real, world));

  test("T-10 laws status says why a phone approval does not count", () => {
    const repo = newRepository(world, "status", ["A-01"]);
    const approval = approveByPhone(repo, ["A-01"], world.phone);
    assert.match(laws("status", repo, world.signers)[1], /^A-01 +chosen +approved /m);
    writeFileSync(approval.passkey, JSON.stringify(JSON.parse(readFileSync(approval.passkey, "utf8"))));
    const [, printed] = laws("status", repo, world.signers);
    assert.match(printed, /^A-01 +chosen +waiting /m);
    assert.match(printed, /batch-\d+\.manifest is ignored: its \.passkey\.json file is not valid/);
    rmSync(approval.passkey);
    assert.match(laws("status", repo, world.signers)[1], /is ignored: it has no \.sig file and no \.passkey\.json file/);
  });

  test("T-10 laws verify exits 0 for a phone approval and 1 with the reason when the list was changed", () => {
    const repo = newRepository(world, "command", ["A-01", "B-02"]);
    const approval = approveByPhone(repo, ["A-01", "B-02"], world.phone);
    assert.deepEqual(laws("verify", repo, world.signers), [0, "verified: every card is approved as it is now\n"]);
    assert.equal(laws("gate", repo, world.signers)[1], "open\n");

    // One letter of one hash in the manifest is changed.
    const signed = readFileSync(approval.manifest, "utf8");
    writeFileSync(approval.manifest, signed.replace(/^A-01 (.)/m, (_, letter) => `A-01 ${letter === "0" ? "1" : "0"}`));
    const [exitCode, printed] = laws("verify", repo, world.signers);
    assert.equal(exitCode, 1);
    assert.match(printed, /A-01: waiting/);
    assert.match(printed, /B-02: waiting/, "the whole manifest stops counting, not only the changed line");
    assert.match(printed, /its passkey signature was made for another list/);
  });

  test("T-10 the signers file is read from outside the repository, as in T-02", () => {
    const repo = newRepository(world, "inside", ["A-01"]);
    approveByPhone(repo, ["A-01"], world.phone);
    const inside = join(repo, "laws", "allowed_signers");
    writeFileSync(inside, readFileSync(world.signers));
    const [exitCode, printed] = laws("verify", repo, inside);
    assert.equal(exitCode, 1);
    assert.match(printed, /inside the repository/);
  });

  test("T-10 a passkey line in the signers file that is not exact stops everything, and says which line", () => {
    const repo = newRepository(world, "bad-line", ["A-01"]);
    approveByLaptop(repo, ["A-01"], world.laptopKey);
    assert.equal(real(repo, world.signers), true, "the SSH line must keep working next to a passkey line");

    const good = signersLine(world.phone).trimEnd();
    const key = good.split(" ").at(-1) ?? "";
    // A key on another curve than P-256.
    const otherCurve = generateKeyPairSync("ec", { namedCurve: "secp384r1" }).publicKey.export({ format: "der", type: "spki" });
    const bad = [
      good.replace("https://", "http://"),
      good.replace(`origin="${ORIGIN}"`, `origin="${ORIGIN}/"`),
      good.replace(`origin="${ORIGIN}"`, `origin="${ORIGIN}/laws"`),
      good.replace(`origin="${ORIGIN}"`, 'origin="https://other.test"'),
      good.replace(`rp="${RP_ID}"`, 'rp="Laws.example.test"'),
      good.replace(`rp="${RP_ID}"`, 'rp=""'),
      good.replace(/ id=\S+/, ""),
      good.replace(/ id=/, " id=+"),
      good.replace(key, key.slice(0, -4)),
      good.replace(key, `${key}=`),
      good.replace(key, otherCurve.toString("base64")),
      good.replace(key, "AAAA"),
      good.replace(" passkey ", " passkey  "),
      good.replace(" passkey ", " passkey\t"),
      `${good} my phone`,
      good.replace("alex ", "alex,bob "),
      "alex passkey",
    ];
    for (const line of bad) {
      const signers = join(world.folder, "signers-bad-line");
      writeFileSync(signers, `owner ${readFileSync(`${world.laptopKey}.pub`, "utf8")}${line}\n`);
      const [exitCode, printed] = laws("verify", repo, signers);
      assert.equal(exitCode, 1, `verify passed with this line in the signers file: ${line}`);
      assert.match(printed, /the signers file .* cannot be used: line 2 is not a good passkey line/, line);
    }
  });
}
