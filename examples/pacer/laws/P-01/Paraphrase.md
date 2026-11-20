# The pacer law in plain English (read from the Lean text only)

## What the law is about
A "pacer" is a gatekeeper. Read requests arrive with a time stamp in whole seconds. The pacer keeps a list of the reads it has allowed (the "history", newest first). For each request it either allows the read (the request's time is added at the front of the list) or refuses it (the list stays as it was). Nothing else is possible.

## The four laws
1. **Gap.** Whatever requests arrive, in whatever order, any two neighbouring allowed reads are at least 5 seconds apart.
2. **Cap.** Whatever requests arrive, take any allowed read: the hour ending at that read never contains more than 40 allowed reads (that read included).
3. **Nothing is refused without reason.** If a request is at least 5 seconds after the newest allowed read (or there is none), and the hour ending now holds at most 39 allowed reads so far (so this one would be at most the 40th), then it is allowed. This is what rules out a pacer that refuses everything.
4. **Allowed or refused, nothing else.** The new history is either the old one unchanged (refused) or the old one with the new time put in front (allowed). Never anything else: no forgetting, no rewriting, no other time.

"Whatever requests arrive" means any list of times in any order, including times that jump backwards.

## The definitions, one sentence each
- **inside now t**: the read at time t counts as "in the hour ending now" when now is less than t + 3600, i.e. the read is less than 3600 seconds old.
- **count now h**: how many reads in the history h are inside the hour ending now.
- **GapOk now h**: the history is empty, or the newest read is at least 5 seconds before now (newest time + 5 is at most now).
- **Spaced h**: each read in the list is at least 5 seconds after the next older one.
- **Capped h**: the list is empty, or the hour ending at its newest read holds at most 40 reads.
- **replay step times**: start with an empty history and feed the request times one by one, oldest first, to the pacer; the result is the history at the end.

Laws 1 and 2 say Spaced and Capped hold for the result of every replay (hence for every moment of every run, since every prefix of a run is itself a run).

## Things that surprised me or can be misread
- **Exactly 5 seconds is allowed** (5 <= gap). 4 seconds is refused.
- **The hour is half-open.** A read exactly 3600 s old is NOT inside; one that is 3599 s old is. So with 40 reads in the hour, a new read exactly 3600 s after the oldest of them is allowed, 3599 s after is refused. The plain-words header does not say this; only the Lean does.
- **The 41st read** within an hour is refused, not the 40th; the 40th is allowed (cap is "at most 40").
- **Clocks going backwards or standing still:** a request earlier than or equal to the newest allowed read is refused (the gap would be negative or zero). The refused time is forgotten, so the next request is compared with the newest allowed read, not with the refused one.
- **Only the newest read is checked for the gap**, and only the hour ending at an allowed read is checked for the cap. These are enough because refused reads change nothing.
- **"Allowed" has no flag.** The pacer returns only a history; "allowed" means "the history grew by this time". A reader looking for a yes/no answer will not find one.
- **Time 0 is a legal time**, the first read is always allowed, at any time.
- **Laws 3 and 4 speak about every history, even ones the pacer could never produce** (for example unsorted lists). Laws 1 and 2 speak only about histories actually produced from an empty start. So the law does not say what a pacer does when handed a hand-made history that does not satisfy the conditions of law 3; it only fixes behaviour on histories it built itself (and that is enough: see Unique.lean).
- **count on an unsorted history** would count by time stamp, not position; irrelevant for built histories.
- The header says "the hour that ends at any allowed read" but Capped (and the replay quantifier) only looks at the newest read of each prefix; equivalent because each allowed read was the newest when it was allowed.
- Times are natural numbers: no negative times, no fractions. Sub-second requests do not exist in this model.
- The file's last theorem, pacer_exists, is only stated (a placeholder, the agent must replace it); the law itself is the structure Laws.
