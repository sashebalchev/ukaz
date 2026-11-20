// The Lean half of a law whose grade is every-case: a statement a person signs, a proof an agent wrote, and a
// gate that decides. Two commands, run from a project's root:
//
//   gate <lawdir>   every check below; prints ALL LAWS HOLD or SOME LAWS FAIL: <why>; exit 0 only if all hold
//   bite <lawdir>   runs the gate on deliberately broken copies; each must be rejected. Exit 1 and the text
//                   "REJECTED all" mean every broken copy was rejected (that is the failure a bite needs);
//                   exit 0 means a broken copy got through, so the law has no teeth.
//
// A law folder (for example laws/P-01/) holds, written by the law author and frozen by the card:
//   Challenge.lean   the statement, proofs left as sorry        comparator.json  what the comparator judges
//   lakefile.toml, lean-toolchain, law.json                     Paraphrase.md, examples.txt
//   Bites.lean       wrong versions that the law must refute    Unique.lean      the law fixes one behaviour
//   sabotage.txt     one broken edit per line, see below
// and, written by the agent and not frozen: Solution.lean (and Main.lean when the law has a program).
//
// sabotage.txt: each non-empty line is "Solution: <sed expression>" or "Main: <sed expression>". The bite applies
// it to a copy and the gate must reject the copy. Generic cheats (sorry, native_decide, an opaque False) are
// always tried.
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runCommand } from "../src/run.ts";

const FORBIDDEN = [
  "sorry", "axiom", "native_decide", "partial", "unsafe", "implemented_by", "extern", "opaque", "macro",
  "macro_rules", "syntax", "elab", "run_cmd", "ofReduceBool", "trustCompiler", "initialize", "builtin_initialize",
  "set_option",
];
const ALLOWED_AXIOMS = new Set(["propext", "Quot.sound", "Classical.choice"]);
const STEP_SECONDS = 300;

// data: a table the law is about, taken from the real system. It is frozen with the law as a JSON file; the gate turns it
// into a Lean module (never edited by hand) and, if "fresh" is given, runs that command and fails when the system no
// longer says the same thing, so a change to the system voids the law until it is read and signed again.
type Data = { json: string; lean: string; module: string; name: string; columns: string[]; fresh?: string };
type Law = { exe?: string; minBites?: number; minExamples?: number; unique?: string; examples?: Examples; data?: Data };
type Examples = { columns: string[]; stdin: string; stdout: string; kernel?: string; module?: string };
type Verdict = { ok: boolean; reason: string };

// ---- reading Lean text without its comments and strings, so a word in a comment does not trip the gate ----

export function codeOnly(text: string): string {
  let out = "";
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const two = text.slice(i, i + 2);
    if (two === "/-") { depth++; i++; continue; }
    if (depth > 0) { if (two === "-/") { depth--; i++; } continue; }
    if (two === "--") { while (i < text.length && text[i] !== "\n") i++; out += "\n"; continue; }
    if (text[i] === '"') { i++; while (i < text.length && text[i] !== '"') { if (text[i] === "\\") i++; i++; } out += '""'; continue; }
    out += text[i];
  }
  return out;
}

// Why a file of the agent is not allowed, or null.
export function forbidden(file: string, text: string, allowedImports: string[]): string | null {
  const code = codeOnly(text);
  for (const word of FORBIDDEN) {
    if (new RegExp(`(^|[^A-Za-z0-9_.'])${word}([^A-Za-z0-9_']|$)`).test(code)) return `${file} uses "${word}", which the gate bans`;
  }
  for (const [, name] of code.matchAll(/^import\s+(\S+)/gm)) {
    const ok = allowedImports.some((a) => name === a || name?.startsWith(a + "."));
    if (!ok) return `${file} imports ${name}; only ${allowedImports.join(", ")} are allowed`;
  }
  return null;
}

// ---- the gate ----

async function lake(dir: string, args: string, seconds = STEP_SECONDS) {
  return runCommand(`lake ${args}`, dir, seconds);
}

async function toolchainProblem(dir: string): Promise<string | null> {
  const version = await runCommand("lean --version", dir, 60);
  const pinned = readFileSync(join(dir, "lean-toolchain"), "utf8").trim().replace(/^.*:v?/, "");
  const have = /version ([0-9.]+(?:-rc[0-9]+)?)/.exec(version.output)?.[1] ?? "unknown";
  return have === pinned ? null : `lean-toolchain pins ${pinned} but ${have} is installed`;
}

// Writes the Lean module for the law's data from its JSON file. Returns a problem, or null.
export function prepareData(dir: string, law: Law): string | null {
  const data = law.data;
  if (data === undefined) return null;
  let rows: unknown;
  try { rows = JSON.parse(readFileSync(join(dir, data.json), "utf8")); } catch { return `${data.json} is missing or is not JSON`; }
  if (!Array.isArray(rows)) return `${data.json} must be a list`;
  const tuples: string[] = [];
  for (const row of rows as Record<string, unknown>[]) {
    const cells = data.columns.map((c) => row[c]);
    if (!cells.every((v) => typeof v === "number" && Number.isInteger(v) && v >= 0)) return `${data.json}: every row needs whole numbers, 0 or more, in ${data.columns.join(", ")}`;
    tuples.push(`(${cells.join(", ")})`);
  }
  const arity = data.columns.length === 1 ? "Nat" : data.columns.map(() => "Nat").join(" × ");
  writeFileSync(join(dir, data.lean), `-- Generated from ${data.json} by the gate. Do not edit.\nnamespace ${data.module}\n\ndef ${data.name} : List (${arity}) := [${tuples.join(", ")}]\n\nend ${data.module}\n`);
  return null;
}

// The data must still be what the system says. Returns a problem, or null.
async function staleData(dir: string, law: Law): Promise<string | null> {
  const data = law.data;
  if (data?.fresh === undefined) return null;
  const run = await runCommand(data.fresh, dir, 180);
  if (run.exitCode !== 0) return `could not ask the system for its data: ${run.output.trim().split("\n").slice(-2).join(" | ")}`;
  let now: unknown;
  try { now = JSON.parse(run.output.slice(run.output.indexOf("[")).trim()); } catch { return "the system's answer is not JSON"; }
  const mine = JSON.parse(readFileSync(join(dir, data.json), "utf8")) as unknown;
  const norm = (v: unknown) => JSON.stringify(v, (_k, x: unknown) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x));
  return norm(now) === norm(mine) ? null : `the data in ${data.json} is not what the system says now. Extract it again, read the law again and sign it again.`;
}

const AUTHOR_FILES = ["Challenge.lean", "comparator.json", "lakefile.toml", "lean-toolchain", "law.json", "Paraphrase.md", "examples.txt", "Bites.lean"];
// Unique.lean (the law fixes one behaviour) belongs to laws about a function; a law about a given table has none.
const authorFiles = (law: Law): string[] => [...AUTHOR_FILES, ...(law.unique ? ["Unique.lean"] : [])];

// Everything that can be checked before a solution exists: the pinned toolchain, the author's files build, only the
// statement uses sorry, and the law is strong. This is what lets a law be read, bitten and signed before anyone builds.
export async function statementChecks(dir: string, say: (line: string) => void): Promise<Verdict> {
  if (!existsSync(join(dir, "law.json"))) return { ok: false, reason: `law.json is missing in ${dir}` };
  const law = JSON.parse(readFileSync(join(dir, "law.json"), "utf8")) as Law;
  for (const name of authorFiles(law)) if (!existsSync(join(dir, name))) return { ok: false, reason: `${name} is missing in ${dir}` };
  const wrong = await toolchainProblem(dir);
  if (wrong !== null) return { ok: false, reason: wrong };
  const dataProblem = prepareData(dir, law);
  if (dataProblem !== null) return { ok: false, reason: dataProblem };
  const stale = await staleData(dir, law);
  if (stale !== null) return { ok: false, reason: stale };
  say("== the statement and the author's files build");
  const built = await lake(dir, `build Challenge Bites${law.unique ? " Unique" : ""}`);
  if (built.exitCode !== 0) return { ok: false, reason: `the build failed: ${built.output.trim().split("\n").slice(-6).join(" | ")}` };
  const sorried = /(Bites|Unique)\.lean:\d+:\d+: warning: declaration uses/.exec(built.output);
  if (sorried) return { ok: false, reason: `a declaration in ${sorried[1]}.lean uses sorry` };
  const strongVerdict = await strong(dir, law, say);
  if (!strongVerdict.ok) return strongVerdict;
  // When the examples only use the statement's own definitions, they are part of what is signed and are checked now.
  if (law.examples?.kernel && law.examples.module === "Challenge") {
    say("== every example row holds for the kernel");
    const rowsOk = await examples(dir, law, true);
    rmSync(join(dir, "ExamplesCheck.lean"), { force: true });
    if (!rowsOk.ok) return rowsOk;
    say(`   ${rowsOk.reason}`);
  }
  return { ok: true, reason: "the statement checks out" };
}

export async function gate(dir: string, say: (line: string) => void): Promise<Verdict> {
  const fail = (reason: string): Verdict => ({ ok: false, reason });
  if (!existsSync(join(dir, "law.json"))) return fail(`law.json is missing in ${dir}`);
  const law = JSON.parse(readFileSync(join(dir, "law.json"), "utf8")) as Law;
  for (const name of [...authorFiles(law), "Solution.lean"]) {
    if (!existsSync(join(dir, name))) return fail(`${name} is missing in ${dir}`);
  }
  const generated = ["AxiomsCheck.lean", "ExamplesCheck.lean"].map((n) => join(dir, n));
  const dataProblem = prepareData(dir, law);
  if (dataProblem !== null) return fail(dataProblem);
  try {
    say("== 1. the toolchain is the pinned one");
    const wrong = await toolchainProblem(dir);
    if (wrong !== null) return fail(wrong);

    const stale = await staleData(dir, law);
    if (stale !== null) return fail(stale);

    say("== 2. the agent's files use nothing the gate bans");
    const mainExists = existsSync(join(dir, "Main.lean"));
    const dataModules = law.data ? [law.data.module === "Data" ? "Data" : law.data.lean.replace(/\.lean$/, "")] : [];
    const bad = forbidden("Solution.lean", readFileSync(join(dir, "Solution.lean"), "utf8"), ["Std", "Init", ...dataModules])
      ?? (mainExists ? forbidden("Main.lean", readFileSync(join(dir, "Main.lean"), "utf8"), ["Std", "Init", "Solution", ...dataModules]) : null);
    if (bad !== null) return fail(`forbidden construct: ${bad}`);

    say("== 3. everything builds, and nothing but the statement uses sorry");
    const targets = ["Challenge", "Solution", "Bites", ...(law.unique ? ["Unique"] : []), ...(law.exe ? [law.exe] : [])].join(" ");
    const built = await lake(dir, `build ${targets}`);
    if (built.exitCode !== 0) return fail(`the build failed: ${built.output.trim().split("\n").slice(-6).join(" | ")}`);
    const sorried = /(Solution|Bites|Unique|Main)\.lean:\d+:\d+: warning: declaration uses/.exec(built.output);
    if (sorried) return fail(`a declaration in ${sorried[1]}.lean uses sorry`);

    say("== 4. comparator: the solution proves the signed statement, with the allowed axioms, and the kernel replays it");
    const compared = await lake(dir, "comparator");
    if (compared.exitCode !== 0 || !compared.output.includes("Your solution is okay!")) {
      return fail(`comparator rejected the solution: ${compared.output.trim().split("\n").slice(-4).join(" | ")}`);
    }

    const strongVerdict = await strong(dir, law, say);
    if (!strongVerdict.ok) return strongVerdict;

    if (law.examples) {
      say("== 6. every example row holds for the kernel and for the compiled program");
      const v = await examples(dir, law);
      if (!v.ok) return v;
      say(`   ${v.reason}`);
    }
    return { ok: true, reason: "all checks passed" };
  } finally {
    for (const f of generated) rmSync(f, { force: true });
  }
}

// Wrong versions are refuted, one behaviour is fixed, and nothing there uses sorry or an extra axiom. This needs only
// the statement and the author's files, not a solution, so it can be checked before anyone has written one.
async function strong(dir: string, law: Law, say: (line: string) => void): Promise<Verdict> {
  const fail = (reason: string): Verdict => ({ ok: false, reason });
  say("== the law is strong: wrong versions are refuted, one behaviour is fixed, no sorry or extra axioms");
  const files = ["Bites.lean", ...(law.unique ? ["Unique.lean"] : [])];
  const names = files.flatMap((f) => [...readFileSync(join(dir, f), "utf8").matchAll(/^theorem\s+([A-Za-z0-9_.']+)/gm)].map((m) => m[1] ?? ""));
  const bites = names.filter((n) => /^bad.*_bad$/.test(n)).length;
  if (bites < (law.minBites ?? 8)) return fail(`only ${bites} wrong versions are refuted; the law asks for ${law.minBites ?? 8}`);
  if (law.unique && !names.includes(law.unique)) return fail(`Unique.lean has no theorem ${law.unique}`);
  const ns = /^namespace\s+(\S+)/m.exec(readFileSync(join(dir, "Bites.lean"), "utf8"))?.[1];
  writeFileSync(join(dir, "AxiomsCheck.lean"), ["import Bites", ...(law.unique ? ["import Unique"] : []), ...names.map((n) => `#print axioms ${ns ? ns + "." : ""}${n}`)].join("\n") + "\n");
  const axioms = await lake(dir, "env lean AxiomsCheck.lean");
  rmSync(join(dir, "AxiomsCheck.lean"), { force: true });
  if (axioms.exitCode !== 0) return fail(`could not list axioms: ${axioms.output.trim().split("\n").slice(-3).join(" | ")}`);
  if (/sorryAx|ofReduceBool/.test(axioms.output)) return fail("a theorem in Bites.lean or Unique.lean depends on sorry or a compiler axiom");
  for (const [, list] of axioms.output.matchAll(/depends on axioms: \[([^\]]*)\]/g)) {
    for (const a of (list ?? "").split(",").map((s) => s.trim()).filter(Boolean)) if (!ALLOWED_AXIOMS.has(a)) return fail(`an extra axiom is used: ${a}`);
  }
  say(`   ${names.length} theorems, ${bites} wrong versions refuted, axioms only propext, Quot.sound, Classical.choice`);
  return { ok: true, reason: "strong" };
}

const fill = (template: string, row: Record<string, string>) =>
  template.replace(/\{(\w+)(?::(list))?\}/g, (_, key: string, mode: string | undefined) => {
    const value = (row[key] ?? "").trim();
    return mode === "list" ? value.split(/\s+/).filter(Boolean).join(", ") : value;
  });

async function examples(dir: string, law: Law, kernelOnly = false): Promise<Verdict> {
  const spec = law.examples as Examples;
  const rows = readFileSync(join(dir, "examples.txt"), "utf8").split("\n").filter((l) => l.trim() !== "" && !l.startsWith("#")).map((line) => {
    const cells = line.split("|").map((c) => c.trim());
    return Object.fromEntries(spec.columns.map((name, i) => [name, cells[i] ?? ""]));
  });
  if (rows.length < (law.minExamples ?? 10)) return { ok: false, reason: `only ${rows.length} example rows; the law asks for ${law.minExamples ?? 10}` };
  if (spec.kernel) {
    const lines = rows.map((r) => `example : ${fill(spec.kernel as string, r)} := by decide`);
    writeFileSync(join(dir, "ExamplesCheck.lean"), [`import ${spec.module ?? "Solution"}`, "set_option maxRecDepth 20000", ...lines].join("\n") + "\n");
    const run = await lake(dir, "env lean ExamplesCheck.lean");
    if (run.exitCode !== 0) return { ok: false, reason: `the kernel disagrees with an example row: ${run.output.trim().split("\n").slice(0, 3).join(" | ")}` };
  }
  if (law.exe && !kernelOnly) {
    const input = rows.map((r) => fill(spec.stdin, r).replace(/\s+/g, " ").trim()).join("\n") + "\n";
    writeFileSync(join(dir, ".examples-input"), input);
    const run = await runCommand(`./.lake/build/bin/${law.exe} < .examples-input`, dir, 60); // the built program itself, not "lake exe", which prints build messages
    rmSync(join(dir, ".examples-input"), { force: true });
    if (run.exitCode !== 0) return { ok: false, reason: `the program failed on the examples: ${run.output.trim().split("\n").slice(-2).join(" | ")}` };
    const out = run.output.split("\n");
    for (const [i, r] of rows.entries()) {
      const want = fill(spec.stdout, r).replace(/\s+/g, " ").trim();
      if ((out[i] ?? "").replace(/\s+/g, " ").trim() !== want) return { ok: false, reason: `the program disagrees on row ${i + 1}: wanted "${want}", got "${(out[i] ?? "").trim()}"` };
    }
  }
  return { ok: true, reason: `${rows.length} rows agree${spec.kernel ? " with the kernel" : ""}${law.exe ? " and with the compiled program" : ""}` };
}

// ---- the bite ----

async function copyOf(dir: string): Promise<string> {
  const copy = mkdtempSync(join(tmpdir(), "laws-lean-bite-"));
  await runCommand(`cp -r . '${copy}'`, dir, 60);
  rmSync(join(copy, ".lake"), { recursive: true, force: true });
  return copy;
}

export async function bite(dir: string, say: (line: string) => void): Promise<number> {
  if (!existsSync(join(dir, "Solution.lean"))) return biteBeforeSolution(dir, say);
  const cheats: { name: string; file: "Solution" | "Main" | "Data"; edit: (text: string) => string | null; sed?: string }[] = [
    { name: "a proof ends in sorry", file: "Solution", edit: (t) => t + "\ntheorem zz_cheat : False := sorry\n" },
    { name: "a proof uses native_decide", file: "Solution", edit: (t) => t + "\ntheorem zz_cheat : 1 = 1 := by native_decide\n" },
    { name: "an opaque False is introduced", file: "Solution", edit: (t) => t + "\nopaque zz_cheat : False\n" },
  ];
  const sabotage = existsSync(join(dir, "sabotage.txt")) ? readFileSync(join(dir, "sabotage.txt"), "utf8").split("\n").filter((l) => l.trim() !== "" && !l.startsWith("#")) : [];
  for (const line of sabotage) {
    const m = /^(Solution|Main|Data):\s*(.+)$/.exec(line);
    if (!m) { say(`sabotage.txt: cannot read the line "${line}"`); return 0; }
    cheats.push({ name: `edit ${line}`, file: m[1] as "Solution" | "Main" | "Data", edit: () => null, sed: m[2] as string });
  }
  for (const cheat of cheats) {
    const copy = await copyOf(dir);
    try {
      const lawCopy = JSON.parse(readFileSync(join(copy, "law.json"), "utf8")) as Law;
      const target = join(copy, cheat.file === "Data" ? (lawCopy.data?.json ?? "data.json") : `${cheat.file}.lean`);
      const before = readFileSync(target, "utf8");
      if (cheat.sed !== undefined) {
        await runCommand(`sed -E -i '${cheat.sed.replace(/'/g, "'\\''")}' '${target}'`, copy, 30);
        if (readFileSync(target, "utf8") === before) { say(`NOT APPLIED: ${cheat.name} changed nothing, so it proves nothing`); return 0; }
      } else {
        writeFileSync(target, cheat.edit(before) ?? before);
      }
      const verdict = await gate(copy, () => {});
      if (verdict.ok) { say(`ACCEPTED: ${cheat.name}. The gate let a broken solution through.`); return 0; }
      say(`rejected: ${cheat.name} (${verdict.reason.slice(0, 110)})`);
    } finally {
      rmSync(copy, { recursive: true, force: true });
    }
  }
  say(`REJECTED all ${cheats.length} broken variants`);
  return 1;
}

// Before a solution exists (a law is read and signed first): the statement's own checks must pass, and the bare
// statement, which only has sorry where the proofs go, must be rejected as a solution.
async function biteBeforeSolution(dir: string, say: (line: string) => void): Promise<number> {
  const statement = await statementChecks(dir, () => {});
  if (!statement.ok) { say(`THE STATEMENT'S OWN CHECKS FAIL: ${statement.reason}`); return 0; }
  say("the statement builds, its wrong versions are refuted, and the law fixes one behaviour");
  const copy = await copyOf(dir);
  try {
    writeFileSync(join(copy, "Solution.lean"), readFileSync(join(dir, "Challenge.lean"), "utf8"));
    const verdict = await gate(copy, () => {});
    if (verdict.ok) { say("ACCEPTED: the bare statement passed as a solution. The gate has no teeth."); return 0; }
    say(`rejected: the bare statement is not a solution (${verdict.reason.slice(0, 110)})`);
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
  say("REJECTED all 1 broken variants (no solution yet: the full set is tried once there is one)");
  return 1;
}

// ---- command line ----

if (import.meta.main) {
  const [command, dirArg] = process.argv.slice(2);
  if ((command !== "gate" && command !== "bite") || dirArg === undefined) {
    console.error("usage: gate.ts gate|bite <lawdir>");
    process.exit(2);
  }
  const dir = resolve(dirArg);
  if (command === "gate") {
    const verdict = await gate(dir, (l) => console.log(l));
    console.log(verdict.ok ? "ALL LAWS HOLD" : `SOME LAWS FAIL: ${verdict.reason}`);
    process.exit(verdict.ok ? 0 : 1);
  }
  process.exit(await bite(dir, (l) => console.log(l)));
}
