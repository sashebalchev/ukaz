import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ID_PATTERN } from "./card.ts";

// An approval is a batch: laws/approvals/<name>.manifest with one line "<id> <hash>" per card,
// and <name>.manifest.sig, a detached SSH signature over the exact bytes of the manifest.

export const NAMESPACE = "laws";

export type Entry = { id: string; hash: string };

export type Approvals = {
  lines: Set<string>; // every "<id> <hash>" line of a manifest whose signature is good
  ids: Set<string>; // every id those manifests mention
  notes: string[]; // manifests that were ignored, and why
};

export function manifestText(entries: Entry[]): string {
  const sorted = [...entries].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return sorted.map((entry) => `${entry.id} ${entry.hash}\n`).join("");
}

export function parseManifest(text: string): Entry[] {
  if (text === "" || !text.endsWith("\n")) throw new Error("it is empty or does not end with a newline");
  const entries: Entry[] = [];
  let previous = "";
  for (const line of text.slice(0, -1).split("\n")) {
    const [id, hash, ...more] = line.split(" ");
    if (id === undefined || hash === undefined || more.length > 0) throw new Error(`"${line}" is not "<id> <hash>"`);
    if (!ID_PATTERN.test(id) || !/^[0-9a-f]{64}$/.test(hash)) throw new Error(`"${line}" is not "<id> <hash>"`);
    if (id <= previous) throw new Error("its lines are not sorted by id, or an id appears twice");
    previous = id;
    entries.push({ id, hash });
  }
  return entries;
}

// Only manifests with a good signature count. The others are listed in notes and otherwise ignored.
export function readApprovals(repo: string, signersFile: string): Approvals {
  const approvals: Approvals = { lines: new Set(), ids: new Set(), notes: [] };
  const folder = join(repo, "laws", "approvals");
  if (!existsSync(folder)) return approvals;

  for (const name of readdirSync(folder).sort()) {
    if (!name.endsWith(".manifest")) continue;
    const problem = readApproval(join(folder, name), signersFile, approvals);
    if (problem !== null) approvals.notes.push(`laws/approvals/${name} is ignored: ${problem}`);
  }
  return approvals;
}

function readApproval(manifestFile: string, signersFile: string, approvals: Approvals): string | null {
  const signatureFile = `${manifestFile}.sig`;
  if (!existsSync(signatureFile)) return "it has no .sig file";

  // Read once: the bytes that are checked against the signature are the bytes that are parsed.
  const bytes = readFileSync(manifestFile);
  let entries: Entry[];
  try {
    entries = parseManifest(bytes.toString("utf8"));
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  const problem = signatureProblem(bytes, signatureFile, signersFile);
  if (problem !== null) return problem;

  for (const entry of entries) {
    approvals.lines.add(`${entry.id} ${entry.hash}`);
    approvals.ids.add(entry.id);
  }
  return null;
}

// Returns null if the signature over these manifest bytes was made by a key in the signers file.
export function signatureProblem(manifest: Uint8Array, signatureFile: string, signersFile: string): string | null {
  const found = spawnSync("ssh-keygen", ["-Y", "find-principals", "-f", signersFile, "-s", signatureFile], {
    encoding: "utf8",
  });
  if (found.error !== undefined) return `ssh-keygen could not be run (${found.error.message}); install OpenSSH`;
  if (found.status !== 0) return `its signing key is not in ${signersFile}`;

  for (const principal of found.stdout.split("\n").filter((line) => line !== "")) {
    const verified = spawnSync(
      "ssh-keygen",
      ["-Y", "verify", "-f", signersFile, "-I", principal, "-n", NAMESPACE, "-s", signatureFile],
      { input: manifest, encoding: "utf8" },
    );
    if (verified.status === 0) return null;
  }
  return "its signature does not match the manifest";
}
