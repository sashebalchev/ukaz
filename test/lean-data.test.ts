// The data half of the Lean gate: a table from the real system, frozen with the law, that must stay what the system says.
// No Lean needed. One test uses a real git repository with a tiny flake and is skipped where nix is not available.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { prepareData, staleData } from "../lean/gate.ts";

const data = (fresh?: string) => ({
  json: "curve.json", lean: "Data.lean", module: "FanData", name: "curve", columns: ["temp", "speed"],
  ...(fresh === undefined ? {} : { fresh }),
});
const law = (fresh?: string) => ({ data: data(fresh) });

function folder(json: string) {
  const dir = mkdtempSync(join(tmpdir(), "laws-lean-data-"));
  writeFileSync(join(dir, "curve.json"), json);
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test("the Lean module is generated from the JSON, and bad data is refused", () => {
  const f = folder('[{"speed":0,"temp":0},{"speed":30,"temp":62}]');
  try {
    assert.equal(prepareData(f.dir, law()), null);
    assert.match(readFileSync(join(f.dir, "Data.lean"), "utf8"), /def curve : List \(Nat × Nat\) := \[\(0, 0\), \(62, 30\)\]/);
    writeFileSync(join(f.dir, "curve.json"), '[{"speed":-1,"temp":0}]');
    assert.match(prepareData(f.dir, law()) ?? "", /whole numbers/);
    writeFileSync(join(f.dir, "curve.json"), '[{"speed":1.5,"temp":0}]');
    assert.match(prepareData(f.dir, law()) ?? "", /whole numbers/);
    writeFileSync(join(f.dir, "curve.json"), "not json");
    assert.match(prepareData(f.dir, law()) ?? "", /not JSON/);
  } finally {
    f.done();
  }
});

test("data that is the same as the system's, in any key order, is fresh; anything else is stale", async () => {
  const f = folder('[{"speed":0,"temp":0},{"speed":30,"temp":62}]');
  try {
    assert.equal(await staleData(f.dir, law("echo '[{\"temp\":0,\"speed\":0},{\"temp\":62,\"speed\":30}]'")), null);
    assert.match((await staleData(f.dir, law("echo '[{\"temp\":0,\"speed\":0},{\"temp\":70,\"speed\":30}]'"))) ?? "", /not what the system says now/);
    assert.match((await staleData(f.dir, law("false"))) ?? "", /could not ask the system/);
    assert.equal(await staleData(f.dir, law()), null, "a law without a fresh command has nothing to compare");
  } finally {
    f.done();
  }
});

const hasNix = spawnSync("nix", ["--version"]).status === 0 && spawnSync("git", ["--version"]).status === 0;

test("a change committed to the system's own repository makes the law stale (needs nix; passes without checking where it is missing)", async () => {
  if (!hasNix) return;
  const repo = mkdtempSync(join(tmpdir(), "laws-lean-flake-"));
  const f = folder('[{"speed":0,"temp":0},{"speed":30,"temp":62}]');
  const git = (...args: string[]) => spawnSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { encoding: "utf8" });
  const flake = (speed: number) => `{ outputs = _: { curve = [ { temp = 0; speed = 0; } { temp = 62; speed = ${speed}; } ]; }; }\n`;
  try {
    git("init", "-q", "-b", "main");
    writeFileSync(join(repo, "flake.nix"), flake(30));
    git("add", "-A");
    git("commit", "-q", "-m", "first");
    const fresh = `nix eval --json "git+file://${repo}?ref=main#curve"`;
    assert.equal(await staleData(f.dir, law(fresh)), null);
    writeFileSync(join(repo, "flake.nix"), flake(20));
    git("add", "-A");
    git("commit", "-q", "-m", "someone tunes the curve");
    assert.match((await staleData(f.dir, law(fresh))) ?? "", /not what the system says now/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    f.done();
  }
});
