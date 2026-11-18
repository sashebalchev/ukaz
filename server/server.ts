#!/usr/bin/env node
// laws-server: the signing server, the one place where laws are signed. It carries cards from the
// laptop to your finger, and signatures back, and it keeps a record of every approval.
//
//   laws-server --listen 127.0.0.1:<port> --state <folder> --origin <https address> --rp-id <host> [--signers <file>]
//
// It holds no key and it cannot approve anything: what counts is "laws verify" on the laptop, which
// checks each signature against the signers file there. So nothing here needs to be believed.
//
//   1. The laptop posts a request: the bytes of each card and of each file hashed with it.
//      The server computes the hashes from those bytes and answers with the list.
//   2. A waiting request is approved in one of two ways. The first good approval closes it.
//      On the phone: the page shows each card from the stored bytes, with the hash computed from them
//      at that moment. The page sends the cards that the person accepted. The server builds the
//      manifest from those cards and from nothing else, dates it, and answers with its challenge. The
//      phone's passkey signs the challenge, and the page posts the answer.
//      On the laptop: the fingerprint helper fetches the stored request, computes the hashes itself,
//      checks the finger, signs a manifest with the laptop key, and posts both. The server takes the
//      manifest only if every line of it is a card of this request with the hash computed here.
//   3. The server stores the manifest and the signature, and adds one line to its record:
//      who approved (phone or laptop), which request, and the list.
//      With --signers it also checks the signature first, only to say at once whether the laptop
//      will accept it.
//   4. The laptop fetches the manifest and the signature, checks both, and stores them.
//
// No hash is stored: what is shown, what is offered for signing and what is hashed always come from
// the same stored bytes. A request waits for 24 hours and is then removed. At most 20 wait at a time.
// The server sits behind a reverse proxy that serves it under a path of its own, such as /laws/, and
// that removes this path before it passes a request on. The page uses relative addresses only.

import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { parseManifest, signatureProblem } from "../src/approvals.ts";
import type { Manifest } from "../src/approvals.ts";
import { renderedFigure } from "../src/card.ts";
import { LawsError } from "../src/cards.ts";
import { challengeFor, MAX_PASSKEY_FILE_BYTES, passkeyApprovalText, passkeyProblem, readPasskeyFields, splitSigners } from "../src/passkey.ts";
import { manifestOf, MAX_REQUEST_CHARS, readRequest, RequestError } from "../src/request.ts";
import type { PasskeySigner } from "../src/passkey.ts";
import type { Line, ReadCard } from "../src/request.ts";

export const EXPIRY_HOURS = 24; // long enough to post in the evening and sign in the morning
export const MAX_WAITING = 20; // requests that wait for an approval at one time
export const MAX_KEPT = 200; // requests that are kept in all, the closed ones included
const MAX_SMALL_BODY = 64 * 1024;
const MAX_SIGNATURE_CHARS = 8 * 1024;
const SSH_SIGNATURE = /^-----BEGIN SSH SIGNATURE-----\n([A-Za-z0-9+/=]+\n)+-----END SSH SIGNATURE-----\n$/;
const REQUEST_ID = /^[0-9a-f]{32}$/;
const HOST = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/;
const USAGE = "usage: laws-server --listen 127.0.0.1:<port> --state <folder> --origin <https address> --rp-id <host> [--signers <file>]";

export type Settings = { port: number; state: string; origin: string; rpId: string; signers: string | null };
export type Running = { port: number; stop: () => Promise<void> };

type State = "waiting" | "signed" | "rejected";
// by: who approved a signed request. The phone leaves a passkey answer, the laptop an SSH signature.
type Stored = { state: State; by: "phone" | "laptop" | null; created: number; manifest: string | null; passkey: string | null; signature: string | null };

// An answer that says no: the HTTP status and one sentence for the person.
class Refusal extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// The page: plain files, read once at start. Only these addresses exist besides /api/.
const PAGE_FOLDER = join(import.meta.dirname, "page");
const PAGE_FILES: [string, string, string][] = [
  ["/", "index.html", "text/html; charset=utf-8"],
  ["/index.html", "index.html", "text/html; charset=utf-8"],
  ["/register.html", "register.html", "text/html; charset=utf-8"],
  ["/style.css", "style.css", "text/css; charset=utf-8"],
  ["/app.js", "app.js", "text/javascript; charset=utf-8"],
  ["/register.js", "register.js", "text/javascript; charset=utf-8"],
  ["/pure.js", "pure.js", "text/javascript; charset=utf-8"],
];

// Sent with every answer. The page may load scripts and styles from this server only, may talk to this
// server only, and may not be put into a frame. No cookie is ever set.
export const HEADERS: Record<string, string> = {
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cache-Control": "no-store",
};

export function readSettings(words: string[]): Settings {
  const options = new Map<string, string>();
  for (let i = 0; i < words.length; i += 2) {
    const word = words[i] ?? "";
    const value = words[i + 1];
    if (!["--listen", "--state", "--origin", "--rp-id", "--signers"].includes(word)) throw new Error(`unknown option ${word}.\n${USAGE}`);
    if (value === undefined || options.has(word)) throw new Error(`${word} needs one value, once.\n${USAGE}`);
    options.set(word, value);
  }
  const need = (name: string): string => {
    const value = options.get(name);
    if (value === undefined) throw new Error(`${name} is missing.\n${USAGE}`);
    return value;
  };
  // Only this machine itself may connect. The reverse proxy is the one door from outside.
  const port = /^127\.0\.0\.1:([0-9]{1,5})$/.exec(need("--listen"))?.[1];
  if (port === undefined || Number(port) > 65535) throw new Error(`--listen must be 127.0.0.1:<port>.\n${USAGE}`);
  const settings = { port: Number(port), state: need("--state"), origin: need("--origin"), rpId: need("--rp-id"), signers: options.get("--signers") ?? null };
  checkSettings(settings);
  return settings;
}

function checkSettings(settings: Settings): void {
  const host = /^https:\/\/([^:/]+)(:[0-9]{1,5})?$/.exec(settings.origin)?.[1] ?? "";
  if (!HOST.test(host)) throw new Error(`--origin ${settings.origin} must be https://<host> or https://<host>:<port>, with nothing after it`);
  if (!HOST.test(settings.rpId) || (host !== settings.rpId && !host.endsWith(`.${settings.rpId}`))) {
    throw new Error(`--rp-id ${settings.rpId} must be the host of ${settings.origin} or a parent of it`);
  }
}

// Starts the server. Everything it says goes through print.
export async function startServer(settings: Settings, print: (line: string) => void): Promise<Running> {
  checkSettings(settings);
  const { state } = settings;
  mkdirSync(state, { recursive: true, mode: 0o700 });
  const pages = new Map(PAGE_FILES.map(([address, file, type]) => [address, { type, body: readFileSync(join(PAGE_FOLDER, file)) }]));
  const lifetime = EXPIRY_HOURS * 3600 * 1000;

  // ---- What is stored: one folder per request, named by its id. ----
  //   request.json   the request as the laptop posted it, for as long as it waits
  //   created        when it arrived
  //   manifest       the list that the phone is asked to sign, or the list that the laptop signed
  //   passkey.json   the phone's answer, if the phone approved
  //   manifest.sig   the laptop's SSH signature, if the laptop approved
  //   rejected       present if the person rejected everything
  // And one file for all of them: record.log, one line per approval, never shortened by the server.

  const read = (id: string, name: string, maxBytes: number): string | null => {
    try {
      const file = join(state, id, name);
      return statSync(file).size <= maxBytes ? readFileSync(file, "utf8") : null;
    } catch {
      return null;
    }
  };

  // Removes requests that ran out, and folders that are not a request any more.
  const prune = (): string[] => {
    const now = Date.now();
    const kept: string[] = [];
    for (const id of readdirSync(state).filter((name) => REQUEST_ID.test(name))) {
      const created = Date.parse(read(id, "created", 64) ?? "");
      if (Number.isFinite(created) && created <= now && now - created < lifetime) kept.push(id);
      else rmSync(join(state, id), { recursive: true, force: true });
    }
    return kept;
  };

  // What is stored for a request that is known to be there.
  const lookup = (id: string): Stored => {
    const manifest = read(id, "manifest", MAX_SMALL_BODY);
    const passkey = read(id, "passkey.json", MAX_PASSKEY_FILE_BYTES);
    const signature = read(id, "manifest.sig", MAX_SIGNATURE_CHARS);
    const rejected = existsSync(join(state, id, "rejected"));
    const by = manifest === null ? null : passkey !== null ? "phone" : signature !== null ? "laptop" : null;
    const requestState = rejected ? "rejected" : by !== null ? "signed" : "waiting";
    return { state: requestState, by, created: Date.parse(read(id, "created", 64) ?? ""), manifest, passkey, signature };
  };

  // The record: one line per approval. Who approved, which request, whether the server could check the
  // signature against a signers file, the time inside the manifest, and the list.
  const record = (by: "phone" | "laptop", id: string, checked: boolean, listed: Manifest): void => {
    const list = listed.entries.map((entry) => `${entry.id}=${entry.hash ?? "retired"}`).join(" ");
    const line = `${new Date().toISOString()} ${by} request=${id} checked=${checked ? "yes" : "no"} signed=${listed.time} ${list}\n`;
    appendFileSync(join(state, "record.log"), line, { mode: 0o600 });
  };

  const stored = (id: string): Stored => {
    if (!REQUEST_ID.test(id) || !prune().includes(id)) throw new Refusal(404, "there is no such request. It may have run out");
    return lookup(id);
  };

  // The cards of a request, read from the stored bytes, with every hash computed now.
  const cardsOf = (id: string): ReadCard[] => {
    try {
      return readRequest(read(id, "request.json", MAX_REQUEST_CHARS) ?? "");
    } catch (error) {
      if (!(error instanceof RequestError)) throw error;
      throw new Refusal(500, `the stored request cannot be read any more: ${error.message}`);
    }
  };

  // A request that is approved or rejected needs its cards no more. They are the large part of it.
  const close = (id: string): void => rmSync(join(state, id, "request.json"), { force: true });

  const waitingOnly = (id: string): Stored => {
    const found = stored(id);
    if (found.state === "signed") throw new Refusal(409, "this request is signed already");
    if (found.state === "rejected") throw new Refusal(409, "this request was rejected");
    return found;
  };

  const expires = (created: number): string => new Date(created + lifetime).toISOString();

  // ---- The answers. ----

  const create = (text: string): object => {
    let cards: ReadCard[];
    try {
      cards = readRequest(text);
    } catch (error) {
      if (!(error instanceof RequestError)) throw error;
      throw new Refusal(400, error.message);
    }
    // Closed requests are small and are kept until they run out, so that the laptop can still fetch
    // them. If there are too many of them, the oldest go first.
    const kept = prune().map((id) => ({ id, ...lookup(id) }));
    if (kept.filter((request) => request.state === "waiting").length >= MAX_WAITING) {
      throw new Refusal(429, `${MAX_WAITING} requests are waiting already. Sign or reject one, or wait until one runs out`);
    }
    const closed = kept.filter((request) => request.state !== "waiting").sort((a, b) => a.created - b.created);
    for (const old of closed.slice(0, Math.max(0, kept.length + 1 - MAX_KEPT))) rmSync(join(state, old.id), { recursive: true, force: true });
    const id = randomBytes(16).toString("hex");
    const created = new Date();
    mkdirSync(join(state, id), { mode: 0o700 });
    writeFileSync(join(state, id, "request.json"), text, { mode: 0o600 });
    writeFileSync(join(state, id, "created"), created.toISOString(), { mode: 0o600 });
    return { id, list: cards.map(lineOf), expires: expires(created.getTime()) };
  };

  const list = (): object => {
    const waiting = prune()
      .map((id) => ({ id, ...lookup(id) }))
      .filter((request) => request.state === "waiting")
      .sort((a, b) => a.created - b.created);
    return {
      requests: waiting.map(({ id, created }) => ({
        id,
        created: new Date(created).toISOString(),
        expires: expires(created),
        cards: cardsOf(id).map(({ id: card, hash, title }) => ({ id: card, retire: hash === null, title })),
      })),
    };
  };

  // What the page shows. The text of a card and its hash come from the same bytes, read just now.
  const show = (id: string): object => {
    const { state: requestState, by, created, manifest } = stored(id);
    // A closed request holds no cards any more: only what was signed is shown.
    const cards = (requestState === "waiting" ? cardsOf(id) : []).map((card) => {
      const picture = card.files.find((file) => file.path === renderedFigure(card.card));
      return {
        id: card.id,
        retire: card.hash === null,
        hash: card.hash,
        title: card.title,
        text: new TextDecoder().decode(card.cardBytes),
        figure: picture === undefined ? null : { path: picture.path, text: new TextDecoder().decode(picture.bytes) },
        files: card.files.map((file) => ({ path: file.path, bytes: file.bytes.length })),
      };
    });
    return { id, state: requestState, by, created: new Date(created).toISOString(), expires: expires(created), manifest, cards };
  };

  // What the laptop's fingerprint helper fetches: the request as it was posted, byte for byte.
  // The helper computes the hashes itself.
  const posted = (id: string): string => {
    waitingOnly(id);
    return read(id, "request.json", MAX_REQUEST_CHARS) ?? "";
  };

  // The page names the cards that the person accepted, each with the hash that the page showed.
  // The manifest is built from the stored bytes of exactly those cards. If a hash is not what the
  // page showed, the bytes changed in between, and nothing is offered for signing.
  const options = (id: string, body: unknown): object => {
    const accept = exactly(body, ["accept"])["accept"];
    if (!Array.isArray(accept) || accept.length === 0) throw new Refusal(400, "no card was accepted");
    waitingOnly(id);
    const cards = cardsOf(id);
    const lines: Line[] = [];
    for (const item of accept as unknown[]) {
      const { id: card, hash } = exactly(item, ["id", "hash"]);
      const found = cards.find((candidate) => candidate.id === card);
      if (found === undefined) throw new Refusal(400, "a card was accepted that is not in this request");
      if (lines.some((line) => line.id === found.id)) throw new Refusal(400, `${found.id} was accepted twice`);
      if (found.hash !== hash) throw new Refusal(409, `${found.id} is not what the page showed any more. Load the page again and read it again`);
      lines.push(lineOf(found));
    }
    const manifest = manifestOf(new Date().toISOString(), lines);
    writeFileSync(join(state, id, "manifest"), manifest, { mode: 0o600 });
    return { manifest, challenge: challengeFor(Buffer.from(manifest, "utf8")), rpId: settings.rpId };
  };

  // The phone's answer is stored next to the manifest. The check with --signers is a courtesy to the
  // phone: the laptop checks again, and only that check counts.
  const assertion = (id: string, body: unknown): object => {
    let text: string;
    try {
      text = passkeyApprovalText(readPasskeyFields(body));
    } catch (error) {
      throw new Refusal(400, `this is not a passkey answer: ${error instanceof Error ? error.message : String(error)}`);
    }
    const { manifest } = waitingOnly(id);
    if (manifest === null) throw new Refusal(409, "no list was offered for signing yet");
    let checked = "not checked";
    if (settings.signers !== null) {
      let passkeys: PasskeySigner[];
      try {
        ({ passkeys } = splitSigners(readFileSync(settings.signers, "utf8")));
      } catch (error) {
        throw new Refusal(500, `the server's signers file cannot be used: ${error instanceof Error ? error.message : String(error)}`);
      }
      const problem = passkeyProblem(Buffer.from(manifest, "utf8"), text, passkeys, "the server's signers file");
      if (problem !== null) throw new Refusal(422, `the laptop would not accept this signature: ${problem}`);
      checked = "accepted";
    }
    record("phone", id, checked === "accepted", parseManifest(manifest));
    writeFileSync(join(state, id, "passkey.json"), text, { mode: 0o600 });
    close(id);
    return { stored: true, checked };
  };

  // The laptop's fingerprint helper hands over a manifest that it signed with the laptop key. The
  // server takes it only if every line names a card of this request with the hash that the server
  // computes from the stored bytes. A part of the cards is fine. Any other line is refused.
  const signature = (id: string, body: unknown): object => {
    const { manifest, signature: signed } = exactly(body, ["manifest", "signature"]);
    if (typeof manifest !== "string" || manifest.length > MAX_SMALL_BODY) throw new Refusal(400, "this is not a manifest");
    if (typeof signed !== "string" || signed.length > MAX_SIGNATURE_CHARS || !SSH_SIGNATURE.test(signed)) {
      throw new Refusal(400, "this is not an SSH signature");
    }
    let listed: Manifest;
    try {
      listed = parseManifest(manifest);
    } catch (error) {
      throw new Refusal(400, `this is not a manifest: ${error instanceof Error ? error.message : String(error)}`);
    }
    waitingOnly(id);
    const cards = cardsOf(id);
    for (const entry of listed.entries) {
      const held = cards.find((card) => card.id === entry.id);
      if (held === undefined) throw new Refusal(422, `the signed list names ${entry.id}, and this request has no such card`);
      if (held.hash !== entry.hash) throw new Refusal(422, `the signed list does not have ${entry.id} as it waits here`);
    }
    let checked = "not checked";
    if (settings.signers !== null) {
      // The check of an SSH signature wants the signature in a file.
      const candidate = join(state, id, "candidate.sig");
      let problem: string | null;
      try {
        writeFileSync(candidate, signed, { mode: 0o600 });
        problem = signatureProblem(Buffer.from(manifest, "utf8"), candidate, settings.signers);
      } catch (error) {
        if (!(error instanceof LawsError)) throw error;
        throw new Refusal(500, `the server's signers file cannot be used: ${error.message}`);
      } finally {
        rmSync(candidate, { force: true });
      }
      if (problem !== null) throw new Refusal(422, `the laptop would not accept this signature: ${problem}`);
      checked = "accepted";
    }
    record("laptop", id, checked === "accepted", listed);
    rmSync(join(state, id, "passkey.json"), { force: true });
    writeFileSync(join(state, id, "manifest"), manifest, { mode: 0o600 });
    writeFileSync(join(state, id, "manifest.sig"), signed, { mode: 0o600 });
    close(id);
    return { stored: true, checked };
  };

  const reject = (id: string): object => {
    waitingOnly(id);
    rmSync(join(state, id, "manifest"), { force: true });
    writeFileSync(join(state, id, "rejected"), "", { mode: 0o600 });
    close(id);
    return { rejected: true };
  };

  // What the laptop fetches when the request is closed: the manifest, and the phone's passkey answer
  // or the laptop's SSH signature.
  const result = (id: string): object => {
    const { state: requestState, by, manifest, passkey, signature: signed } = stored(id);
    if (requestState !== "signed") return { state: requestState };
    return by === "phone" ? { state: requestState, by, manifest, passkey } : { state: requestState, by, manifest, signature: signed };
  };

  const info = (): object => ({ rpId: settings.rpId, origin: settings.origin, checks: settings.signers !== null, hours: EXPIRY_HOURS });

  // An object is sent as JSON. A text is JSON already.
  const answer = async (request: IncomingMessage): Promise<object | string> => {
    const method = request.method ?? "";
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    const [api, what, id, action, ...more] = path.split("/").slice(1);
    if (api !== "api" || more.length > 0) throw new Refusal(404, "there is nothing at this address");
    const route = `${method} ${what ?? ""}${id === undefined ? "" : "/<id>"}${action === undefined ? "" : `/${action}`}`;
    if (what === "requests" && id !== undefined) stored(id); // an id that names no request ends here, whatever was sent with it
    switch (route) {
      case "GET info":
        return info();
      case "GET requests":
        return list();
      case "POST requests":
        return create(await bodyOf(request, MAX_REQUEST_CHARS));
      case "GET requests/<id>":
        return show(id ?? "");
      case "GET requests/<id>/result":
        return result(id ?? "");
      case "GET requests/<id>/request":
        return posted(id ?? "");
      case "POST requests/<id>/signature":
        return signature(id ?? "", jsonOf(await bodyOf(request, MAX_SMALL_BODY)));
      case "POST requests/<id>/options":
        return options(id ?? "", jsonOf(await bodyOf(request, MAX_SMALL_BODY)));
      case "POST requests/<id>/assertion":
        return assertion(id ?? "", jsonOf(await bodyOf(request, MAX_SMALL_BODY)));
      case "POST requests/<id>/reject":
        await bodyOf(request, MAX_SMALL_BODY);
        return reject(id ?? "");
      default:
        throw new Refusal(404, "there is nothing at this address");
    }
  };

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const send = (status: number, type: string, body: string | Uint8Array): void => {
      response.writeHead(status, { ...HEADERS, "Content-Type": type });
      response.end(body);
    };
    const page = pages.get(new URL(request.url ?? "/", "http://localhost").pathname);
    try {
      if (page !== undefined && request.method === "GET") return send(200, page.type, page.body);
      const body = await answer(request);
      send(200, "application/json", typeof body === "string" ? body : JSON.stringify(body));
    } catch (error) {
      if (error instanceof Refusal) return send(error.status, "application/json", JSON.stringify({ error: error.message }));
      print(`laws-server: ${error instanceof Error ? error.message : String(error)}`);
      send(500, "application/json", JSON.stringify({ error: "the server failed" }));
    }
  };

  prune();
  const server = createServer((request, response) => void handle(request, response));
  server.headersTimeout = 10_000;
  server.requestTimeout = 60_000;
  await new Promise<void>((done, failed) => {
    server.on("error", failed);
    server.listen(settings.port, "127.0.0.1", done);
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : settings.port;
  print(`laws-server: listening on 127.0.0.1:${port} for ${settings.origin}. Requests wait up to ${EXPIRY_HOURS} hours in ${state}.`);

  return {
    port,
    stop: () =>
      new Promise((done) => {
        server.close(() => done());
        server.closeAllConnections();
      }),
  };
}

function lineOf({ id, hash, title }: Line): Line {
  return { id, hash, title };
}

// The value must be an object with exactly these keys.
function exactly(value: unknown, keys: string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Refusal(400, "the request is not what this address takes");
  const record = value as Record<string, unknown>;
  const found = Object.keys(record);
  if (found.length !== keys.length || !keys.every((key) => found.includes(key))) throw new Refusal(400, "the request is not what this address takes");
  return record;
}

function jsonOf(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Refusal(400, "the request is not JSON");
  }
}

// The body of a POST. It must say that it is JSON: a form on another web site cannot say that.
function bodyOf(request: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((done, failed) => {
    if (!String(request.headers["content-type"]).startsWith("application/json")) {
      return failed(new Refusal(415, "the request must be sent as application/json"));
    }
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size <= maxBytes) chunks.push(chunk);
      else failed(new Refusal(413, "the request is too large"));
    });
    request.on("end", () => done(Buffer.concat(chunks).toString("utf8")));
    request.on("error", () => failed(new Refusal(400, "the request broke off")));
  });
}

if (import.meta.main) {
  try {
    process.umask(0o077); // what this server stores is for its own user only
    const service = await startServer(readSettings(process.argv.slice(2)), (line) => console.log(line));
    const stop = (): void => {
      service.stop().then(
        () => process.exit(0),
        () => process.exit(1),
      );
    };
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);
  } catch (error) {
    console.error(`laws-server: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
