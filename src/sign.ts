import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { manifestText, openSigners, parseManifest, passkeyFileOf, signatureProblem } from "./approvals.ts";
import type { Entry, Manifest } from "./approvals.ts";
import { teethOf } from "./bite.ts";
import { LawsError, readCardFiles } from "./cards.ts";
import type { GoodCard } from "./cards.ts";
import { askLaptop } from "./laptop.ts";
import { passkeyProblem } from "./passkey.ts";
import { postRequest, serverAddress, waitForApproval } from "./client.ts";
import { requestText } from "./request.ts";
import type { Line } from "./request.ts";
import { readLawbook, resolveSigners, verifyRepo } from "./verify.ts";
import type { Lawbook } from "./verify.ts";

export type SignRequest = {
  repo: string;
  ids: string[];
  signerCommand: string | null; // --signer
  laptop: string | null; // --laptop: the socket of the laptop signer
  server: string | null; // --server: the address of the signing server
  phone: boolean; // --phone: wait for the phone
  signersFlag: string | null;
};

// The ways to get a signature. This program holds no key and makes no signature: it always asks.
//   command   a signer command, usually "sudo laws-signer ...": it asks for a typed word at the terminal
//   laptop    the laptop signer, a service behind a socket: it asks for one finger on the reader
//   server    the signing server: the cards wait there until you approve them on the phone
type Way = { kind: "command"; command: string } | { kind: "laptop"; socket: string } | { kind: "server"; address: string };

// One card of a batch: to approve as it is now, or to retire.
type Asked = { card: GoodCard; retire: boolean };
// What came back: the manifest, and an SSH signature or a passkey answer over it.
type Signed = { manifest: Buffer; signature: Buffer | null; passkey: string | null };
// What was stored: the name of the files, the ending of the proof file, and the cards that the stored
// manifest names.
type Stored = { name: string; proof: string; done: Asked[] };

// How far the clock of the signing server may be from the clock of this laptop.
const CLOCK_SLACK_MINUTES = 5;

// laws sign: asks for a signature that approves cards, checks what comes back, and only then stores it
// under laws/approvals/. With no ids it takes every card that is waiting or changed.
// Returns the exit code.
export async function signCommand(request: SignRequest, print: (line: string) => void): Promise<number> {
  const { repo } = request;
  const way = wayOf(request);
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

  const asked = picked.map((card) => ({ card, retire: false }));
  const stored = await askAndStore(repo, signersFile, way, asked, book.newest, print);
  report(request, way, "approved", asked, stored, print);
  return 0;
}

// laws retire: asks for a signature that retires cards. A card must still be there when it is retired,
// so that its title can be shown. After that its file can be removed. Returns the exit code.
export async function retireCommand(request: SignRequest, print: (line: string) => void): Promise<number> {
  const { repo } = request;
  if (request.ids.length === 0) throw new LawsError("usage: laws retire <id>...");
  const way = wayOf(request);
  const signersFile = resolveSigners(repo, request.signersFlag);
  const book = readLawbook(repo, signersFile);
  const ids = [...new Set(request.ids)].sort();
  const asked = ids.map((id) => {
    const card = book.cards.find((candidate) => candidate.id === id);
    if (card !== undefined && card.ok) return { card, retire: true };
    throw new LawsError(
      `laws/${id}.md is missing or broken. A card must still be there when it is retired, so that the signer can show its title.`,
    );
  });

  const stored = await askAndStore(repo, signersFile, way, asked, book.newest, print);
  report(request, way, "retired", asked, stored, print);
  print(`You can now remove ${stored.done.map(({ card }) => `laws/${card.id}.md`).join(", ")}.`);
  return 0;
}

// Says what was stored. After a signing through the server it also prints the list that became
// approved, because you may have accepted fewer cards than were sent, and it runs laws verify.
function report(request: SignRequest, way: Way, verb: string, asked: Asked[], stored: Stored, print: (line: string) => void): void {
  const ids = stored.done.map(({ card }) => card.id).join(", ");
  print(`${verb} ${ids}: stored laws/approvals/${stored.name}.manifest and ${stored.proof}`);
  if (way.kind !== "server") return;

  for (const line of linesOf(stored.done)) print(listLine(line));
  const left = asked.filter((one) => !stored.done.includes(one)).map(({ card }) => card.id);
  if (left.length > 0) print(`not ${verb}: ${left.join(", ")} (rejected or left out)`);
  const verdict = verifyRepo(request.repo, request.signersFlag);
  print(verdict.ok ? "verified: every card is approved as it is now" : "not verified");
  for (const reason of verdict.reasons) print(`  ${reason}`);
}

// One way, and only one. A flag wins over LAWS_SIGNER. LAWS_SIGNER holds a signer command, or
// "laptop:<socket>" or "server:<address>" to make one of those the usual way.
function wayOf(request: SignRequest): Way {
  const flags = [request.signerCommand, request.laptop, request.server].filter((flag) => flag !== null);
  if (flags.length > 1) throw new LawsError("give only one of --signer, --laptop and --server. Nothing was written.");
  if (request.laptop !== null) return { kind: "laptop", socket: request.laptop };
  if (request.server !== null) return { kind: "server", address: request.server };
  const value = request.signerCommand ?? process.env["LAWS_SIGNER"] ?? "";
  if (value === "") {
    throw new LawsError(
      'no signer: pass --server <address> or --signer "<command>", or set LAWS_SIGNER, for example ' +
        "--server https://pi.example.ts.net/laws/ or " +
        '--signer "sudo laws-signer --key /root/laws/key --log /var/log/laws-signer.log". Nothing was written.',
    );
  }
  if (value.startsWith("laptop:")) return { kind: "laptop", socket: value.slice("laptop:".length) };
  if (value.startsWith("server:")) return { kind: "server", address: value.slice("server:".length) };
  return { kind: "command", command: value };
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

// Asks for the signature, checks what comes back, and stores it.
// It is stored only if the manifest is the list that was asked for, its time is later than the newest
// manifest already here, and the signature verifies against the signers file. Through the server you
// may accept fewer cards than were sent: then the manifest is a part of that list, and never more.
async function askAndStore(
  repo: string,
  signersFile: string,
  way: Way,
  asked: Asked[],
  newest: string,
  print: (line: string) => void,
): Promise<Stored> {
  const entries = asked.map(({ card, retire }) => ({ id: card.id, hash: retire ? null : card.hash }));
  const folder = mkdtempSync(join(tmpdir(), "laws-sign-"));
  try {
    chmodSync(folder, 0o700); // private to this user, whatever the defaults are
    const began = Date.now();
    let signed: Signed;
    if (way.kind === "command") signed = askCommand(repo, way.command, entries, folder);
    else if (way.kind === "laptop") signed = await askLaptopSigner(repo, way.socket, asked, print);
    else signed = await askServer(repo, way.address, asked, print);
    const { manifest, signature, passkey } = signed;

    const text = manifest.toString("utf8");
    let listed: Manifest;
    try {
      listed = parseManifest(text);
    } catch {
      throw new LawsError("what the signer returned is not a manifest. Nothing was stored.");
    }
    const { time } = listed;
    const done = asked.filter((_, at) => listed.entries.some((entry) => entry.id === entries[at]?.id && entry.hash === entries[at]?.hash));
    const asAsked = way.kind === "server" ? done.length === listed.entries.length : text === manifestText(time, entries);
    if (!asAsked) throw new LawsError("the signer returned a different list than it was asked to sign. Nothing was stored.");
    if (time <= newest) {
      throw new LawsError(
        `the signer dated its signature ${time}, which is not later than the newest one here (${newest}). ` +
          "Check the clock of the signer. Nothing was stored.",
      );
    }

    if (way.kind === "server") {
      // The time in the manifest was set on another machine. A time far from now would put this
      // approval before or after others that it does not belong before or after.
      const slack = CLOCK_SLACK_MINUTES * 60 * 1000;
      if (!(Date.parse(time) >= began - slack && Date.parse(time) <= Date.now() + slack)) {
        throw new LawsError(
          `the list that came back is dated ${time}. That is not between the start of this command and now, ` +
            `give or take ${CLOCK_SLACK_MINUTES} minutes. Check the clocks. Nothing was stored.`,
        );
      }
    }

    let problem: string | null;
    if (passkey !== null) {
      const signers = openSigners(signersFile);
      try {
        problem = passkeyProblem(manifest, passkey, signers.passkeys, signersFile);
      } finally {
        signers.close();
      }
    } else {
      const signatureFile = join(folder, "checked.sig");
      writeFileSync(signatureFile, signature ?? "", { flag: "wx", mode: 0o600 });
      problem = signatureProblem(manifest, signatureFile, signersFile);
    }
    if (problem !== null) throw new LawsError(`the signature that came back is not accepted: ${problem}. Nothing was stored.`);

    const name = store(repo, time, manifest, signature ?? passkey ?? "", passkey !== null);
    return { name, proof: passkey !== null ? ".passkey.json" : ".manifest.sig", done };
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

// Hands the list to the signer command. It gets: --repo <repo> --out <folder> <id>... --retire <id>...
// and leaves the files manifest and manifest.sig in that folder.
function askCommand(repo: string, signerCommand: string, entries: Entry[], out: string): Signed {
  const asked = entries.flatMap((entry) => (entry.hash === null ? ["--retire", entry.id] : [entry.id]));
  const words = ["--repo", repo, "--out", out, ...asked];
  const signer = spawnSync("sh", ["-c", `${signerCommand} "$@"`, "signer", ...words], { stdio: "inherit" });
  if (signer.status !== 0) throw new LawsError("the signer did not sign. Nothing was stored.");
  return { manifest: readBack(join(out, "manifest")), signature: readBack(join(out, "manifest.sig")), passkey: null };
}

function readBack(file: string): Buffer {
  try {
    return readFileSync(file);
  } catch {
    throw new LawsError(`the signer left no ${file}. Nothing was stored.`);
  }
}

// Sends the cards to the laptop signer: the bytes of each card and of the files hashed with it.
// The service answers with the list as it computed it. That list is printed, and only if it is the
// list this program computed itself is the person told to touch the reader.
async function askLaptopSigner(repo: string, socket: string, asked: Asked[], print: (line: string) => void): Promise<Signed> {
  const answer = await askLaptop(socket, requestOf(repo, asked), ({ list, finger, seconds }) => {
    print(`the laptop signer at ${socket} computed this list:`);
    for (const line of list) print(listLine(line));
    if (!sameList(list, linesOf(asked))) {
      throw new LawsError(
        "the laptop signer computed a different list than this program. A file may have changed just now. " +
          "Do not touch the reader. Nothing was stored.",
      );
    }
    print(`Put your ${finger.replaceAll("-", " ")} on the fingerprint reader now. You have ${seconds} seconds.`);
  });
  return { manifest: Buffer.from(answer.manifest, "utf8"), signature: Buffer.from(answer.signature, "utf8"), passkey: null };
}

// Posts the cards to the signing server and waits until the request is approved there. The server
// answers with the list as it computed it. Only if that is the list this program computed itself is
// the address for the phone printed.
async function askServer(repo: string, address: string, asked: Asked[], print: (line: string) => void): Promise<Signed> {
  const base = serverAddress(address);
  const posted = await postRequest(base, requestOf(repo, asked));
  print(`the signing server at ${base} computed this list:`);
  for (const line of posted.list) print(listLine(line));
  if (!sameList(posted.list, linesOf(asked))) {
    throw new LawsError(
      "the signing server computed a different list than this program. A file may have changed just now. " +
        "Do not sign it on the phone. Nothing was stored.",
    );
  }
  print("Open this address on your phone, read the cards there, and sign:");
  print(`  ${posted.page}`);
  print(`Waiting for the approval. The request runs out at ${posted.expires.replace(/[^0-9TZ:.-]/g, "?")}. Ctrl-C stops the waiting.`);
  const answer = await waitForApproval(base, posted, print);
  const signature = answer.signature === null ? null : Buffer.from(answer.signature, "utf8");
  return { manifest: Buffer.from(answer.manifest, "utf8"), signature, passkey: answer.passkey };
}

// The request for these cards, read from the repository now.
export function requestOf(repo: string, asked: Asked[]): string {
  return requestText(
    asked.map(({ card, retire }) => {
      const { cardBytes, files } = readCardFiles(repo, card.id);
      return { id: card.id, retire, card: cardBytes, files: retire ? [] : files };
    }),
  );
}

// The list as this program computed it, in the order and form in which a signer answers.
export function linesOf(asked: Asked[]): Line[] {
  const lines = asked.map(({ card, retire }) => ({ id: card.id, hash: retire ? null : card.hash, title: card.card.title }));
  return lines.sort((a, b) => (a.id < b.id ? -1 : 1));
}

export function sameList(one: Line[], other: Line[]): boolean {
  if (one.length !== other.length) return false;
  return one.every((line, at) => line.id === other[at]?.id && line.hash === other[at]?.hash && line.title === other[at]?.title);
}

// One line of the list, as the terminal signer prints it. The words may come from another program, so
// nothing but plain text reaches the terminal.
export function listLine(line: Line): string {
  const text = line.hash === null ? `  retire  ${line.id}  ${line.title}` : `  sign    ${line.id}  ${line.hash}  ${line.title}`;
  return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, "?");
}

// The file is named after the signed time, for example 20261118T091500.123Z.manifest. Next to it goes
// the proof: <name>.manifest.sig for an SSH signature, <name>.passkey.json for a passkey answer.
function store(repo: string, time: string, manifest: Uint8Array, proof: string | Uint8Array, fromPasskey: boolean): string {
  const folder = join(repo, "laws", "approvals");
  const name = time.replace(/[-:]/g, "");
  const manifestFile = join(folder, `${name}.manifest`);
  if (existsSync(manifestFile)) {
    throw new LawsError(`laws/approvals/${name}.manifest already exists. Run the command again.`);
  }
  mkdirSync(folder, { recursive: true });
  writeFileSync(manifestFile, manifest);
  writeFileSync(fromPasskey ? passkeyFileOf(manifestFile) : `${manifestFile}.sig`, proof);
  return name;
}
