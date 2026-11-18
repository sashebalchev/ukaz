import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ID_PATTERN } from "./card.ts";
import { LawsError } from "./cards.ts";
import { isPasskeyLine, MAX_PASSKEY_FILE_BYTES, parsePasskeyLine, passkeyProblem } from "./passkey.ts";
import type { PasskeySigner } from "./passkey.ts";

// A signed batch is laws/approvals/<name>.manifest plus the proof that you approved it. The proof is one of:
//
//   <name>.manifest.sig     a detached SSH signature over the exact bytes of the manifest
//   <name>.passkey.json     a passkey signature from the phone over the hash of those bytes (see passkey.ts)
//
// The manifest reads:
//
//   signed: 2026-11-18T09:15:00.123Z      when it was signed; this is what orders the batches
//   T-01 <sha256 of the card>             the card is approved at this hash
//   T-03 retired                          the card is retired: its file may be removed
//
// The file name plays no part: it is not signed, so anyone could change it.

export const NAMESPACE = "laws";
const SSH_KEYGEN = "ssh-keygen";

// hash is null on a line that retires the card.
export type Entry = { id: string; hash: string | null };
export type Manifest = { time: string; entries: Entry[] };

export type Approvals = {
  live: Map<string, Set<string>>; // id -> the hashes approved since the id was last retired
  retired: Set<string>; // the ids whose newest signed line is a retirement
  newest: string; // the signed time of the newest good manifest, "" if there is none
  notes: string[]; // manifests that were ignored, and why
};

export function manifestText(time: string, entries: Entry[]): string {
  const sorted = [...entries].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return `signed: ${time}\n${sorted.map((entry) => `${entry.id} ${entry.hash ?? "retired"}\n`).join("")}`;
}

export function parseManifest(text: string): Manifest {
  if (!text.endsWith("\n")) throw new Error("it does not end with a newline");
  const [first, ...lines] = text.slice(0, -1).split("\n");
  const time = /^signed: (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)$/.exec(first ?? "")?.[1];
  if (time === undefined) throw new Error('its first line is not "signed: <UTC time>"');
  if (lines.length === 0) throw new Error("it names no card");

  const entries: Entry[] = [];
  let previous = "";
  for (const line of lines) {
    const [id, word, ...more] = line.split(" ");
    if (id === undefined || word === undefined || more.length > 0 || !ID_PATTERN.test(id)) {
      throw new Error(`"${line}" is not "<id> <hash>" or "<id> retired"`);
    }
    if (word !== "retired" && !/^[0-9a-f]{64}$/.test(word)) {
      throw new Error(`"${line}" is not "<id> <hash>" or "<id> retired"`);
    }
    if (id <= previous) throw new Error("its lines are not sorted by id, or an id appears twice");
    previous = id;
    entries.push({ id, hash: word === "retired" ? null : word });
  }
  return { time, entries };
}

// The signers file, read once. It has two kinds of lines. A line whose second word is "passkey" names a
// passkey, and this tool reads it itself. Every other line is an SSH allowed-signers line and is left to
// ssh-keygen. If there are passkey lines, ssh-keygen gets a private copy of the file without them.
export type Signers = { file: string; sshFile: string; passkeys: PasskeySigner[]; close: () => void };

export function openSigners(signersFile: string): Signers {
  const lines = readFileSync(signersFile, "utf8").split("\n");
  const passkeys: PasskeySigner[] = [];
  const forSsh = lines.map((line, index) => {
    if (!isPasskeyLine(line)) return line;
    try {
      passkeys.push(parsePasskeyLine(line));
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      throw new LawsError(`line ${index + 1} of the signers file ${signersFile} is not a good passkey line: ${why}.`);
    }
    return ""; // an empty line, so that the line numbers stay the same
  });
  if (passkeys.length === 0) return { file: signersFile, sshFile: signersFile, passkeys, close: () => {} };

  const folder = mkdtempSync(join(tmpdir(), "laws-signers-"));
  const sshFile = join(folder, "allowed_signers");
  writeFileSync(sshFile, forSsh.join("\n"), { mode: 0o600 });
  return { file: signersFile, sshFile, passkeys, close: () => rmSync(folder, { recursive: true, force: true }) };
}

// Only manifests with a good signature count. The others are listed in notes and otherwise ignored.
export function readApprovals(repo: string, signersFile: string): Approvals {
  const notes: string[] = [];
  const good: Manifest[] = [];
  const folder = join(repo, "laws", "approvals");
  const names = existsSync(folder) ? readdirSync(folder).sort() : [];
  const signers = openSigners(signersFile);
  try {
    for (const name of names.filter((candidate) => candidate.endsWith(".manifest"))) {
      const manifest = readSignedManifest(join(folder, name), signers);
      if (typeof manifest === "string") notes.push(`laws/approvals/${name} is ignored: ${manifest}`);
      else good.push(manifest);
    }
  } finally {
    signers.close();
  }

  // A retirement ends every approval signed up to that moment. An approval counts if it is later.
  const lastRetired = new Map<string, string>();
  for (const manifest of good) {
    for (const entry of manifest.entries) {
      if (entry.hash === null && manifest.time > (lastRetired.get(entry.id) ?? "")) lastRetired.set(entry.id, manifest.time);
    }
  }
  const live = new Map<string, Set<string>>();
  for (const manifest of good) {
    for (const entry of manifest.entries) {
      if (entry.hash === null || manifest.time <= (lastRetired.get(entry.id) ?? "")) continue;
      const hashes = live.get(entry.id) ?? new Set<string>();
      hashes.add(entry.hash);
      live.set(entry.id, hashes);
    }
  }
  const retired = new Set([...lastRetired.keys()].filter((id) => !live.has(id)));
  const newest = good.reduce((latest, manifest) => (manifest.time > latest ? manifest.time : latest), "");
  return { live, retired, newest, notes };
}

// The passkey proof of laws/approvals/<name>.manifest is <name>.passkey.json.
export function passkeyFileOf(manifestFile: string): string {
  return `${manifestFile.slice(0, -".manifest".length)}.passkey.json`;
}

// Returns the manifest, or the reason why it does not count. One good proof is enough.
function readSignedManifest(manifestFile: string, signers: Signers): Manifest | string {
  const signatureFile = `${manifestFile}.sig`;
  const passkeyFile = passkeyFileOf(manifestFile);
  const hasSignature = existsSync(signatureFile);
  const hasPasskey = existsSync(passkeyFile);
  if (!hasSignature && !hasPasskey) return "it has no .sig file and no .passkey.json file";

  // Read once: the bytes that are checked against the signature are the bytes that are parsed.
  const bytes = readFileSync(manifestFile);
  let manifest: Manifest;
  try {
    manifest = parseManifest(bytes.toString("utf8"));
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  const problems: string[] = [];
  if (hasSignature) {
    const problem = sshProblem(bytes, signatureFile, signers);
    if (problem === null) return manifest;
    problems.push(problem);
  }
  if (hasPasskey) {
    const problem = passkeyFileProblem(bytes, passkeyFile, signers);
    if (problem === null) return manifest;
    problems.push(problem);
  }
  return problems.join("; and ");
}

// Returns null if the signature over these manifest bytes was made by a key in the signers file.
export function signatureProblem(manifest: Uint8Array, signatureFile: string, signersFile: string): string | null {
  const signers = openSigners(signersFile);
  try {
    return sshProblem(manifest, signatureFile, signers);
  } finally {
    signers.close();
  }
}

// Returns null if the passkey file approves these manifest bytes with a passkey from the signers file.
export function passkeyFileProblem(manifest: Uint8Array, passkeyFile: string, signers: Signers): string | null {
  let bytes: Buffer;
  try {
    bytes = readFileSync(passkeyFile);
  } catch {
    return "its .passkey.json file cannot be read";
  }
  if (bytes.length > MAX_PASSKEY_FILE_BYTES) return "its .passkey.json file is larger than 16 KB";
  return passkeyProblem(manifest, bytes.toString("utf8"), signers.passkeys, signers.file);
}

function sshProblem(manifest: Uint8Array, signatureFile: string, signers: Signers): string | null {
  const found = spawnSync(SSH_KEYGEN, ["-Y", "find-principals", "-f", signers.sshFile, "-s", signatureFile], {
    encoding: "utf8",
  });
  if (found.error !== undefined) return `ssh-keygen could not be run (${found.error.message}); install OpenSSH`;
  if (found.status !== 0) return `its signing key is not in ${signers.file}`;

  for (const principal of found.stdout.split("\n").filter((line) => line !== "")) {
    const verified = spawnSync(
      SSH_KEYGEN,
      ["-Y", "verify", "-f", signers.sshFile, "-I", principal, "-n", NAMESPACE, "-s", signatureFile],
      { input: manifest, encoding: "utf8" },
    );
    if (verified.status === 0) return null;
  }
  return "its signature does not match the manifest";
}
