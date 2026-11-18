import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  aaguidOf,
  assertionBody,
  decisionSummary,
  flagsOf,
  formatBytes,
  fromBase64url,
  hiddenCharacters,
  isSignerName,
  requestIdFrom,
  signLabel,
  signersLine,
  toBase64,
  toBase64url,
  toHex,
} from "../server/page/pure.js";
import { HEADERS, MAX_KEPT, readSettings, startServer } from "../server/server.ts";
import { keyFingerprint, parsePasskeyLine, readPasskeyFields } from "../src/passkey.ts";
import { newPhone, phoneSigns } from "./support.ts";

// The page was not run in a browser here. These tests run its computing parts under Node, and they
// read its files as text.

const PAGE = join(import.meta.dirname, "../server/page");
const files = new Map(readdirSync(PAGE).map((name) => [name, readFileSync(join(PAGE, name), "utf8")]));

test("the page's base64 and hex are those of Node", () => {
  for (let length = 0; length < 70; length++) {
    const bytes = Uint8Array.from({ length }, (_, at) => (at * 37 + length * 11) % 256);
    const buffer = Buffer.from(bytes);
    assert.equal(toBase64(bytes), buffer.toString("base64"));
    assert.equal(toBase64url(bytes), buffer.toString("base64url"));
    assert.equal(toBase64url(bytes.buffer as ArrayBuffer), buffer.toString("base64url"), "an ArrayBuffer, as the browser gives it");
    assert.equal(toHex(bytes), buffer.toString("hex"));
    assert.deepEqual(Buffer.from(fromBase64url(buffer.toString("base64url"))), buffer);
  }
});

test("the page takes a request id from its address only if it is exact", () => {
  const id = "0123456789abcdef0123456789abcdef";
  assert.equal(requestIdFrom(`?r=${id}`), id);
  for (const search of ["", "?", `?r=${id}0`, `?r=${id.slice(1)}`, `?r=${id.toUpperCase()}`, `?x=1&r=${id}`, `?r=${id}&x=1`, "?r=../x"]) {
    assert.equal(requestIdFrom(search), null, search);
  }
});

test("the page asks for a list only when every card is decided, and only with the accepted cards", () => {
  const cards = [
    { id: "A-01", hash: "a".repeat(64) },
    { id: "B-02", hash: "b".repeat(64) },
    { id: "C-03", hash: null },
  ];
  assert.deepEqual(decisionSummary(cards, new Map()), { accepted: [], rejected: 0, undecided: 3, complete: false });
  const some = new Map([["A-01", "accept"], ["B-02", "reject"]]);
  assert.deepEqual(decisionSummary(cards, some), { accepted: [cards[0]], rejected: 1, undecided: 1, complete: false });
  const all = new Map([...some, ["C-03", "accept"], ["Z-99", "accept"]]);
  assert.deepEqual(decisionSummary(cards, all), { accepted: [cards[0], cards[2]], rejected: 1, undecided: 0, complete: true });
  assert.equal(signLabel(1), "Sign 1 card");
  assert.equal(signLabel(2), "Sign 2 cards");
  assert.equal(formatBytes(1023), "1023 bytes");
  assert.equal(formatBytes(20480), "20.0 KB");
});

test("the page warns about characters that hide or turn the text around", () => {
  assert.equal(hiddenCharacters("**Law.** Plain text, with é and ║.\n"), 0);
  assert.equal(hiddenCharacters("refused‮ desu‬ and a zero​width space"), 3);
});

test("what the page posts after a signature is what laws reads as a passkey answer", () => {
  const phone = newPhone();
  const answer = phoneSigns(phone, "challenge");
  const bytes = (text: string): ArrayBuffer => new Uint8Array(Buffer.from(text, "base64url")).buffer as ArrayBuffer;
  const credential = {
    rawId: bytes(answer.credentialId),
    response: { authenticatorData: bytes(answer.authenticatorData), clientDataJSON: bytes(answer.clientDataJSON), signature: bytes(answer.signature) },
  };
  assert.deepEqual(assertionBody(credential), answer);
  assert.equal(readPasskeyFields(assertionBody(credential)).authenticatorData.length, 37);
});

test("the line that the registration page shows is a line that laws reads, with the same fingerprint", () => {
  const phone = newPhone("https://pi.example.ts.net", "pi.example.ts.net");
  const publicKey = phone.publicKey.export({ format: "der", type: "spki" });
  const line = signersLine("alex", phone.origin, phone.rpId, phone.credentialId, publicKey);
  const signer = parsePasskeyLine(line);
  assert.deepEqual([signer.name, signer.origin, signer.rpId, signer.credentialId], ["alex", phone.origin, phone.rpId, phone.credentialId.toString("base64url")]);
  // The page shows sha256 of the public key in hex. On the laptop: cut the last word of the line,
  // then base64 -d | sha256sum.
  const shown = toHex(createHash("sha256").update(publicKey).digest());
  assert.equal(shown, keyFingerprint(signer));
  assert.equal(shown, createHash("sha256").update(Buffer.from(line.split(" ").at(-1) ?? "", "base64")).digest("hex"));
  assert.ok(isSignerName("alex") && isSignerName("a.b_c@d-e"));
  assert.ok(!isSignerName("") && !isSignerName("alex b") && !isSignerName('alex"') && !isSignerName("-x"));
});

test("the registration page reads the flags and the make of the device from the phone's data", () => {
  const head = [...new Uint8Array(32), 0x45, 0, 0, 0, 0]; // somebody there, finger checked, key data follows
  const aaguid = Array.from({ length: 16 }, (_, at) => at + 1);
  const created = Uint8Array.from([...head, ...aaguid, 0, 16, ...new Uint8Array(16)]);
  assert.equal(aaguidOf(created), "01020304-0506-0708-090a-0b0c0d0e0f10");
  assert.deepEqual(flagsOf(created), { present: true, verified: true, backupEligible: false, backedUp: false, hasKey: true });
  assert.deepEqual(flagsOf(Uint8Array.from([...new Uint8Array(32), 0x1d])), { present: true, verified: true, backupEligible: true, backedUp: true, hasKey: false });
  assert.equal(aaguidOf(Uint8Array.from(head.map((byte, at) => (at === 32 ? 0x05 : byte)))), null, "a signature carries no key data");
  assert.equal(aaguidOf(created.subarray(0, 40)), null);
});

test("the page's scripts are JavaScript that Node can at least read", () => {
  for (const name of ["app.js", "register.js", "pure.js"]) {
    const checked = spawnSync(process.execPath, ["--check", join(PAGE, name)], { encoding: "utf8" });
    assert.equal(checked.status, 0, `${name}: ${checked.stderr}`);
  }
});

test("nothing on the page moves: no animation and no transition in its styles or scripts", () => {
  assert.deepEqual([...files.keys()].sort(), ["app.js", "index.html", "pure.d.ts", "pure.js", "register.html", "register.js", "style.css"]);
  for (const [name, text] of files) {
    assert.doesNotMatch(text, /animat|transition|keyframes|scroll-behavior|requestAnimationFrame|setInterval|\.animate\(|marquee|blink/i, name);
  }
});

test("the page loads nothing from elsewhere, has nothing inline, and uses relative addresses only", () => {
  for (const [name, text] of files) {
    assert.doesNotMatch(text, /https?:\/\/|\/\/[a-z0-9.-]+\.[a-z]{2,}\//i, `${name} names another site`);
    assert.doesNotMatch(text, /(href|src|action)="\//, `${name} has an address that starts at the root of the site`);
    assert.doesNotMatch(text, /fetch\(\s*["'`]\//, `${name} fetches an address that starts at the root of the site`);
    assert.doesNotMatch(text, /document\.cookie|localStorage|sessionStorage|innerHTML|outerHTML|insertAdjacentHTML|eval\(|new Function/, name);
  }
  for (const name of ["index.html", "register.html"]) {
    const text = files.get(name) ?? "";
    assert.doesNotMatch(text, /<style|style=|\son[a-z]+=|<script(?![^>]*\ssrc=)[^>]*>/i, `${name} has a style or a script inside it`);
    assert.match(text, /<meta name="viewport" content="width=device-width, initial-scale=1" \/>/);
  }
  // The passkey is asked for with a check of the person, and a new one is of the ES256 kind only.
  assert.match(files.get("app.js") ?? "", /navigator\.credentials\s*\.get\(\{\s*publicKey: \{[^}]*userVerification: "required"/);
  assert.match(files.get("register.js") ?? "", /pubKeyCredParams: \[\{ type: "public-key", alg: -7 \}\],\s*authenticatorSelection: \{ residentKey: "required", userVerification: "required" \}/);
  assert.doesNotMatch(files.get("register.js") ?? "", /method: "POST"/, "the registration page sends nothing to the server");
});

test("the server sends the page with a strict policy and without cookies", async () => {
  const state = mkdtempSync(join(tmpdir(), "laws-page-"));
  const server = await startServer({ port: 0, state, origin: "https://laws.example.test", rpId: "laws.example.test", signers: null }, () => {});
  try {
    const types = new Map([
      ["", "text/html"],
      ["index.html", "text/html"],
      ["register.html", "text/html"],
      ["style.css", "text/css"],
      ["app.js", "text/javascript"],
      ["register.js", "text/javascript"],
      ["pure.js", "text/javascript"],
      ["api/info", "application/json"],
    ]);
    for (const [path, type] of types) {
      const response = await fetch(`http://127.0.0.1:${server.port}/${path}`);
      assert.equal(response.status, 200, path);
      assert.ok(response.headers.get("content-type")?.startsWith(type), path);
      assert.equal(response.headers.get("set-cookie"), null, path);
      assert.equal(response.headers.get("content-security-policy"), HEADERS["Content-Security-Policy"], path);
      assert.equal(response.headers.get("cache-control"), "no-store", path);
      if (path !== "api/info") assert.equal(await response.text(), files.get(path === "" ? "index.html" : path), path);
    }
    assert.match(HEADERS["Content-Security-Policy"] ?? "", /^default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self';/);
    assert.doesNotMatch(HEADERS["Content-Security-Policy"] ?? "", /unsafe|\*|data:|https?:/);
    const info = (await (await fetch(`http://127.0.0.1:${server.port}/api/info`)).json()) as Record<string, unknown>;
    assert.deepEqual(info, { rpId: "laws.example.test", origin: "https://laws.example.test", checks: false, hours: 24 });
    assert.equal((await fetch(`http://127.0.0.1:${server.port}/pure.d.ts`)).status, 404);
  } finally {
    await server.stop();
    rmSync(state, { recursive: true, force: true });
  }
});

test("the server keeps at most 200 requests: when there are more, the oldest closed ones go", async () => {
  const state = mkdtempSync(join(tmpdir(), "laws-kept-"));
  const server = await startServer({ port: 0, state, origin: "https://laws.example.test", rpId: "laws.example.test", signers: null }, () => {});
  try {
    const card = Buffer.from("---\nid: A-01\ngrade: prose\n---\n# A-01 A law\n").toString("base64");
    const send = async (path: string, body: string): Promise<Record<string, unknown>> => {
      const response = await fetch(`http://127.0.0.1:${server.port}/api/${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body });
      assert.equal(response.status, 200, path);
      return (await response.json()) as Record<string, unknown>;
    };
    const ids: string[] = [];
    for (let n = 0; n < MAX_KEPT + 5; n++) {
      const { id } = await send("requests", JSON.stringify({ cards: [{ id: "A-01", retire: false, card, files: [] }] }));
      ids.push(String(id));
      await send(`requests/${String(id)}/reject`, "{}");
    }
    const kept = readdirSync(state).filter((name) => name !== "record.log");
    assert.equal(kept.length, MAX_KEPT);
    assert.ok(kept.includes(ids.at(-1) ?? ""), "the newest request must be kept");
    assert.ok(!kept.includes(ids[0] ?? ""), "the oldest closed request must be gone");
  } finally {
    await server.stop();
    rmSync(state, { recursive: true, force: true });
  }
});

test("the server starts only on this machine's own address, for an https site", () => {
  const words = (listen: string, origin: string, rpId: string): string[] => ["--listen", listen, "--state", "/tmp/x", "--origin", origin, "--rp-id", rpId];
  const good = readSettings(words("127.0.0.1:8123", "https://pi.example.ts.net", "pi.example.ts.net"));
  assert.deepEqual(good, { port: 8123, state: "/tmp/x", origin: "https://pi.example.ts.net", rpId: "pi.example.ts.net", signers: null });
  assert.equal(readSettings([...words("127.0.0.1:1", "https://pi.example.ts.net:8443", "example.ts.net"), "--signers", "/etc/s"]).signers, "/etc/s");
  for (const listen of ["0.0.0.0:8123", "8123", "localhost:8123", "127.0.0.1", "127.0.0.1:99999", "[::]:80"]) {
    assert.throws(() => readSettings(words(listen, "https://pi.example.ts.net", "pi.example.ts.net")), /--listen must be 127\.0\.0\.1:<port>/, listen);
  }
  assert.throws(() => readSettings(words("127.0.0.1:1", "http://pi.example.ts.net", "pi.example.ts.net")), /--origin/);
  assert.throws(() => readSettings(words("127.0.0.1:1", "https://pi.example.ts.net/laws", "pi.example.ts.net")), /--origin/);
  assert.throws(() => readSettings(words("127.0.0.1:1", "https://pi.example.ts.net", "other.ts.net")), /--rp-id/);
  assert.throws(() => readSettings(words("127.0.0.1:1", "https://pi.example.ts.net", "pi.example.ts.net").slice(2)), /--listen is missing/);
  assert.throws(() => readSettings([...words("127.0.0.1:1", "https://pi.example.ts.net", "pi.example.ts.net"), "--key", "k"]), /unknown option/);
});
