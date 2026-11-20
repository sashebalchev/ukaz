---
name: prove
description: "Build against laws Alex has signed: write the proof and the code under the gate, with tests that do not rely on Lean alone. Use for /prove, only after the laws are approved."
disable-model-invocation: true
---

# Prove

Start only when the laws are approved: `laws verify` passes for them (or at least their cards are `approved` in `laws status`). If not, stop and say so; run `/sign` first.

## The rules of the game

- **Frozen files do not change.** The sheet, `Challenge.lean`, the examples, the bites and the sabotage file are signed. A change of one byte voids the approval. If a law needs changing, stop and tell him; that is a new signature.
- **A law that cannot be met:** stop, say so plainly with the evidence, and give his options: fix the system, change the law, or sign an exception that names the gap. Never weaken a check to get green.
- **You write the proof and the code.** The gate decides. Never edit the gate, the checker config or the tests that are frozen.

## A Lean law

Write `Solution.lean`: an exact copy of everything in `Challenge.lean` down to, not including, the last theorem; then the code (plain, computable, the function that really runs), the proof, and the last theorem proved. Add `Main.lean` if the law has a program (`law.json` names it) that calls the very same function. Follow `/lean-best-practices`: no `sorry`, `axiom`, `native_decide`, `partial`, `unsafe`, `opaque`, `set_option` in these files. Run `laws-lean gate laws/<ID>` until it prints ALL LAWS HOLD. Be polite to the laptop: `nice -n 19`, one build at a time, wait while the CPU is hot.

## Everything else

The proof covers the model or the pure core. The real code also gets:
- tests that run the signed examples literally against it, written to `/principle-test-behavior-not-implementation` (break the behaviour and the test fails; change only the internals and it still passes);
- types and lint, and every repeated mistake turned into a check with `/correct`;
- a comparison of the real code with the model on many generated inputs, and a mutation check where the tooling exists;
- `/principle-prove-it-works`: run the real thing before you say it works.

## Subagents

They do not inherit skills. Name the skills in each brief, the frozen-file rule, the polite-build rule, and tell them to stop what they start and delete their scratch.

## Done means

`laws check`, `laws bite` and `laws verify` all pass, and you ran the real thing. Then hand back with `/ketchup`'s shape: what was built, what each law's grade really is, what is only sampled, what waits on him.

<!-- Written new for Alex (ukaz). -->
