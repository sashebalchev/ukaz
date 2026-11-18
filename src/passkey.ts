import { createHash, createPublicKey, verify } from "node:crypto";
import type { KeyObject } from "node:crypto";

// A phone approval is laws/approvals/<name>.manifest plus <name>.passkey.json. The second file holds a
// WebAuthn assertion: the answer of a passkey when a web page asks it for a signature. It has four parts,
// each written in base64url:
//
//   credentialId        which passkey answered
//   authenticatorData   written by the phone: the site the passkey belongs to, and whether the phone
//                       checked a finger or the screen lock
//   clientDataJSON      written by the browser: the web address of the page, and the challenge
//   signature           by the passkey, over authenticatorData followed by sha256(clientDataJSON)
//
// The challenge is the hash of the manifest. So the signature names one exact list, one web address, and
// says that a person was checked. This file only checks such answers. It cannot make one.

// The challenge for a manifest: base64url(sha256("laws manifest v1\n" + the manifest bytes)).
// The first line keeps a signature made for anything else from counting here.
export const CHALLENGE_PREFIX = "laws manifest v1\n";
export const MAX_PASSKEY_FILE_BYTES = 16 * 1024;

const FIELDS = ["credentialId", "authenticatorData", "clientDataJSON", "signature"] as const;
type Field = (typeof FIELDS)[number];
// A P-256 signature in DER form has at most 72 bytes. The other limits are generous.
const MAX_BYTES: Record<Field, number> = { credentialId: 1023, authenticatorData: 1024, clientDataJSON: 4096, signature: 72 };

const USER_PRESENT = 0x01; // the phone says: somebody touched it
const USER_VERIFIED = 0x04; // the phone says: it checked a finger, a face or the screen lock

export type PasskeyApproval = Record<Field, Buffer>;

// One passkey line of the signers file.
export type PasskeySigner = {
  name: string;
  origin: string; // the web address where the passkey may approve, for example https://pi.example.ts.net
  rpId: string; // the site the passkey was made for ("relying party id"), a host name
  credentialId: string; // base64url
  key: KeyObject; // the public key
};

export function challengeFor(manifest: Uint8Array): string {
  return createHash("sha256").update(CHALLENGE_PREFIX).update(manifest).digest("base64url");
}

// A passkey line in the signers file has "passkey" as its second word:
//
//   alex passkey origin="https://pi.example.ts.net" rp="pi.example.ts.net" id=<credential id> <public key>
//
// The credential id is base64url. The public key is base64 of its usual DER form (SubjectPublicKeyInfo),
// which is what the registration page shows. Only P-256 keys are accepted (the "ES256" kind of passkey).
export function isPasskeyLine(line: string): boolean {
  return /^\S+[ \t]+passkey([ \t]|$)/.test(line);
}

const LINE = /^([A-Za-z0-9][A-Za-z0-9._@-]*) passkey origin="([^"\s]*)" rp="([^"\s]*)" id=([A-Za-z0-9_-]+) ([A-Za-z0-9+/]+={0,2})$/;
const HOST = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/;

// Throws an Error that says what is wrong with the line.
export function parsePasskeyLine(line: string): PasskeySigner {
  const parts = LINE.exec(line);
  if (parts === null) {
    throw new Error('it is not: <name> passkey origin="<https address>" rp="<host>" id=<credential id> <public key>');
  }
  const [, name = "", origin = "", rpId = "", credentialId = "", keyText = ""] = parts;

  const host = /^https:\/\/([^:/]+)(:[0-9]{1,5})?$/.exec(origin)?.[1] ?? "";
  if (!HOST.test(host)) {
    throw new Error(`origin "${origin}" must be https://<host> or https://<host>:<port>, with nothing after it`);
  }
  if (!HOST.test(rpId)) throw new Error(`rp "${rpId}" must be a host name in small letters`);
  if (host !== rpId && !host.endsWith(`.${rpId}`)) throw new Error(`rp "${rpId}" is not the host of ${origin} or a parent of it`);
  decodeBase64url("id", credentialId, MAX_BYTES.credentialId);

  const der = Buffer.from(keyText, "base64");
  if (der.toString("base64") !== keyText) throw new Error("the public key is not plain base64");
  let key: KeyObject;
  try {
    key = createPublicKey({ key: der, format: "der", type: "spki" });
  } catch {
    throw new Error("the public key cannot be read");
  }
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
    throw new Error("the public key is not a P-256 key; only ES256 passkeys are accepted");
  }
  if (!key.export({ format: "der", type: "spki" }).equals(der)) throw new Error("the public key is not in its usual form");
  return { name, origin, rpId, credentialId, key };
}

// The signers file has two kinds of lines. Returns the passkeys it names, and the file's text without
// their lines: each one is replaced by an empty line, so that the line numbers stay the same.
export function splitSigners(text: string): { passkeys: PasskeySigner[]; withoutPasskeys: string } {
  const passkeys: PasskeySigner[] = [];
  const others = text.split("\n").map((line, index) => {
    if (!isPasskeyLine(line)) return line;
    try {
      passkeys.push(parsePasskeyLine(line));
    } catch (error) {
      throw new Error(`line ${index + 1} is not a good passkey line: ${error instanceof Error ? error.message : String(error)}`);
    }
    return "";
  });
  return { passkeys, withoutPasskeys: others.join("\n") };
}

// The sha256 of the public key as the signers line gives it, in hex. The registration page shows the
// same number, so the two can be compared by eye.
export function keyFingerprint(signer: PasskeySigner): string {
  return createHash("sha256").update(signer.key.export({ format: "der", type: "spki" })).digest("hex");
}

// The one way a <name>.passkey.json file is written.
export function passkeyApprovalText(approval: PasskeyApproval): string {
  const fields = Object.fromEntries(FIELDS.map((field) => [field, approval[field].toString("base64url")]));
  return `${JSON.stringify(fields, null, 2)}\n`;
}

// Reads the text of a <name>.passkey.json file. Strict: exactly the four fields, clean base64url, sizes
// within the limits, and the one spelling that passkeyApprovalText writes.
export function parsePasskeyApproval(text: string): PasskeyApproval {
  if (text.length > MAX_PASSKEY_FILE_BYTES) throw new Error("it is larger than 16 KB");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("it is not JSON");
  }
  const approval = readPasskeyFields(value);
  if (text !== passkeyApprovalText(approval)) throw new Error("it is not written the one way this tool writes it");
  return approval;
}

// The same four fields from a value that was already read as JSON, for example the body of a request.
export function readPasskeyFields(value: unknown): PasskeyApproval {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("it is not a JSON object");
  const record = value as Record<string, unknown>;
  const unknown = Object.keys(record).find((key) => !FIELDS.some((field) => field === key));
  if (unknown !== undefined) throw new Error(`it has an unknown field "${unknown}"`);
  const read = (field: Field): Buffer => {
    const text = record[field];
    if (typeof text !== "string") throw new Error(`the field "${field}" is missing or is not a text`);
    return decodeBase64url(field, text, MAX_BYTES[field]);
  };
  return {
    credentialId: read("credentialId"),
    authenticatorData: read("authenticatorData"),
    clientDataJSON: read("clientDataJSON"),
    signature: read("signature"),
  };
}

function decodeBase64url(what: string, text: string, maxBytes: number): Buffer {
  if (text === "") throw new Error(`"${what}" is empty`);
  if (text.length > Math.ceil((maxBytes * 4) / 3)) throw new Error(`"${what}" is longer than ${maxBytes} bytes`);
  if (!/^[A-Za-z0-9_-]+$/.test(text)) throw new Error(`"${what}" is not base64url`);
  const bytes = Buffer.from(text, "base64url");
  if (bytes.toString("base64url") !== text) throw new Error(`"${what}" is not clean base64url`);
  return bytes;
}

// Returns null if the passkey file is an approval of exactly these manifest bytes by a passkey that the
// signers file lists. Otherwise the reason, worded to follow "the manifest is ignored: ".
export function passkeyProblem(manifest: Uint8Array, approvalText: string, signers: PasskeySigner[], signersFile: string): string | null {
  let approval: PasskeyApproval;
  try {
    approval = parsePasskeyApproval(approvalText);
  } catch (error) {
    return `its .passkey.json file is not valid: ${error instanceof Error ? error.message : String(error)}`;
  }
  const id = approval.credentialId.toString("base64url");
  const listed = signers.filter((signer) => signer.credentialId === id);
  if (listed.length === 0) return `its passkey is not in ${signersFile}`;
  const problems = listed.map((signer) => assertionProblem(manifest, approval, signer));
  return problems.includes(null) ? null : (problems[0] ?? null);
}

// Every test below is required. Returns null only if all of them pass for this signers line.
export function assertionProblem(manifest: Uint8Array, approval: PasskeyApproval, signer: PasskeySigner): string | null {
  let client: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(approval.clientDataJSON));
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("not an object");
    client = value as Record<string, unknown>;
  } catch {
    return "the browser's part of its passkey signature cannot be read";
  }
  // The browser writes what the page asked for. "webauthn.get" is a signature, "webauthn.create" a new passkey.
  if (client["type"] !== "webauthn.get") return "its passkey file is not the answer to a request for a signature";
  if (client["challenge"] !== challengeFor(manifest)) return "its passkey signature was made for another list, not for this manifest";
  if (client["origin"] !== signer.origin) {
    return `its passkey signature was made at another web address than ${signer.origin}`;
  }
  // A page inside a frame of another site. Browsers leave the field out or write false.
  if (client["crossOrigin"] !== undefined && client["crossOrigin"] !== false) {
    return "its passkey signature was made inside a frame of another site";
  }

  const data = approval.authenticatorData;
  if (data.length < 37) return "the phone's part of its passkey signature is too short";
  const site = createHash("sha256").update(signer.rpId).digest();
  if (!data.subarray(0, 32).equals(site)) return `its passkey signature was made for another site than ${signer.rpId}`;
  const flags = data[32] ?? 0;
  if ((flags & USER_PRESENT) === 0) return "the phone does not say that a person was there";
  if ((flags & USER_VERIFIED) === 0) return "the phone did not check a finger or the screen lock for its passkey signature";

  // The passkey signs the phone's part followed by the hash of the browser's part. ES256: P-256, sha256, DER.
  const signedBytes = Buffer.concat([data, createHash("sha256").update(approval.clientDataJSON).digest()]);
  let good: boolean;
  try {
    good = verify("sha256", signedBytes, { key: signer.key, dsaEncoding: "der" }, approval.signature);
  } catch {
    good = false;
  }
  return good ? null : "its passkey signature does not match";
}
