// The bite of law T-10: the same property as the check, run against ways to verify that are broken on purpose.
// Every test in this file must FAIL. If one passes, the check of T-10 has lost its teeth.

import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { parseManifest } from "../../src/approvals.ts";
import { loadCards } from "../../src/cards.ts";
import { readLawbook } from "../../src/verify.ts";
import {
  blockedAnotherAddress,
  blockedAnotherSite,
  blockedSignatureForAnotherList,
  blockedUnlistedPasskey,
  blockedWithoutFingerOrLock,
  challengeOf,
  firstSeed,
  newWorld,
  onlyUntouchedPhoneApprovalsCount,
  refusesSloppyFiles,
  removeWorld,
} from "./t10-passkey.test.ts";
import type { Verify } from "./t10-passkey.test.ts";

type Test = "the list" | "the finger" | "the address" | "the site" | "nothing";

// Broken on purpose: a small way of its own to verify phone approvals. It checks that the signature is
// a real one from a passkey in the signers file, and leaves out the one test it is told to forget.
// It also reads the passkey file loosely: any JSON, any kind of base64.
function forgets(forgotten: Test): Verify {
  return (repo, signersFile) => {
    const listed = [...readFileSync(signersFile, "utf8").matchAll(/^\S+ passkey origin="([^"]*)" rp="([^"]*)" id=(\S+) (\S+)$/gm)];
    const folder = join(repo, "laws", "approvals");
    const approved = new Set<string>();
    for (const name of readdirSync(folder).filter((file) => file.endsWith(".manifest"))) {
      const passkeyFile = join(folder, name.replace(/\.manifest$/, ".passkey.json"));
      if (!existsSync(passkeyFile)) continue;
      const manifest = readFileSync(join(folder, name), "utf8");
      try {
        const fields = JSON.parse(readFileSync(passkeyFile, "utf8")) as Record<string, string>;
        const part = (field: string): Buffer => Buffer.from(String(fields[field]), "base64url");
        const id = part("credentialId").toString("base64url");
        const [, origin, site, , key] = listed.find((line) => line[3] === id) ?? [];
        if (key === undefined || site === undefined) continue;
        const client = JSON.parse(part("clientDataJSON").toString("utf8")) as Record<string, unknown>;
        const data = part("authenticatorData");
        if (client["type"] !== "webauthn.get") continue;
        if (forgotten !== "the list" && client["challenge"] !== challengeOf(manifest)) continue;
        if (forgotten !== "the address" && (client["origin"] !== origin || client["crossOrigin"] === true)) continue;
        if (forgotten !== "the site" && !data.subarray(0, 32).equals(createHash("sha256").update(site).digest())) continue;
        if (forgotten !== "the finger" && ((data[32] ?? 0) & 0x05) !== 0x05) continue;
        const signedBytes = Buffer.concat([data, createHash("sha256").update(part("clientDataJSON")).digest()]);
        const publicKey = createPublicKey({ key: Buffer.from(key, "base64"), format: "der", type: "spki" });
        if (!verifySignature("sha256", signedBytes, { key: publicKey, dsaEncoding: "der" }, part("signature"))) continue;
        for (const entry of parseManifest(manifest).entries) approved.add(`${entry.id} ${entry.hash}`);
      } catch {
        continue; // a file that cannot be read approves nothing
      }
    }
    return loadCards(repo).every((card) => card.ok && approved.has(`${card.id} ${card.hash}`));
  };
}

// Broken on purpose: if the repository carries its own signers file, that one is trusted.
const trustsTheRepository: Verify = (repo, signersFile) => {
  const inside = join(repo, "laws", "allowed_signers");
  const book = readLawbook(repo, existsSync(inside) ? inside : signersFile);
  return book.states.every((card) => card.state === "approved");
};

const world = newWorld();
after(() => removeWorld(world));

test("bite: forgetting which list was signed fails the blocked case", () => {
  blockedSignatureForAnotherList(forgets("the list"), world);
});
test("bite: forgetting which list was signed fails the generated cases", () => {
  onlyUntouchedPhoneApprovalsCount(forgets("the list"), world, firstSeed());
});
test("bite: forgetting the finger fails the blocked case", () => {
  blockedWithoutFingerOrLock(forgets("the finger"), world);
});
test("bite: forgetting the finger fails the generated cases", () => {
  onlyUntouchedPhoneApprovalsCount(forgets("the finger"), world, firstSeed());
});
test("bite: forgetting the web address fails the blocked case", () => {
  blockedAnotherAddress(forgets("the address"), world);
});
test("bite: forgetting the web address fails the generated cases", () => {
  onlyUntouchedPhoneApprovalsCount(forgets("the address"), world, firstSeed());
});
test("bite: forgetting the site that the phone names fails", () => {
  blockedAnotherSite(forgets("the site"), world);
});
test("bite: trusting a signers file inside the repository fails the blocked case of an unlisted passkey", () => {
  blockedUnlistedPasskey(trustsTheRepository, world);
});
test("bite: reading the passkey file loosely fails", () => {
  refusesSloppyFiles(forgets("nothing"), world);
});
