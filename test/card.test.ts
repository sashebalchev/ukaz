import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { CardError, hashedPaths, parseCard, renderedFigure } from "../src/card.ts";

const FULL = `---
id: D-03
grade: generated
check: pytest tests/laws/test_d03.py -k "start: guard"
bite: pytest tests/laws/test_d03_bite.py
bite-says: a shot started with an empty scale: no cup
frozen: [tests/laws/test_d03.py, tests/laws/machine_states.py]
scope: [src/dialin/cups.py]
timeout: 120
figure: figures/D-03.spec.json
---
# D-03 A shot starts only when the machine is ready

**Law.** Start is sent only when the machine is ready.

## A later heading
`;

function parse(text: string, id = "D-03"): ReturnType<typeof parseCard> {
  return parseCard(new TextEncoder().encode(text), id);
}

// The card above with one front matter line replaced, removed (null) or added.
function fullWith(key: string, line: string | null): string {
  const lines = FULL.split("\n");
  const at = lines.findIndex((candidate) => candidate.startsWith(`${key}:`));
  if (at === -1) lines.splice(1, 0, line ?? "");
  else if (line === null) lines.splice(at, 1);
  else lines[at] = line;
  return lines.join("\n");
}

function assertRejected(text: string, message: RegExp, id = "D-03"): void {
  assert.throws(() => parse(text, id), message);
  try {
    parse(text, id);
  } catch (error) {
    assert.ok(error instanceof CardError, "a bad card must be reported as a CardError");
  }
}

test("a full card is read as written", () => {
  assert.deepEqual(parse(FULL), {
    id: "D-03",
    grade: "generated",
    check: 'pytest tests/laws/test_d03.py -k "start: guard"',
    bite: "pytest tests/laws/test_d03_bite.py",
    biteSays: "a shot started with an empty scale: no cup",
    frozen: ["tests/laws/test_d03.py", "tests/laws/machine_states.py"],
    scope: ["src/dialin/cups.py"],
    timeout: 120,
    figure: "figures/D-03.spec.json",
    title: "A shot starts only when the machine is ready",
  });
});

test("only id and grade are required; the rest has defaults", () => {
  const card = parse("---\nid: P-01\ngrade: prose\n---\nSome words first.\n\n## The title\n", "P-01");
  assert.deepEqual(card, {
    id: "P-01",
    grade: "prose",
    check: null,
    bite: null,
    biteSays: null,
    frozen: [],
    scope: [],
    timeout: 60,
    figure: null,
    title: "The title",
  });
  assert.deepEqual(parse(fullWith("frozen", "frozen: []")).frozen, []);
});

test("unknown and duplicate keys are rejected", () => {
  assertRejected(fullWith("colour", "colour: green"), /unknown key "colour"/);
  assertRejected(fullWith("Grade", "Grade: prose"), /unknown key "Grade"/);
  assertRejected(fullWith("check", "check: true\ncheck: false"), /"check" appears twice/);
  assertRejected(fullWith("extra", " grade: prose"), /unknown key " grade"/);
});

test("a missing id, a wrong id and a bad id are rejected", () => {
  assertRejected(fullWith("id", null), /no "id"/);
  assertRejected(FULL, /does not match the file name/, "D-04");
  assertRejected(fullWith("id", "id: ../D-03"), /may only use/, "../D-03");
  assertRejected(fullWith("id", "id: D 03"), /may only use/, "D 03");
});

test("absolute paths and paths with .. are rejected, in every key that holds paths", () => {
  assertRejected(fullWith("frozen", "frozen: [/etc/passwd]"), /absolute/);
  assertRejected(fullWith("frozen", "frozen: [tests/../../outside.py]"), /contains "\.\."/);
  assertRejected(fullWith("frozen", "frozen: [..]"), /contains "\.\."/);
  assertRejected(fullWith("scope", "scope: [/src/a.py]"), /absolute/);
  assertRejected(fullWith("scope", "scope: [src/../a.py]"), /contains "\.\."/);
  assertRejected(fullWith("figure", "figure: /tmp/figure.spec.json"), /absolute/);
  assertRejected(fullWith("figure", "figure: ../figure.spec.json"), /contains "\.\."/);
});

test("a path has one spelling, and a list names a file once", () => {
  assertRejected(fullWith("frozen", "frozen: [./a.py]"), /empty or "\." part/);
  assertRejected(fullWith("frozen", "frozen: [tests//a.py]"), /empty or "\." part/);
  assertRejected(fullWith("frozen", "frozen: [a.py, a.py]"), /same file twice/);
  assertRejected(fullWith("frozen", "frozen: [a.py, ]"), /empty path/);
  assertRejected(fullWith("frozen", "frozen: a.py, b.py"), /must be a list/);
  assertRejected(fullWith("frozen", "frozen: [a.py, [b.py]]"), /contains/);
});

test("the files hashed with a card are its frozen files, its figure and the rendered text of the figure", () => {
  const card = parse(FULL);
  assert.equal(renderedFigure(card), "figures/D-03.txt");
  assert.deepEqual(hashedPaths(card), {
    required: ["tests/laws/test_d03.py", "tests/laws/machine_states.py", "figures/D-03.spec.json"],
    ifPresent: ["figures/D-03.txt"],
  });

  const noFigure = parse(fullWith("figure", null));
  assert.equal(renderedFigure(noFigure), null);
  assert.deepEqual(hashedPaths(noFigure).ifPresent, []);

  // A figure that is not a .spec.json has no rendered text. A file named twice is hashed once.
  const plain = parse(fullWith("figure", "figure: tests/laws/machine_states.py"));
  assert.deepEqual(hashedPaths(plain), { required: ["tests/laws/test_d03.py", "tests/laws/machine_states.py"], ifPresent: [] });
});

test("the grade must be one of the five", () => {
  for (const grade of ["every-case", "bounded", "generated", "chosen", "prose"]) {
    assert.equal(parse(fullWith("grade", `grade: ${grade}`)).grade, grade);
  }
  assertRejected(fullWith("grade", "grade: proven"), /"grade" must be one of/);
  assertRejected(fullWith("grade", null), /"grade" must be one of/);
  assertRejected(fullWith("grade", "grade: generated   # many cases"), /"grade" must be one of/);
});

test("the timeout is a whole number of seconds", () => {
  assert.equal(parse(fullWith("timeout", "timeout: 1")).timeout, 1);
  for (const bad of ["0", "-5", "1.5", "ten", "60s", "100000"]) {
    assertRejected(fullWith("timeout", `timeout: ${bad}`), /"timeout" must be a whole number/);
  }
});

test("the shape of the file is checked", () => {
  assertRejected(FULL.slice(4), /first line must be "---"/);
  assertRejected(`\n${FULL}`, /first line must be "---"/);
  assertRejected("---\nid: D-03\ngrade: prose\n# D-03 Title\n", /no closing "---"/);
  assertRejected("---\nid: D-03\ngrade: prose\n--- \n# D-03 Title\n", /no closing "---"/);
  assertRejected(fullWith("check", "check:"), /"check" has no value/);
  assertRejected(fullWith("check", "just words"), /not "key: value"/);
  assertRejected(fullWith("check", ""), /not "key: value"/);
  assertRejected(FULL.replaceAll("\n", "\r\n"), /carriage returns/);
  assertRejected("---\nid: D-03\ngrade: prose\n---\nNo heading here.\n", /no heading/);
  assertRejected("---\nid: D-03\ngrade: prose\n---\n# D-03 \n", /title is empty|no heading/);
});

test("a file that is not UTF-8, or that carries terminal escape codes, is rejected", () => {
  const bytes = Uint8Array.from([...new TextEncoder().encode(FULL), 0xff, 0xfe]);
  assert.throws(() => parseCard(bytes, "D-03"), /not valid UTF-8/);
  assertRejected(FULL.replace("A shot", "A shot\u001b[1A\u001b[2K"), /control characters/);
  assertRejected(`${FULL}\u0000`, /control characters/);
  assert.equal(parse(`${FULL}\tA tab and an accent are fine: é ║\n`).id, "D-03");
});

test("the eleven cards of this repository parse", () => {
  const folder = join(import.meta.dirname, "../laws");
  const ids = readdirSync(folder).filter((name) => name.endsWith(".md")).map((name) => name.slice(0, -3)).sort();
  assert.deepEqual(ids, ["T-01", "T-02", "T-03", "T-04", "T-05", "T-06", "T-07", "T-08", "T-09", "T-10", "T-11"]);
  for (const id of ids) {
    const card = parseCard(readFileSync(join(folder, `${id}.md`)), id);
    assert.equal(card.id, id);
    assert.equal(card.frozen.length, 2, `${id} freezes its check and its bite`);
    assert.ok(card.check !== null && card.bite !== null && card.biteSays !== null);
    assert.ok(!card.title.startsWith(id), "the title is shown without the id");
  }
});
