import { realpathSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";
import { readApprovals } from "./approvals.ts";
import { LawsError, loadCards } from "./cards.ts";
import type { Loaded } from "./cards.ts";

export const DEFAULT_SIGNERS = "/etc/laws/allowed_signers";

export type State = "approved" | "changed" | "waiting" | "broken";
export type CardState = { id: string; state: State; note: string };
export type Lawbook = { cards: Loaded[]; states: CardState[]; notes: string[] };
export type Verdict = { ok: boolean; reasons: string[] };

// Where the signers file is looked for: the flag, else LAWS_SIGNERS, else /etc/laws/allowed_signers.
export function chooseSignersPath(flag: string | null, environment: string | undefined): string {
  if (flag !== null) return flag;
  if (environment !== undefined && environment !== "") return environment;
  return DEFAULT_SIGNERS;
}

// The signers file names the keys that may approve laws, so it must be out of the repository's reach.
// There is no fallback: a path inside the repository is refused, a missing file is an error.
export function resolveSigners(repo: string, flag: string | null): string {
  const path = resolve(chooseSignersPath(flag, process.env["LAWS_SIGNERS"]));
  const refuse = (): never => {
    throw new LawsError(
      `refusing the signers file ${path}: it is inside the repository being verified (${repo}). ` +
        "The keys that approve laws must live where the repository cannot change them. " +
        "Pass --signers <file> or set LAWS_SIGNERS to a file outside it.",
    );
  };
  let repoReal: string;
  try {
    repoReal = realpathSync(repo);
  } catch {
    throw new LawsError(`the repository ${repo} does not exist.`);
  }
  if (isInside(resolve(repo), path) || isInside(repoReal, path)) refuse();

  let real: string;
  try {
    real = realpathSync(path);
  } catch {
    throw new LawsError(
      `no signers file at ${path}. Pass --signers <file>, set LAWS_SIGNERS, or create ${DEFAULT_SIGNERS}.`,
    );
  }
  if (isInside(repoReal, real)) refuse();
  if (!statSync(real).isFile()) throw new LawsError(`the signers file ${path} is not a regular file.`);
  return real;
}

function isInside(folder: string, path: string): boolean {
  return path === folder || path.startsWith(folder + sep);
}

export function readLawbook(repo: string, signersFile: string): Lawbook {
  const cards = loadCards(repo);
  const approvals = readApprovals(repo, signersFile);
  const states = cards.map((card): CardState => {
    if (!card.ok) return { id: card.id, state: "broken", note: `broken: ${card.problem}` };
    if (approvals.lines.has(`${card.id} ${card.hash}`)) return { id: card.id, state: "approved", note: "" };
    if (approvals.ids.has(card.id)) return { id: card.id, state: "changed", note: "changed since it was approved" };
    return { id: card.id, state: "waiting", note: "waiting: never approved" };
  });
  return { cards, states, notes: approvals.notes };
}

// Passes only if every card is approved as it is now. A repository without cards does not pass:
// nothing was verified.
export function verifyRepo(repo: string, signersFlag: string | null): Verdict {
  let book: Lawbook;
  try {
    book = readLawbook(repo, resolveSigners(repo, signersFlag));
  } catch (error) {
    if (error instanceof LawsError) return { ok: false, reasons: [error.message] };
    throw error;
  }
  const reasons = book.states.filter((card) => card.state !== "approved").map((card) => `${card.id}: ${card.note}`);
  if (book.states.length === 0) reasons.push("there are no law cards in laws/");
  if (reasons.length > 0) reasons.push(...book.notes);
  return { ok: reasons.length === 0, reasons };
}
