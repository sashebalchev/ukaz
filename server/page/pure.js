// The parts of the page that only compute. They touch no screen and no network, so the tests can run
// them under Node. app.js and register.js do the rest.

export function toBase64(bytes) {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

// base64url: "-" and "_" in place of "+" and "/", and no "=" at the end. Passkey data travels in it.
export function toBase64url(bytes) {
  return toBase64(bytes).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export function fromBase64url(text) {
  const binary = atob(text.replaceAll("-", "+").replaceAll("_", "/"));
  return Uint8Array.from(binary, (letter) => letter.charCodeAt(0));
}

export function toHex(bytes) {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// The address of the page may name one request: ?r=<32 hex digits>. Anything else names none.
export function requestIdFrom(search) {
  return /^\?r=([0-9a-f]{32})$/.exec(search)?.[1] ?? null;
}

// What the person decided so far. cards: [{ id, hash }]. decisions: id -> "accept" or "reject".
// accepted is what the server is asked to put on the list: each card with the hash that was shown.
export function decisionSummary(cards, decisions) {
  const accepted = [];
  let rejected = 0;
  let undecided = 0;
  for (const card of cards) {
    const decision = decisions.get(card.id);
    if (decision === "accept") accepted.push({ id: card.id, hash: card.hash });
    else if (decision === "reject") rejected += 1;
    else undecided += 1;
  }
  return { accepted, rejected, undecided, complete: undecided === 0 };
}

export function signLabel(count) {
  return count === 1 ? "Sign 1 card" : `Sign ${count} cards`;
}

export function formatBytes(count) {
  return count < 1024 ? `${count} bytes` : `${(count / 1024).toFixed(1)} KB`;
}

// Characters that show nothing or that turn the reading direction around. A text that has them may
// not read the way its bytes say. The count is shown as a warning next to the card.
export function hiddenCharacters(text) {
  return (text.match(/[­؜​-‏‪-‮⁠-⁩﻿]/g) ?? []).length;
}

// What the page posts after the passkey signed: the four parts of its answer, in base64url.
export function assertionBody(credential) {
  return {
    credentialId: toBase64url(credential.rawId),
    authenticatorData: toBase64url(credential.response.authenticatorData),
    clientDataJSON: toBase64url(credential.response.clientDataJSON),
    signature: toBase64url(credential.response.signature),
  };
}

// The line for the signers file that names a new passkey. publicKey is its usual DER form
// (SubjectPublicKeyInfo), which the browser gives with getPublicKey().
export function signersLine(name, origin, rpId, credentialId, publicKey) {
  return `${name} passkey origin="${origin}" rp="${rpId}" id=${toBase64url(credentialId)} ${toBase64(publicKey)}`;
}

// The name in a signers line: letters, digits and . _ @ -
export function isSignerName(name) {
  return /^[A-Za-z0-9][A-Za-z0-9._@-]*$/.test(name);
}

// The flags byte of the phone's data: was somebody there, was a finger or the screen lock checked,
// may the key be copied to other devices, and is it copied already.
export function flagsOf(authenticatorData) {
  const flags = new Uint8Array(authenticatorData)[32] ?? 0;
  return {
    present: (flags & 0x01) !== 0,
    verified: (flags & 0x04) !== 0,
    backupEligible: (flags & 0x08) !== 0,
    backedUp: (flags & 0x10) !== 0,
    hasKey: (flags & 0x40) !== 0,
  };
}

// The AAGUID: sixteen bytes that name the make of the device or app that holds the new key. It follows
// the first 37 bytes of the phone's data when a passkey is made. Null if it is not there.
export function aaguidOf(authenticatorData) {
  const data = new Uint8Array(authenticatorData);
  if (data.length < 53 || !flagsOf(data).hasKey) return null;
  const hex = toHex(data.subarray(37, 53));
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
