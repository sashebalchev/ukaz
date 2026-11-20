import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { addProject, readProjects, removeProject } from "../src/projects.ts";

const CLI = join(import.meta.dirname, "../src/cli.ts");

function world() {
  const folder = mkdtempSync(join(tmpdir(), "laws-projects-"));
  const registry = join(folder, "config", "projects");
  const project = (name: string, card = true) => {
    const dir = join(folder, name);
    mkdirSync(join(dir, "laws"), { recursive: true });
    if (card) writeFileSync(join(dir, "laws", "A-01.md"), "---\nid: A-01\ngrade: prose\n---\n# A-01 A law\n");
    return dir;
  };
  return { folder, registry, project, done: () => rmSync(folder, { recursive: true, force: true }) };
}

test("a project is added once, in order, and removed again", () => {
  const w = world();
  try {
    const b = w.project("b");
    const a = w.project("a");
    addProject(w.registry, b);
    addProject(w.registry, a);
    addProject(w.registry, a);
    assert.deepEqual(readProjects(w.registry), [a, b]);
    assert.equal(removeProject(w.registry, a), true);
    assert.equal(removeProject(w.registry, a), false);
    assert.deepEqual(readProjects(w.registry), [b]);
  } finally {
    w.done();
  }
});

test("a folder without laws/ is not a project", () => {
  const w = world();
  try {
    mkdirSync(join(w.folder, "plain"));
    assert.throws(() => addProject(w.registry, join(w.folder, "plain")), /has no laws\/ folder/);
    assert.deepEqual(readProjects(w.registry), []);
  } finally {
    w.done();
  }
});

test("laws status --all goes through every project and says which one cannot be read", () => {
  const w = world();
  try {
    const good = w.project("good");
    const broken = w.project("broken", false);
    writeFileSync(join(broken, "laws", "A-01.md"), "not a card\n");
    const env = { ...process.env, LAWS_PROJECTS: w.registry, LAWS_SIGNERS: undefined };
    for (const dir of [good, broken]) assert.equal(spawnSync(process.execPath, [CLI, "projects", "add", dir], { encoding: "utf8", env }).status, 0);
    const run = spawnSync(process.execPath, [CLI, "status", "--all", "--signers", join(w.folder, "none")], { encoding: "utf8", env });
    assert.match(run.stdout, new RegExp(`== ${good}`));
    assert.match(run.stdout, new RegExp(`== ${broken}`));
    assert.match(run.stdout, /A-01 +prose +unverified/);
    assert.match(run.stdout, /A-01 +\? +broken/);
    const list = spawnSync(process.execPath, [CLI, "projects"], { encoding: "utf8", env });
    assert.equal(list.stdout.trim().split("\n").length, 2);
    assert.ok(readFileSync(w.registry, "utf8").startsWith("# Projects"));
  } finally {
    w.done();
  }
});
