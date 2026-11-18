// Helpers for the ordinary tests. The law tests in test/laws/ do not use this file: each of them is
// frozen with its card and carries everything it needs.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const CLI = join(import.meta.dirname, "../src/cli.ts");
export const SIGNER = join(import.meta.dirname, "../signer/signer.ts");

// A temporary folder with an empty repository, a throwaway key, the signers file that names it, and a
// signer command. The signer needs a person at a terminal, so the command is a stand-in: it runs the
// real signer with that key and types the word that the signer asks for.
export type World = { folder: string; repo: string; signers: string; key: string; signerCommand: string; log: string };

export type Printed = { exitCode: number | null; printed: string };

export function withWorld(body: (world: World) => void | Promise<void>): () => Promise<void> {
  return async () => {
    const folder = mkdtempSync(join(tmpdir(), "laws-test-"));
    try {
      const key = join(folder, "key");
      const log = join(folder, "signer.log");
      const standIn = join(folder, "signer-with-a-person.mjs");
      const typesTheWord = "process.exitCode = runSigner(process.argv.slice(2), (word) => word, (line) => console.log(line));";
      writeFileSync(standIn, `import { runSigner } from ${JSON.stringify(SIGNER)};\n${typesTheWord}\n`);
      const world = {
        folder,
        repo: join(folder, "repo"),
        signers: join(folder, "allowed_signers"),
        key,
        signerCommand: `'${process.execPath}' '${standIn}' --key '${key}' --log '${log}'`,
        log,
      };
      mkdirSync(join(world.repo, "laws"), { recursive: true });
      const made = spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key], { encoding: "utf8" });
      assert.equal(made.status, 0, `ssh-keygen failed: ${made.stderr}`);
      writeFileSync(world.signers, `owner ${readFileSync(`${key}.pub`, "utf8")}`);
      await body(world);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  };
}

export function writeCard(world: World, id: string, frontMatter: string[], body = `# ${id} A law\n`): void {
  writeFileSync(join(world.repo, "laws", `${id}.md`), `---\nid: ${id}\n${frontMatter.join("\n")}\n---\n${body}`);
}

// Runs the laws command with exactly these words. LAWS_SIGNERS and LAWS_SIGNER are unset unless given.
export function lawsRaw(words: string[], environment: Record<string, string> = {}): Printed {
  const env = { ...process.env, LAWS_SIGNERS: undefined, LAWS_SIGNER: undefined, ...environment };
  const result = spawnSync(process.execPath, [CLI, ...words], { encoding: "utf8", env });
  return { exitCode: result.status, printed: result.stdout + result.stderr };
}

// Runs the laws command on the world's repository with the world's signers file.
export function laws(world: World, words: string[]): Printed {
  return lawsRaw([...words, "--repo", world.repo, "--signers", world.signers]);
}

// A card that can be signed: its bite fails and prints what the card says it prints.
export const GOOD = [
  "grade: chosen",
  "check: true",
  "bite: echo the blocked case was caught; exit 1",
  "bite-says: the blocked case was caught",
];

// Approves cards through the signer. With no ids: every card that is waiting or changed.
export function signCards(world: World, ids: string[] = []): Printed {
  return laws(world, ["sign", ...ids, "--signer", world.signerCommand]);
}

export function retireCards(world: World, ids: string[]): Printed {
  return laws(world, ["retire", ...ids, "--signer", world.signerCommand]);
}

// A software passkey: it does with a key in memory what a phone does with the key in its chip.
export type Phone = { origin: string; rpId: string; credentialId: Buffer; privateKey: KeyObject; publicKey: KeyObject };
export type PhoneAnswer = { credentialId: string; authenticatorData: string; clientDataJSON: string; signature: string };

export function newPhone(origin = "https://laws.example.test", rpId = "laws.example.test"): Phone {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return { origin, rpId, credentialId: randomBytes(16), privateKey, publicKey };
}

// What the phone and its browser answer when a page asks for a signature over this challenge.
// verified: the phone checked a finger or the screen lock. The four parts are base64url, as the page posts them.
export function phoneSigns(phone: Phone, challenge: string, verified = true): PhoneAnswer {
  const sha256 = (data: string | Uint8Array): Buffer => createHash("sha256").update(data).digest();
  const clientDataJSON = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge, origin: phone.origin, crossOrigin: false }));
  const authenticatorData = Buffer.concat([sha256(phone.rpId), Buffer.from([verified ? 0x05 : 0x01, 0, 0, 0, 0])]);
  const signedBytes = Buffer.concat([authenticatorData, sha256(clientDataJSON)]);
  const signature = sign("sha256", signedBytes, { key: phone.privateKey, dsaEncoding: "der" });
  return {
    credentialId: phone.credentialId.toString("base64url"),
    authenticatorData: authenticatorData.toString("base64url"),
    clientDataJSON: clientDataJSON.toString("base64url"),
    signature: signature.toString("base64url"),
  };
}

// The line of the signers file that names this passkey.
export function passkeyLine(phone: Phone, name = "alex"): string {
  const key = phone.publicKey.export({ format: "der", type: "spki" }).toString("base64");
  return `${name} passkey origin="${phone.origin}" rp="${phone.rpId}" id=${phone.credentialId.toString("base64url")} ${key}\n`;
}
