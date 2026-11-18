import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { manifestText, parseManifest, signatureProblem } from "./approvals.ts";
import type { Entry } from "./approvals.ts";
import { teethOf } from "./bite.ts";
import { LawsError } from "./cards.ts";
import type { GoodCard } from "./cards.ts";
import { readLawbook, resolveSigners } from "./verify.ts";
import type { Lawbook } from "./verify.ts";

export type SignRequest = {
  repo: string;
  ids: string[];
  signerCommand: string | null;
  signersFlag: string | null;
};

// laws sign: asks the separate signer program to approve cards, checks what comes back, and only then
// stores it under laws/approvals/. With no ids it takes every card that is waiting or changed.
// This program holds no key and makes no signature. Returns the exit code.
export async function signCommand(request: SignRequest, print: (line: string) => void): Promise<number> {
  const { repo } = request;
  const signerCommand = signerOf(request);
  const signersFile = resolveSigners(repo, request.signersFlag);
  const book = readLawbook(repo, signersFile);
  const picked = pickCards(book, request.ids);
  if (picked.length === 0) {
    print("nothing to sign: no card is waiting or changed");
    return 0;
  }

  let toothless = 0;
  for (const card of picked) {
    const teeth = await teethOf(repo, card);
    print(`${card.id}  ${teeth.summary}`);
    if (!teeth.bites) toothless += 1;
  }
  if (toothless > 0) {
    print("refusing: a toothless card is not offered for signing. Nothing was signed.");
    return 1;
  }

  const entries = picked.map((card) => ({ id: card.id, hash: card.hash }));
  const name = askSigner(repo, signersFile, signerCommand, entries, book.newest);
  print(`approved ${picked.map((card) => card.id).join(", ")}: stored laws/approvals/${name}.manifest and .manifest.sig`);
  return 0;
}

// laws retire: asks the signer to retire cards. A card must still be there when it is retired, so that
// the signer can show its title. After that its file can be removed. Returns the exit code.
export function retireCommand(request: SignRequest, print: (line: string) => void): number {
  const { repo } = request;
  if (request.ids.length === 0) throw new LawsError("usage: laws retire <id>...");
  const signerCommand = signerOf(request);
  const signersFile = resolveSigners(repo, request.signersFlag);
  const book = readLawbook(repo, signersFile);
  const ids = [...new Set(request.ids)].sort();
  for (const id of ids) {
    if (book.cards.some((card) => card.id === id && card.ok)) continue;
    throw new LawsError(
      `laws/${id}.md is missing or broken. A card must still be there when it is retired, so that the signer can show its title.`,
    );
  }

  const name = askSigner(repo, signersFile, signerCommand, ids.map((id) => ({ id, hash: null })), book.newest);
  print(`retired ${ids.join(", ")}: stored laws/approvals/${name}.manifest and .manifest.sig`);
  print(`You can now remove ${ids.map((id) => `laws/${id}.md`).join(", ")}.`);
  return 0;
}

function signerOf(request: SignRequest): string {
  const signerCommand = request.signerCommand ?? process.env["LAWS_SIGNER"] ?? "";
  if (signerCommand === "") {
    throw new LawsError(
      'no signer: pass --signer "<command>" or set LAWS_SIGNER, for example ' +
        '--signer "sudo laws-signer --key /root/laws/key --log /var/log/laws-signer.log". Nothing was written.',
    );
  }
  return signerCommand;
}

function pickCards(book: Lawbook, ids: string[]): GoodCard[] {
  const unsigned = book.states.filter((card) => ["waiting", "changed", "broken"].includes(card.state));
  const wanted = ids.length > 0 ? [...new Set(ids)].sort() : unsigned.map((card) => card.id);
  return wanted.map((id) => cardOf(book, id));
}

function cardOf(book: Lawbook, id: string): GoodCard {
  const card = book.cards.find((candidate) => candidate.id === id);
  if (card === undefined) throw new LawsError(`there is no card ${id} in laws/.`);
  if (!card.ok) throw new LawsError(`${id} cannot be signed, the card is broken: ${card.problem}`);
  return card;
}

// Hands the list to the signer command, checks what comes back, and stores it. Returns the stored name.
// The signer command gets: --repo <repo> --out <folder> <id>... --retire <id>...
// and leaves the files manifest and manifest.sig in that folder.
function askSigner(repo: string, signersFile: string, signerCommand: string, entries: Entry[], newest: string): string {
  const out = mkdtempSync(join(tmpdir(), "laws-sign-"));
  try {
    chmodSync(out, 0o700); // private to this user, whatever the defaults are
    const asked = entries.flatMap((entry) => (entry.hash === null ? ["--retire", entry.id] : [entry.id]));
    const words = ["--repo", repo, "--out", out, ...asked];
    const signer = spawnSync("sh", ["-c", `${signerCommand} "$@"`, "signer", ...words], { stdio: "inherit" });
    if (signer.status !== 0) throw new LawsError("the signer did not sign. Nothing was stored.");

    const manifest = readBack(join(out, "manifest"));
    const signature = readBack(join(out, "manifest.sig"));
    const text = manifest.toString("utf8");
    let time: string;
    try {
      time = parseManifest(text).time;
    } catch {
      throw new LawsError("what the signer returned is not a manifest. Nothing was stored.");
    }
    if (text !== manifestText(time, entries)) {
      throw new LawsError("the signer returned a different list than it was asked to sign. Nothing was stored.");
    }
    if (time <= newest) {
      throw new LawsError(
        `the signer dated its signature ${time}, which is not later than the newest one here (${newest}). ` +
          "Check the clock of the signer. Nothing was stored.",
      );
    }
    const problem = signatureProblem(manifest, join(out, "manifest.sig"), signersFile);
    if (problem !== null) throw new LawsError(`the signature that came back is not accepted: ${problem}. Nothing was stored.`);

    return store(repo, time, manifest, signature);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

function readBack(file: string): Buffer {
  try {
    return readFileSync(file);
  } catch {
    throw new LawsError(`the signer left no ${file}. Nothing was stored.`);
  }
}

// The file is named after the signed time, for example 20261118T091500.123Z.manifest.
function store(repo: string, time: string, manifest: Uint8Array, signature: Uint8Array): string {
  const folder = join(repo, "laws", "approvals");
  const name = time.replace(/[-:]/g, "");
  const manifestFile = join(folder, `${name}.manifest`);
  if (existsSync(manifestFile)) {
    throw new LawsError(`laws/approvals/${name}.manifest already exists. Run the command again.`);
  }
  mkdirSync(folder, { recursive: true });
  writeFileSync(manifestFile, manifest);
  writeFileSync(`${manifestFile}.sig`, signature);
  return name;
}
