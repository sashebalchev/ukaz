// laws sheet: the readable slide page for one law. No Lean needed: it reads the card and its folder.
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { markdownLite, pageOf, sectionsOf, slidesOf } from "../src/sheet.ts";

const PACER = join(import.meta.dirname, "../examples/pacer");

test("a card body is read as labelled sections", () => {
  const sections = sectionsOf("# Title\n\n**Law.** One. Two.\n\n**Why.** Because\nit matters.\n\nloose text\n");
  assert.deepEqual(sections, [
    { label: "Law", text: "One. Two." },
    { label: "Why", text: "Because it matters." },
  ]);
});

test("the pacer law becomes a title, its sentences, cases, examples, plain words, checks, the statement and what is signed", () => {
  const slides = slidesOf(PACER, "P-01");
  assert.deepEqual(slides.map((s) => s.kind), ["title", "text", "text", "text", "cases", "examples", "plain", "machine", "code", "sign"]);
  const title = slides[0];
  assert.ok(title?.kind === "title" && title.id === "P-01" && title.grade === "every-case" && /^[0-9a-f]{16}$/.test(title.hash));
  const examples = slides.find((s) => s.kind === "examples");
  if (examples?.kind !== "examples") throw new Error("no examples slide");
  assert.equal(examples.rows.length, 25);
  assert.ok(examples.rows.every((r) => r.badge === "allowed" || r.badge === "refused"));
  assert.equal(examples.rows.filter((r) => r.badge === "refused").length, 13);
  const sign = slides[slides.length - 1];
  assert.ok(sign?.kind === "sign" && sign.files[0] === "laws/P-01.md" && sign.files.includes("laws/P-01/Challenge.lean"));
});

test("the hash on the title is the same every time for the same files", () => {
  const a = slidesOf(PACER, "P-01")[0];
  const b = slidesOf(PACER, "P-01")[0];
  assert.ok(a?.kind === "title" && b?.kind === "title" && a.hash === b.hash);
});

test("text in the data cannot close the script of the page", () => {
  const page = pageOf([{ kind: "code", label: "x", code: "</script><script>alert(1)</script>" }], "t");
  const data = page.slice(page.indexOf("const S=") + 8, page.indexOf(";\nconst stage"));
  assert.ok(!data.includes("</script>") && !data.includes("<"));
  assert.deepEqual(JSON.parse(data), [{ kind: "code", label: "x", code: "</script><script>alert(1)</script>" }]);
});

test("a paraphrase is shown without raw HTML", () => {
  const html = markdownLite("## Head\n- **bold** and `code`\n<script>x</script>\n");
  assert.ok(html.includes("<h3>Head</h3>") && html.includes("<b>bold</b>") && html.includes("<code>code</code>"));
  assert.ok(!html.includes("<script>"));
});

test("an unknown card is an error that says so", () => {
  assert.throws(() => slidesOf(PACER, "Z-99"), /no card laws\/Z-99\.md/);
});
