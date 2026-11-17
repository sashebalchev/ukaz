import { verifyRepo } from "./verify.ts";

export type Gate = { open: boolean; reasons: string[] };

// The gate is open exactly when every card is approved at its current hash.
// A new card, a changed card, a broken card or a missing signature closes it, and so does having no cards.
export function gate(repo: string, signersFlag: string | null): Gate {
  const verdict = verifyRepo(repo, signersFlag);
  return { open: verdict.ok, reasons: verdict.reasons };
}
