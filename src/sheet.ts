// laws sheet <id>: one law as a page a person can read and understand in a few minutes, in the slide format
// (arrow keys, F for full screen, D for night mode). It shows what is being signed: the sentences, the edges,
// the cases, examples that play one by one, the plain-words paraphrase, the exact Lean statement when the law has
// one, and the hash. It is a reading aid. It cannot approve anything: approving is "laws sign".
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { LawsError, loadCards } from "./cards.ts";

export type Slide =
  | { kind: "title"; id: string; title: string; grade: string; meaning: string; hash: string }
  | { kind: "text"; label: string; sentences: string[] }
  | { kind: "cases"; blocked: string[]; allowed: string[] }
  | { kind: "examples"; rows: { text: string; badge: string; why: string }[] }
  | { kind: "plain"; html: string }
  | { kind: "machine"; lines: string[] }
  | { kind: "code"; label: string; code: string }
  | { kind: "sign"; hash: string; files: string[] };

const GRADE_MEANING: Record<string, string> = {
  "every-case": "Checked for every possible input, by a proof or by trying every case.",
  bounded: "Checked for every input up to a stated size.",
  generated: "Checked on many generated inputs.",
  chosen: "Checked on hand-picked cases.",
  prose: "Words only. Nothing checks it.",
};

type Sections = { label: string; text: string }[];

// The body of a card: paragraphs that start with a bold label, like "**Law.** text".
export function sectionsOf(body: string): Sections {
  const out: Sections = [];
  for (const paragraph of body.split(/\n\s*\n/)) {
    const m = /^\*\*([^*]+?)\.?\*\*\.?\s*([\s\S]*)$/.exec(paragraph.trim());
    if (m) out.push({ label: (m[1] ?? "").replace(/\.$/, ""), text: (m[2] ?? "").replace(/\s*\n\s*/g, " ").trim() });
  }
  return out;
}

const sentencesOf = (text: string): string[] => text.split(/(?<=[.!?])\s+(?=[A-Z"(])/).map((s) => s.trim()).filter(Boolean);

// "A read 4 seconds after the last one, and the 41st read in an hour: refused." is one line, not one per comma.
const casesOf = (text: string): string[] => sentencesOf(text);

export function slidesOf(repo: string, id: string): Slide[] {
  const loaded = loadCards(repo).find((c) => c.id === id);
  if (loaded === undefined) throw new LawsError(`no card laws/${id}.md`);
  if (!loaded.ok) throw new LawsError(`laws/${id}.md is broken: ${loaded.problem}`);
  const { card, hash } = loaded;
  const raw = readFileSync(join(repo, "laws", `${id}.md`), "utf8");
  const body = raw.slice(raw.indexOf("\n---", 4) + 4);
  const sections = sectionsOf(body);
  const get = (label: string) => sections.find((s) => s.label.toLowerCase() === label.toLowerCase())?.text;

  const slides: Slide[] = [{ kind: "title", id, title: card.title.replace(new RegExp(`^${id}\\s*`), ""), grade: card.grade, meaning: GRADE_MEANING[card.grade] ?? "", hash: hash.slice(0, 16) }];
  for (const s of sections) {
    const label = s.label.toLowerCase();
    if (["blocked", "allowed", "checked by"].includes(label)) continue;
    slides.push({ kind: "text", label: s.label, sentences: sentencesOf(s.text) });
  }
  const blocked = get("Blocked");
  const allowed = get("Allowed");
  if (blocked || allowed) slides.push({ kind: "cases", blocked: casesOf(blocked ?? ""), allowed: casesOf(allowed ?? "") });

  const folder = join(repo, "laws", id);
  const lawFile = join(folder, "law.json");
  if (existsSync(join(folder, "examples.txt")) && existsSync(lawFile)) {
    const law = JSON.parse(readFileSync(lawFile, "utf8")) as { examples?: { columns: string[] }; sheet?: { yes?: string; no?: string } };
    const columns = law.examples?.columns ?? [];
    const rows = readFileSync(join(folder, "examples.txt"), "utf8").split("\n").filter((l) => l.trim() !== "" && !l.startsWith("#")).map((line) => {
      const cells = line.split("|").map((c) => c.trim());
      const by = Object.fromEntries(columns.map((c, i) => [c, cells[i] ?? ""]));
      const count = (v: string | undefined) => (v ?? "").split(/\s+/).filter(Boolean).length;
      const grew = count(by["result"]) > count(by["h"]);
      const yes = law.sheet?.yes ?? "allowed";
      const no = law.sheet?.no ?? "refused";
      const shown = columns.filter((c) => c !== "why" && c !== "result").map((c) => `${c} = ${by[c] === "" ? "none" : by[c]}`).join(", ");
      return { text: shown, badge: columns.includes("result") && columns.includes("h") ? (grew ? yes : no) : "", why: by["why"] ?? "" };
    });
    if (rows.length > 0) slides.push({ kind: "examples", rows });
  }
  if (existsSync(join(folder, "Paraphrase.md"))) slides.push({ kind: "plain", html: markdownLite(readFileSync(join(folder, "Paraphrase.md"), "utf8")) });
  const checked = get("Checked by");
  if (checked) slides.push({ kind: "machine", lines: [...sentencesOf(checked), ...(card.check ? ["The check: " + card.check] : []), ...(card.bite ? ["The bite (it must fail): " + card.bite] : [])] });
  if (existsSync(join(folder, "Challenge.lean"))) slides.push({ kind: "code", label: "The exact statement (Lean). Everything above is the same thing in words.", code: readFileSync(join(folder, "Challenge.lean"), "utf8") });
  slides.push({ kind: "sign", hash: hash, files: [`laws/${id}.md`, ...card.frozen] });
  return slides;
}

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Just enough Markdown for a paraphrase: headings, bullets, **bold**, `code`, paragraphs.
export function markdownLite(text: string): string {
  const inline = (s: string) => esc(s).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/`(.+?)`/g, "<code>$1</code>");
  const out: string[] = [];
  let list = false;
  for (const line of text.split("\n")) {
    const bullet = /^\s*(?:[-*]|\d+\.)\s+(.*)$/.exec(line);
    if (bullet) { if (!list) { out.push("<ul>"); list = true; } out.push(`<li>${inline(bullet[1] ?? "")}</li>`); continue; }
    if (list) { out.push("</ul>"); list = false; }
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) out.push(`<h3>${inline(h[2] ?? "")}</h3>`);
    else if (line.trim() !== "") out.push(`<p>${inline(line)}</p>`);
  }
  if (list) out.push("</ul>");
  return out.join("\n");
}

export function pageOf(slides: Slide[], heading: string): string {
  const data = JSON.stringify(slides).replace(/</g, "\\u003c");
  const page = readFileSync(join(import.meta.dirname, "sheet.page.html"), "utf8");
  return page.replace("__TITLE__", esc(heading)).replace("__DATA__", () => data);
}

export function sheetCommand(repo: string, id: string | undefined, out: string | null, print: (line: string) => void, write: (path: string, text: string) => void): number {
  if (id === undefined) throw new LawsError("usage: laws sheet <id> [--out <file>]");
  const slides = slidesOf(repo, id);
  const html = pageOf(slides, `law ${id}`);
  if (out === null) print(html);
  else { write(out, html); print(`wrote ${out} (${slides.length} slides). Open it in a browser. It shows the law; it cannot approve it.`); }
  return 0;
}
