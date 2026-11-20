# lean/: the proof half of a law

A law whose grade is `every-case` is an ordinary card (`laws/<ID>.md`) plus a folder (`laws/<ID>/`) with a Lean statement. The card's `check` runs the gate, its `bite` runs the gate on broken copies. Hashing, approval and signing work as for every other card.

```
laws/P-01.md             the sheet he reads and signs: Law, Why, Edges, Blocked, Allowed
laws/P-01/               (frozen with the card unless marked "agent")
  Challenge.lean         the statement; proofs left as sorry
  comparator.json        what lake comparator judges; permitted axioms
  lakefile.toml, lean-toolchain, law.json
  Paraphrase.md          the law in plain words, by a second agent
  examples.txt           rows the kernel and the running program must agree with
  Bites.lean             wrong versions the law must refute (each with a proof)
  Unique.lean            the law leaves exactly one behaviour
  sabotage.txt           broken edits the bite tries
  Solution.lean, Main.lean   agent: the proof and the program (not frozen)
```

```
lean/laws-lean gate laws/P-01     ALL LAWS HOLD or SOME LAWS FAIL: why
lean/laws-lean bite laws/P-01     REJECTED all N broken variants (exit 1 = the law has teeth)
```

The gate: the toolchain is the pinned one; the agent's files use nothing banned (comments and strings are not code; `import Std` is allowed); everything builds and only the statement uses `sorry`; `lake comparator` (same statement and definitions, allowed axioms, kernel replay); the bites and uniqueness proof build with only `propext`, `Quot.sound`, `Classical.choice`; every example row agrees with the kernel and with the compiled program.

A working law: `examples/pacer` (`laws check --repo examples/pacer`). Lean comes from nixpkgs (4.35.0); heavy steps run under `nice`.

Not covered: `--paranoid` (the extra kernels are not in nixpkgs); Lean's compiler is trusted for the running program; the examples check the program only on the rows; `instance`, `open Classical` and `attribute` are not banned and not tested for hiding a changed meaning.
