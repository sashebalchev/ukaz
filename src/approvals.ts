import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ID_PATTERN } from "./card.ts";

// A signed batch is laws/approvals/<name>.manifest plus <name>.manifest.sig, a detached SSH signature
// over the exact bytes of the manifest. The manifest reads:
//
//   signed: 2026-11-18T09:15:00.123Z      when the signer signed it; this is what orders the batches
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

// Only manifests with a good signature count. The others are listed in notes and otherwise ignored.
export function readApprovals(repo: string, signersFile: string): Approvals {
  const notes: string[] = [];
  const good: Manifest[] = [];
  const folder = join(repo, "laws", "approvals");
  const names = existsSync(folder) ? readdirSync(folder).sort() : [];
  for (const name of names.filter((candidate) => candidate.endsWith(".manifest"))) {
    const manifest = readSignedManifest(join(folder, name), signersFile);
    if (typeof manifest === "string") notes.push(`laws/approvals/${name} is ignored: ${manifest}`);
    else good.push(manifest);
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

// Returns the manifest, or the reason why it does not count.
function readSignedManifest(manifestFile: string, signersFile: string): Manifest | string {
  const signatureFile = `${manifestFile}.sig`;
  if (!existsSync(signatureFile)) return "it has no .sig file";

  // Read once: the bytes that are checked against the signature are the bytes that are parsed.
  const bytes = readFileSync(manifestFile);
  let manifest: Manifest;
  try {
    manifest = parseManifest(bytes.toString("utf8"));
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return signatureProblem(bytes, signatureFile, signersFile) ?? manifest;
}

// Returns null if the signature over these manifest bytes was made by a key in the signers file.
export function signatureProblem(manifest: Uint8Array, signatureFile: string, signersFile: string): string | null {
  const found = spawnSync(SSH_KEYGEN, ["-Y", "find-principals", "-f", signersFile, "-s", signatureFile], {
    encoding: "utf8",
  });
  if (found.error !== undefined) return `ssh-keygen could not be run (${found.error.message}); install OpenSSH`;
  if (found.status !== 0) return `its signing key is not in ${signersFile}`;

  for (const principal of found.stdout.split("\n").filter((line) => line !== "")) {
    const verified = spawnSync(
      SSH_KEYGEN,
      ["-Y", "verify", "-f", signersFile, "-I", principal, "-n", NAMESPACE, "-s", signatureFile],
      { input: manifest, encoding: "utf8" },
    );
    if (verified.status === 0) return null;
  }
  return "its signature does not match the manifest";
}
