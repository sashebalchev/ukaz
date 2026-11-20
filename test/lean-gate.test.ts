// The parts of the Lean gate that need no Lean: reading code without comments, and the ban list.
// The whole gate runs on a real law in examples/pacer (laws check --repo examples/pacer); that needs Lean and is slow.
import assert from "node:assert/strict";
import { test } from "node:test";
import { codeOnly, forbidden } from "../lean/gate.ts";

const ALLOWED = ["Std", "Init"];

test("a banned word is found in code", () => {
  for (const word of ["sorry", "native_decide", "axiom", "opaque", "partial", "unsafe", "implemented_by", "set_option"]) {
    assert.match(forbidden("Solution.lean", `theorem t : 1 = 1 := by\n  ${word} foo\n`, ALLOWED) ?? "", new RegExp(word), word);
  }
});

test("a banned word in a comment, a doc comment or a string is not code", () => {
  const text = [
    "-- this is not a syntax for sorry",
    "/- a block comment: native_decide and axiom -/",
    "/-- a doc comment about opaque things. /- nested: unsafe -/ still a comment: partial -/",
    'def label : String := "the word sorry in a string"',
    "theorem t : 1 = 1 := rfl",
  ].join("\n");
  assert.equal(forbidden("Solution.lean", text, ALLOWED), null);
  assert.ok(!codeOnly(text).includes("sorry"));
});

test("a longer name that contains a banned word is fine", () => {
  assert.equal(forbidden("Solution.lean", "def sorryFree := 1\ntheorem axiomatic_ok : True := trivial\n", ALLOWED), null);
  assert.equal(forbidden("Solution.lean", "theorem Foo.partial_sum : True := trivial\n", ALLOWED), null);
});

test("only the allowed imports pass, with their sub-modules", () => {
  assert.equal(forbidden("Solution.lean", "import Std\nimport Std.Data.HashMap\ndef x := 1\n", ALLOWED), null);
  assert.match(forbidden("Solution.lean", "import Mathlib.Tactic\n", ALLOWED) ?? "", /imports Mathlib\.Tactic/);
  assert.match(forbidden("Solution.lean", "import Stdx\n", ALLOWED) ?? "", /imports Stdx/);
  assert.equal(forbidden("Main.lean", "import Solution\n", [...ALLOWED, "Solution"]), null);
  assert.match(forbidden("Solution.lean", "import Solution\n", ALLOWED) ?? "", /imports Solution/);
});

test("an escaped quote does not end a string early", () => {
  const text = 'def s : String := "a \\" sorry \\" b"\ntheorem t : 1 = 1 := rfl\n';
  assert.equal(forbidden("Solution.lean", text, ALLOWED), null);
});
