import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { initProject, workflowText } from "../src/init.ts";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const CLI = join(import.meta.dirname, "../src/cli.ts");

test("init creates the laws folder and the CI check, pinned to one commit, and says what only the owner can do", () => {
  const dir = mkdtempSync(join(tmpdir(), "laws-init-"));
  try {
    const result = initProject(dir, SHA);
    assert.deepEqual(result.created.sort(), [".github/workflows/laws.yml", "laws/README.md"]);
    const workflow = readFileSync(join(dir, ".github/workflows/laws.yml"), "utf8");
    assert.ok(workflow.includes(`ref: ${SHA}`));
    assert.ok(workflow.includes("verify --signers \"$RUNNER_TEMP/allowed_signers\""));
    assert.ok(workflow.includes("vars.LAWS_SIGNERS"));
    assert.ok(!workflow.includes("UKAZ_READ_TOKEN"), "ukaz is public: no token is needed to fetch it");
    assert.ok(!workflow.includes("laws/allowed_signers"), "the signers file must not come from the repository");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("init never overwrites what is there", () => {
  const dir = mkdtempSync(join(tmpdir(), "laws-init-"));
  try {
    initProject(dir, SHA);
    writeFileSync(join(dir, ".github/workflows/laws.yml"), "mine\n");
    const again = initProject(dir, SHA);
    assert.deepEqual(again.created, []);
    assert.equal(again.kept.length, 2);
    assert.equal(readFileSync(join(dir, ".github/workflows/laws.yml"), "utf8"), "mine\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the workflow is the same text every time for the same commit", () => {
  assert.equal(workflowText(SHA), workflowText(SHA));
});

test("laws init on a missing folder fails with a plain message", () => {
  const run = spawnSync(process.execPath, [CLI, "init", join(tmpdir(), "laws-no-such-folder-x")], { encoding: "utf8" });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /does not exist/);
});
