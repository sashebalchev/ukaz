import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { manifestText, signatureProblem } from "./approvals.ts";
import { teethOf } from "./bite.ts";
import { LawsError } from "./cards.ts";
import type { GoodCard } from "./cards.ts";
import { readLawbook, resolveSigners } from "./verify.ts";
import type { Lawbook } from "./verify.ts";

export type SignRequest = {
  repo: string;
  ids: string[]; // empty means: every card that is waiting or changed
  signerCommand: string | null;
  signersFlag: string | null;
};

// laws sign: asks the separate signer program to sign a batch of cards, checks what comes back,
// and only then stores it under laws/approvals/. This program holds no key and makes no signature.
// Returns the exit code.
export async function signCommand(request: SignRequest, print: (line: string) => void): Promise<number> {
  const { repo } = request;
  const signerCommand = request.signerCommand ?? process.env["LAWS_SIGNER"] ?? "";
  if (signerCommand === "") {
    throw new LawsError(
      'no signer: pass --signer "<command>" or set LAWS_SIGNER, for example ' +
        '--signer "sudo laws-signer --key /root/laws/key --log /var/log/laws-signer.log". Nothing was written.',
    );
  }
  const signersFile = resolveSigners(repo, request.signersFlag);
  const picked = pickCards(readLawbook(repo, signersFile), request.ids);
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

  const ids = picked.map((card) => card.id);
  const expected = manifestText(picked.map((card) => ({ id: card.id, hash: card.hash })));
  const out = mkdtempSync(join(tmpdir(), "laws-sign-"));
  try {
    // The signer command gets: --repo <repo> --out <folder> <id>... and leaves manifest and manifest.sig there.
    const signer = spawnSync("sh", ["-c", `${signerCommand} "$@"`, "signer", "--repo", repo, "--out", out, ...ids], {
      stdio: "inherit",
    });
    if (signer.status !== 0) throw new LawsError("the signer did not sign. Nothing was stored.");

    const manifest = readBack(join(out, "manifest"));
    const signature = readBack(join(out, "manifest.sig"));
    if (manifest.toString("utf8") !== expected) {
      throw new LawsError("the signer returned a different list than it was asked to sign. Nothing was stored.");
    }
    const problem = signatureProblem(manifest, join(out, "manifest.sig"), signersFile);
    if (problem !== null) throw new LawsError(`the signature that came back is not accepted: ${problem}. Nothing was stored.`);

    const name = store(repo, manifest, signature);
    print(`approved ${ids.join(", ")}: stored laws/approvals/${name}.manifest and .manifest.sig`);
    return 0;
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

function pickCards(book: Lawbook, ids: string[]): GoodCard[] {
  const wanted =
    ids.length > 0
      ? [...new Set(ids)].sort()
      : book.states.filter((card) => card.state !== "approved").map((card) => card.id);
  return wanted.map((id) => {
    const card = book.cards.find((candidate) => candidate.id === id);
    if (card === undefined) throw new LawsError(`there is no card ${id} in laws/.`);
    if (!card.ok) throw new LawsError(`${id} cannot be signed, the card is broken: ${card.problem}`);
    return card;
  });
}

function readBack(file: string): Buffer {
  try {
    return readFileSync(file);
  } catch {
    throw new LawsError(`the signer left no ${file}. Nothing was stored.`);
  }
}

// The name is the time in UTC, for example 20261118T091500Z.
function store(repo: string, manifest: Uint8Array, signature: Uint8Array): string {
  const folder = join(repo, "laws", "approvals");
  const name = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const manifestFile = join(folder, `${name}.manifest`);
  if (existsSync(manifestFile)) {
    throw new LawsError(`laws/approvals/${name}.manifest already exists. Wait a second and run laws sign again.`);
  }
  mkdirSync(folder, { recursive: true });
  writeFileSync(manifestFile, manifest);
  writeFileSync(`${manifestFile}.sig`, signature);
  return name;
}
