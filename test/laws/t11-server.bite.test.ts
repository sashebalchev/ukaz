// The bite of law T-11: the same property as the check, run against servers and against ways to verify
// that are broken on purpose.
// Every test in this file must FAIL. If one passes, the check of T-11 has lost its teeth.

import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { after, test } from "node:test";
import { startServer } from "../../server/server.ts";
import { parseManifest } from "../../src/approvals.ts";
import { loadCards } from "../../src/cards.ts";
import { verifyRepo } from "../../src/verify.ts";
import {
  blockedBytesChangedOnServer,
  blockedListWithAForeignCard,
  blockedStoreRewritten,
  blockedThirdCardNotAccepted,
  challengeOf,
  firstSeed,
  newWorld,
  noRewriteMakesAnUnsignedListVerify,
  removeWorld,
} from "./t11-server.test.ts";
import type { Start, Verify } from "./t11-server.test.ts";

const ORIGIN = "https://laws.example.test";
const RP_ID = "laws.example.test";

const realServer: Start = async (state, signers) => {
  const running = await startServer({ port: 0, state, origin: ORIGIN, rpId: RP_ID, signers }, () => {});
  return { url: `http://127.0.0.1:${running.port}/`, stop: running.stop };
};
const realVerify: Verify = (repo, signersFile) => verifyRepo(repo, signersFile).ok;

// Broken on purpose: a way to verify that trusts the server about which list was signed. It checks that
// the passkey answer is a real one from the passkey in the signers file, and takes the list from the
// manifest that lies next to it, without asking whether the answer was made for that manifest.
const believesTheList: Verify = (repo, signersFile) => {
  const listed = [...readFileSync(signersFile, "utf8").matchAll(/^\S+ passkey origin="([^"]*)" rp="([^"]*)" id=(\S+) (\S+)$/gm)];
  const folder = join(repo, "laws", "approvals");
  const approved = new Set<string>();
  for (const name of readdirSync(folder).filter((file) => file.endsWith(".manifest"))) {
    const passkeyFile = join(folder, name.replace(/\.manifest$/, ".passkey.json"));
    if (!existsSync(passkeyFile)) continue;
    try {
      const fields = JSON.parse(readFileSync(passkeyFile, "utf8")) as Record<string, string>;
      const part = (field: string): Buffer => Buffer.from(String(fields[field]), "base64url");
      const [, origin, site, , key] = listed.find((line) => line[3] === fields["credentialId"]) ?? [];
      if (key === undefined || site === undefined) continue;
      const client = JSON.parse(part("clientDataJSON").toString("utf8")) as Record<string, unknown>;
      const data = part("authenticatorData");
      if (client["type"] !== "webauthn.get" || client["origin"] !== origin) continue;
      if (!data.subarray(0, 32).equals(createHash("sha256").update(site).digest()) || ((data[32] ?? 0) & 0x05) !== 0x05) continue;
      const signedBytes = Buffer.concat([data, createHash("sha256").update(part("clientDataJSON")).digest()]);
      const publicKey = createPublicKey({ key: Buffer.from(key, "base64"), format: "der", type: "spki" });
      if (!verifySignature("sha256", signedBytes, { key: publicKey, dsaEncoding: "der" }, part("signature"))) continue;
      for (const entry of parseManifest(readFileSync(join(folder, name), "utf8")).entries) approved.add(`${entry.id} ${entry.hash}`);
    } catch {
      continue; // a file that cannot be read approves nothing
    }
  }
  return loadCards(repo).every((card) => card.ok && approved.has(`${card.id} ${card.hash}`));
};

// A broken server is the real server with something in front of it that changes what goes in or out.
// The change gets one call and may answer it itself. Null: the call goes to the real server as it is.
type Answer = { status: number; text: string };
type Call = { method: string; path: string; body: string; state: string; real: (method: string, path: string, body?: string) => Promise<Answer> };

function brokenServer(change: (call: Call) => Promise<Answer | null>): Start {
  return async (state, signers) => {
    const behind = await realServer(state, signers);
    const real: Call["real"] = async (method, path, body) => {
      const options = method === "POST" ? { method, headers: { "Content-Type": "application/json" }, body: body ?? "" } : {};
      const response = await fetch(`${behind.url}${path.slice(1)}`, options);
      return { status: response.status, text: await response.text() };
    };
    const front = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        const call = { method: request.method ?? "GET", path: request.url ?? "/", body: Buffer.concat(chunks).toString("utf8"), state, real };
        change(call)
          .then((answer) => answer ?? real(call.method, call.path, call.body))
          .then((answer) => {
            response.writeHead(answer.status, { "Content-Type": "application/json" });
            response.end(answer.text);
          });
      });
    });
    await new Promise<void>((done) => front.listen(0, "127.0.0.1", done));
    const address = front.address();
    const stop = async (): Promise<void> => {
      front.closeAllConnections();
      await new Promise<void>((done) => front.close(() => done()));
      await behind.stop();
    };
    return { url: `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}/`, stop };
  };
}

function requestIn(path: string, action: string): string | undefined {
  return new RegExp(`^/api/requests/([0-9a-f]{32})${action}$`).exec(path)?.[1];
}

// Broken on purpose: it puts every card of the request on the list, whatever was accepted on the page.
const listsEverythingSent = brokenServer(async ({ method, path, real }) => {
  const id = requestIn(path, "/options");
  if (method !== "POST" || id === undefined) return null;
  const shown = JSON.parse((await real("GET", `/api/requests/${id}`)).text) as { cards: { id: string; hash: string | null }[] };
  return real("POST", path, JSON.stringify({ accept: shown.cards.map((card) => ({ id: card.id, hash: card.hash })) }));
});

// Broken on purpose: it stores whatever signed list it is handed, without looking at its lines.
const takesAnySignedList = brokenServer(async ({ method, path, body, state }) => {
  const id = requestIn(path, "/signature");
  if (method !== "POST" || id === undefined) return null;
  const { manifest, signature } = JSON.parse(body) as { manifest: string; signature: string };
  writeFileSync(join(state, id, "manifest"), manifest);
  writeFileSync(join(state, id, "manifest.sig"), signature);
  return { status: 200, text: JSON.stringify({ stored: true, checked: "not checked" }) };
});

// Broken on purpose: it computes each hash once, when the cards arrive, and keeps it. What it shows
// later comes from the stored bytes, and the list to sign from the kept hashes.
const firstHashes = new Map<string, Map<string, string | null>>();
const keepsTheFirstHash = brokenServer(async ({ method, path, body, state, real }) => {
  if (method === "POST" && path === "/api/requests") {
    const answer = await real(method, path, body);
    const { id, list } = JSON.parse(answer.text) as { id?: string; list?: { id: string; hash: string | null }[] };
    if (id !== undefined) firstHashes.set(id, new Map((list ?? []).map((line) => [line.id, line.hash])));
    return answer;
  }
  const shownId = requestIn(path, "");
  const offeredId = requestIn(path, "/options");
  if (method === "GET" && shownId !== undefined) {
    const answer = await real(method, path);
    const shown = JSON.parse(answer.text) as { cards?: { id: string; hash: string | null }[] };
    for (const card of shown.cards ?? []) card.hash = firstHashes.get(shownId)?.get(card.id) ?? card.hash;
    return { status: answer.status, text: JSON.stringify(shown) };
  }
  if (method === "POST" && offeredId !== undefined) {
    const { accept } = JSON.parse(body) as { accept: { id: string }[] };
    const lines = accept.map((card) => `${card.id} ${firstHashes.get(offeredId)?.get(card.id)}\n`).sort();
    const manifest = `signed: ${new Date().toISOString()}\n${lines.join("")}`;
    writeFileSync(join(state, offeredId, "manifest"), manifest);
    return { status: 200, text: JSON.stringify({ manifest, challenge: challengeOf(manifest), rpId: RP_ID }) };
  }
  return null;
});

const world = newWorld();
after(() => removeWorld(world));

test("bite: believing the server about which list was signed fails the blocked case of a rewritten store", () => {
  return blockedStoreRewritten(realServer, believesTheList, world);
});
test("bite: believing the server about which list was signed fails the generated cases", () => {
  return noRewriteMakesAnUnsignedListVerify(realServer, believesTheList, world, firstSeed());
});
test("bite: a server that lists every card that was sent fails the blocked case of two accepted cards", () => {
  return blockedThirdCardNotAccepted(listsEverythingSent, realVerify, world);
});
test("bite: a server that takes any signed list fails the blocked case of a card it never held", () => {
  return blockedListWithAForeignCard(takesAnySignedList, world);
});
test("bite: a server that keeps the first hash fails the blocked case of bytes changed after the page showed them", () => {
  return blockedBytesChangedOnServer(keepsTheFirstHash, realVerify, world);
});
