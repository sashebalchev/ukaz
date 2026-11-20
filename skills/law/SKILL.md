---
name: law
description: "Turn a clear request into law sheets Alex can read and sign: outcome-first sentences, edges, examples, and where a proof fits a Lean statement. Writes no code and never signs. Use for /law, after /grill."
disable-model-invocation: true
---

# Law

Write the laws, not the code. Output: sheets in the project's own `laws/` folder, shown to Alex in a form he can read in a few minutes.

## 1. Pick the kind and the grade of each law

- Pure rule (a limit, a range, an ordering) → a Lean law, grade `every-case`.
- Stateful behaviour → a model plus replays of the real code, grade `generated` or `chosen`. Say "sampled".
- A capability limit → enforced by the system; the policy file is the law.
- Anything else → grade `chosen` with examples, or `prose` if nothing can check it. Be honest: a weak grade shown plainly is better than a strong word.

## 2. Write the sheet (`laws/<ID>.md`)

Ids are a letter and number (`F-01`). The sentences are outcomes he can feel, one rule each, with the reason he can judge ("30% is the speed you cannot hear"). Skeleton:

```
---
id: F-01
grade: every-case
check: <command that proves it>
bite: <command that runs the check on broken copies; it must fail and print the bite-says text>
bite-says: <text the failing bite prints>
frozen: [every file whose content is part of the law]
scope: [the files the law is about]
---
# F-01 <title in plain words>

**Law.** <one or two sentences>
**Why.** <the reason he can judge>
**Edges.** <the odd cases: exactly at the limit, empty, backwards>
**Blocked.** <what must be refused or must not happen>
**Allowed.** <what must still work>
**Checked by.** <what checks it, and its limits, in plain words>
```

Keep a batch to seven laws or fewer. No lemma names, no jargon. If a law cannot be met today, write it anyway with "cannot be met today" and the evidence.

## 3. For a Lean law (`laws/<ID>/`)

Copy the layout of `~/Projects/ukaz/examples/pacer/laws/P-01/` (`law.json`, `lakefile.toml`, `lean-toolchain`, `comparator.json`). Write `Challenge.lean`: small definitions named in plain words with doc comments, one structure `Laws`, and a last theorem that says a solution exists, proved with `sorry`. Follow `/lean-best-practices`. Then start a **fresh subagent** (Agent tool, `model: sonnet`) that has not seen your reasoning, to write the rest from `Challenge.lean` alone: `Paraphrase.md` (plain words), `examples.txt` (25 rows, each reason in plain words), `Bites.lean` (at least 8 wrong versions, each refuted), `Unique.lean` (the law fixes one behaviour), `sabotage.txt`. Brief it: no Solution; builds are polite (`nice -n 19`, one at a time, at most 8 in all, wait while the CPU is above 80 C); no leanchecker; stop what it starts, delete its scratch; report any weakness it finds in the statement. Check its work yourself with `laws-lean bite laws/<ID>` before a solution exists that checks the statement and that the bare statement is rejected.

## 4. Show him, then stop

Register the project once (`laws projects add <path>`). Run `laws sheet <ID> --out <scratchpad>/<ID>.html` and open it (`zen-beta --new-tab file://...`). Ask him to read it and say what is wrong, in words or as thread comments. Iterate. Do not write code, do not run `laws sign`, do not create approvals. The next step is `/sign`, then `/prove`.

<!-- Written new for Alex (ukaz). -->
