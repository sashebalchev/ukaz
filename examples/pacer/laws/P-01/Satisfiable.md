# Is the law satisfiable, and not vacuous?

Not using pacer_exists. Argument.

## Satisfiable
Take the obvious pacer: step now h = (if GapOk now h and count now h + 1 <= 40 then now :: h else h).
- Law 3 (permitted): holds by definition of step.
- Law 4 (silent): the result is h or now :: h by construction.
- Law 1 (spaced): by induction over a request list, replay is Spaced. Empty history is Spaced. If a step adds now to h, then GapOk holds, so the old newest read t has t + 5 <= now, and the rest was Spaced by induction; so now :: h is Spaced. If it does not add, nothing changes.
- Law 2 (capped): if a step does not add, the history is unchanged, so Capped (by induction). If it adds now, then count now (now :: h) = count now h + 1 (now is inside its own hour since now < now + 3600), which is at most 40 by the condition. That is exactly Capped for the new history, and Capped only looks at the newest read, so no invariant on the rest is needed.
So Laws holds and the law is satisfiable. I checked this argument by compiling a throwaway Lean version of that step against the 27 rows of examples.txt (all agree); it is not delivered.

## Not vacuous
1. Two obligations cannot both be satisfied trivially: the law says what must be allowed (law 3), what may never happen (laws 1, 2), and that nothing else is touched (law 4). A pacer that refuses everything violates law 3 (Bites.lean: badRefuse_bad). A pacer that allows everything violates law 1 (badAllow_bad). So Laws is neither implied by a degenerate pacer nor empty.
2. Strength: Unique.lean proves laws_determine: any two pacers satisfying Laws give the same history for every request sequence. The law therefore pins down one behaviour; it is satisfiable (above) and the satisfier is unique on every run. Argument: laws 3 and 4 decide every permitted request; for a non-permitted request, adding it would make the history violate law 1 (gap too small) or law 2 (41st read in the hour), so by law 4 it must be refused.
3. Bites.lean: 13 plausible-looking wrong pacers, each proved to violate Laws.

## Residual weakness
Laws 3 and 4 are stated for all histories but laws 1 and 2 only along replays from the empty history. So on histories the pacer could never produce itself (e.g. a hand-made unsorted list that already has 40 recent reads) a pacer satisfying Laws may do either allow-or-refuse in the non-permitted case. This does not affect any request sequence fed from the start, which is what the pacer is used for.
