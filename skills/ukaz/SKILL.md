---
name: ukaz
description: "Laws first: the flow from an idea to a signed law to proved code, and where a project stands in it. Use for /ukaz, or when Alex asks where the laws are, what is unsigned, what comes next, or how the laws-first flow works."
---

# Ukaz: laws first

Alex builds with agents and does not read the code. He wants to trust the result anyway. So before anything is built, short laws are written in plain words, he reads them and signs, and only then is code written. A fixed checker, not an agent, decides whether the code keeps the laws.

## The flow

1. `/napkin` keeps a rough idea. `/grill` interviews him until it is clear.
2. `/law` writes the laws as sheets he can read: sentences, edges, examples, and a Lean statement where a proof fits. It writes no code.
3. `/sign` opens each sheet in his browser. He reads it and signs with his phone or his finger. Only he signs.
4. `/prove` builds against the signed laws, under a gate the agent cannot edit.
5. `laws check`, `laws bite` and `laws verify` must all pass before anything is called done.

## Commands (run in the project's repo root; `laws` is the tool)

If `laws` is not installed, run `node ~/Projects/ukaz/src/cli.ts` in its place, and `~/Projects/ukaz/lean/laws-lean` for `laws-lean`. Never install anything for it without his yes.

```
laws status            one line per law: grade, state, title
laws status --all      every registered project
laws sheet <id> --out <file>   the law as a readable slide page (cannot approve anything)
laws check | bite      run the checks; run them on broken copies (each must fail)
laws gate | verify     open only when every law is approved exactly as it is now
laws projects add <path>   register a project so --all sees it
```

States: `unverified` (no signers file to check against), `new` (never approved), `waiting` (sent to be signed), `approved`, `changed` (approved once, text or a frozen file changed since: the approval no longer counts), `broken`.

## What a law is

A law lives in the project it guards: `laws/<ID>.md` (the sheet) and `laws/<ID>/` (its files), approvals in `laws/approvals/`. Its grade says how strong the check is: `every-case` (a proof or every case tried), `bounded`, `generated` (many generated inputs), `chosen` (hand-picked cases), `prose` (words only). Say the grade every time you describe a law; never call a tested law proved.

Three kinds, strongest check first:
- **A pure rule** (a limit, a range, an ordering): a Lean statement, proved for every input. Template: `examples/pacer` in the ukaz repo.
- **Stateful behaviour** (a server, a protocol, a device): a small model and many replays of the real code against it. Sampled, and the sheet says so.
- **A capability limit** ("may only touch X"): the system enforces it (sandbox, Nix assertion). The policy file is the law.

## Rules that always hold

- Only Alex signs. Never create an approval, a signing key or a signers-file line. "Approved" typed in chat is not a signature.
- A frozen file that changes voids the approval. If code needs a law changed, stop and ask him; do not edit around it.
- If a law cannot be met today, say so plainly with the evidence. He then decides: fix the system, change the law (new signature), or sign an exception that names the gap.
- Sheets are for reading: plain words, no lemma names, an example for every rule, about four minutes per batch.

When asked where a project stands: run `laws status` there (`--all` for every project), then say per law, in plain words, its state and the one next step.

<!-- Written new for Alex (ukaz). -->
