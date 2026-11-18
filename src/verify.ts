import { realpathSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";
import { readApprovals } from "./approvals.ts";
import { LawsError, loadCards } from "./cards.ts";
import type { Loaded } from "./cards.ts";

export const DEFAULT_SIGNERS = "/etc/laws/allowed_signers";

// approved, changed, waiting and broken are states of a card file. missing: a signed approval names the
// card and its file is gone. retired: the newest signed line for the id retires it.
export type State = "approved" | "changed" | "waiting" | "broken" | "missing" | "retired";
// problem is null when this card does not stand in the way of the gate.
export type CardState = { id: string; state: State; problem: string | null };
export type Lawbook = { cards: Loaded[]; states: CardState[]; newest: string; notes: string[] };
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
    const { id } = card;
    if (!card.ok) return { id, state: "broken", problem: `broken: ${card.problem}` };
    if (approvals.live.get(id)?.has(card.hash)) return { id, state: "approved", problem: null };
    if (approvals.live.has(id)) return { id, state: "changed", problem: "changed since it was approved" };
    if (approvals.retired.has(id)) {
      const problem = `retired, but laws/${id}.md is still there: remove the file, or sign the card again with "laws sign ${id}"`;
      return { id, state: "retired", problem };
    }
    return { id, state: "waiting", problem: "waiting: never approved" };
  });

  // T-08: a card that a signed approval names cannot just disappear.
  const present = new Set(cards.map((card) => card.id));
  for (const id of approvals.live.keys()) {
    if (present.has(id)) continue;
    const problem = `missing: a signed approval names it, but laws/${id}.md is gone. Restore the file; to remove a law, run "laws retire ${id}" first`;
    states.push({ id, state: "missing", problem });
  }
  for (const id of approvals.retired) {
    if (!present.has(id)) states.push({ id, state: "retired", problem: null });
  }
  states.sort((a, b) => (a.id < b.id ? -1 : 1));
  return { cards, states, newest: approvals.newest, notes: approvals.notes };
}

// Passes only if every card is approved as it is now and no approved card is missing.
// A repository without cards does not pass: nothing was verified.
export function verifyRepo(repo: string, signersFlag: string | null): Verdict {
  let book: Lawbook;
  try {
    book = readLawbook(repo, resolveSigners(repo, signersFlag));
  } catch (error) {
    if (error instanceof LawsError) return { ok: false, reasons: [error.message] };
    throw error;
  }
  const reasons: string[] = [];
  for (const card of book.states) {
    if (card.problem !== null) reasons.push(`${card.id}: ${card.problem}`);
  }
  if (book.cards.length === 0) reasons.push("there are no law cards in laws/");
  if (reasons.length > 0) reasons.push(...book.notes);
  return { ok: reasons.length === 0, reasons };
}
