// The check of law T-03 (laws/T-03.md): the laws command cannot sign.
// This file and its bite are frozen with the card, so everything the check means is written here.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadCards } from "../../src/cards.ts";
import { startStandIn } from "../standin.ts";
import type { Lie } from "../standin.ts";

// What is under test: "laws sign" on the world's repository, with the address of this signing server or
// with none. It returns the exit code.
export type Sign = (world: World, server: string | null) => Promise<number | null>;

// A temporary folder: a repository with two cards that nobody approved, the owner's key and the signers
// file that names it, a stranger's key, and a home folder. The owner's key also lies in <home>/.ssh,
// where a program that wanted to sign by itself would look.
export type World = {
  folder: string;
  repo: string;
  signers: string;
  home: string;
  ownerKey: string;
  strangerKey: string;
  log: string;
};

const SOURCES = join(import.meta.dirname, "../../src");
const CLI = join(SOURCES, "cli.ts");

// ---- The property. The bite runs the same functions against broken variants. ----

// Blocked by the law: "laws sign" is run with no signing server to ask. It fails and writes nothing.
export async function blockedNoSigner(sign: Sign): Promise<void> {
  await withWorld(async (world) => {
    const before = snapshot(world.repo);
    assert.notEqual(await sign(world, null), 0, "laws sign succeeded without a signer");
    assert.equal(snapshot(world.repo), before, "laws sign wrote to the repository without a signer");

    assert.notEqual(await sign(world, "http://127.0.0.1:9/"), 0, "laws sign succeeded with a signing server that is not there");
    assert.equal(snapshot(world.repo), before, "laws sign wrote to the repository although the signing server is not there");
  });
}

// Allowed by the law: "laws sign" posts the batch to the signing server, whose approver signs it with
// the owner's key. laws checks what comes back, and stores it.
export async function allowedSignerSigns(sign: Sign): Promise<void> {
  await withWorld(async (world) => {
    await withApprover(world, world.ownerKey, null, async (server) => {
      assert.equal(await sign(world, server), 0, "laws sign failed with a good signing server");
    });

    const folder = join(world.repo, "laws", "approvals");
    const names = existsSync(folder) ? readdirSync(folder).sort() : [];
    assert.equal(names.length, 2, `expected one manifest and its signature, found: ${names.join(", ")}`);
    const [manifest, signature] = names.map((name) => join(folder, name));
    assert.ok(manifest?.endsWith(".manifest") && signature === `${manifest}.sig`, `unexpected names: ${names.join(", ")}`);

    const lines = loadCards(world.repo).map((card) => (card.ok ? `${card.id} ${card.hash}` : "broken"));
    const stored = readFileSync(manifest ?? "", "utf8").split("\n");
    assert.match(stored[0] ?? "", /^signed: /, "the stored manifest does not start with the time it was signed");
    assert.deepEqual(stored.slice(1), [...lines, ""], "the stored manifest is not the two cards as they are");
    const options = ["-Y", "verify", "-f", world.signers, "-I", "owner", "-n", "laws", "-s", signature ?? ""];
    const verified = spawnSync("ssh-keygen", options, { input: readFileSync(manifest ?? ""), encoding: "utf8" });
    assert.equal(verified.status, 0, "the stored signature does not verify against the signers file");
    assert.equal(readFileSync(world.log, "utf8").trim().split("\n").length, 1, "the approver was not asked exactly once");
  });
}

// A signature is stored only after it was verified: a signing server whose approver has a key nobody
// named, and servers that hand back another list than the one that was asked about (with the right
// key: a hash that nobody computed from the card, and a card that was never asked) all leave the
// repository as it was.
export async function storesOnlyWhatVerifies(sign: Sign): Promise<void> {
  await withWorld(async (world) => {
    const before = snapshot(world.repo);
    await withApprover(world, world.strangerKey, null, async (server) => {
      assert.notEqual(await sign(world, server), 0, "a signature by an unknown key was accepted");
    });
    assert.equal(snapshot(world.repo), before, "a signature by an unknown key was stored");
  });
  for (const lie of ["hash", "card"] as const) {
    await withWorld(async (world) => {
      const before = snapshot(world.repo);
      await withApprover(world, world.ownerKey, lie, async (server) => {
        assert.notEqual(await sign(world, server), 0, "a signature over another list than asked was accepted");
      });
      assert.equal(snapshot(world.repo), before, "a signature over another list than asked was stored");
    });
  }
}

// The source of the laws command has no way to sign: it runs ssh-keygen only to verify, uses no
// signing function, touches no private key, and imports nothing from outside src/.
export function findWaysToSign(sources: Map<string, string>): string[] {
  const found: string[] = [];
  for (const [file, text] of sources) {
    const says = (what: string): void => {
      found.push(`${file} ${what}`);
    };
    for (const [, from] of text.matchAll(/\bfrom\s+"([^"]+)"/g)) {
      if (!from?.startsWith("node:") && !from?.startsWith("./")) says(`imports from ${from}`);
    }
    if (/\b(sign|createSign|createPrivateKey|generateKeyPair|generateKeyPairSync)\s*\(/.test(text)) {
      says("calls a function that signs or makes a key");
    }
    if (/PRIVATE KEY|id_ed25519|id_rsa|id_ecdsa|\.ssh\b/.test(text)) says("mentions a private key or ~/.ssh");
    if (/ssh-keygen|"-Y"/.test(text) && file !== "approvals.ts") says("runs ssh-keygen outside approvals.ts");
    const uses = [...text.matchAll(/-Y\b["',\s]*([A-Za-z-]*)/g)].map((match) => match[1]);
    for (const use of uses) {
      if (use !== "find-principals" && use !== "verify") says(`runs ssh-keygen -Y ${use}`);
    }
  }
  return found;
}

export function readSources(): Map<string, string> {
  const files = readdirSync(SOURCES).filter((name) => name.endsWith(".ts"));
  return new Map(files.map((name) => [name, readFileSync(join(SOURCES, name), "utf8")]));
}

// A signing server whose approver signs with this key, or, with lie, whose answers are not true.
// See test/standin.ts. It stops when the body is done.
async function withApprover(world: World, key: string, lie: Lie | null, body: (server: string) => Promise<void>): Promise<void> {
  const approver = await startStandIn(world.folder, key, world.log, lie);
  try {
    await body(approver.url);
  } finally {
    await approver.stop();
  }
}

async function withWorld(body: (world: World) => Promise<void>): Promise<void> {
  const folder = mkdtempSync(join(tmpdir(), "laws-t03-"));
  try {
    const world = {
      folder,
      repo: join(folder, "repo"),
      signers: join(folder, "allowed_signers"),
      home: join(folder, "home"),
      ownerKey: join(folder, "owner-key"),
      strangerKey: join(folder, "stranger-key"),
      log: join(folder, "approver.log"),
    };
    mkdirSync(join(world.repo, "laws"), { recursive: true });
    mkdirSync(join(world.home, ".ssh"), { recursive: true });
    for (const id of ["A-01", "A-02"]) {
      const bite = "bite: echo the blocked case was caught; exit 1\nbite-says: the blocked case was caught\n";
      const frontMatter = `---\nid: ${id}\ngrade: chosen\ncheck: true\n${bite}---\n`;
      writeFileSync(join(world.repo, "laws", `${id}.md`), `${frontMatter}# ${id} A law\n`);
    }
    run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", world.ownerKey]);
    run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", world.strangerKey]);
    writeFileSync(world.signers, `owner ${readFileSync(`${world.ownerKey}.pub`, "utf8")}`);
    writeFileSync(join(world.home, ".ssh", "id_ed25519"), readFileSync(world.ownerKey), { mode: 0o600 });
    await body(world);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

// Every path under a folder with what it holds, to see whether anything changed.
function snapshot(folder: string): string {
  const seen: string[] = [];
  const walk = (path: string): void => {
    if (lstatSync(path).isDirectory()) {
      seen.push(`${path} folder`);
      for (const name of readdirSync(path).sort()) walk(join(path, name));
    } else {
      seen.push(`${path} ${createHash("sha256").update(readFileSync(path)).digest("hex")}`);
    }
  };
  walk(folder);
  return seen.join("\n");
}

function run(program: string, options: string[]): string {
  const result = spawnSync(program, options, { encoding: "utf8" });
  assert.equal(result.status, 0, `${program} ${options.join(" ")} failed: ${result.stderr}`);
  return result.stdout;
}

// ---- The check: the property against the real laws command and its real source. ----

if (import.meta.main) {
  // The real command, run with the world's home folder and with no signer in its environment.
  // --phone: the laptop's fingerprint helper is not asked, even if this machine has one.
  const real: Sign = async (world, server) => {
    const options = ["sign", "--phone", "--repo", world.repo, "--signers", world.signers];
    if (server !== null) options.push("--server", server);
    const environment = { ...process.env, HOME: world.home, LAWS_SIGNER: undefined, LAWS_SIGNERS: undefined };
    return spawnSync(process.execPath, [CLI, ...options], { encoding: "utf8", env: environment }).status;
  };

  test("T-03 blocked: laws sign with no signing server fails and writes nothing", () => blockedNoSigner(real));
  test("T-03 allowed: the server's approver signs, laws checks and stores", () => allowedSignerSigns(real));
  test("T-03 a signature is stored only after it was verified", () => storesOnlyWhatVerifies(real));
  test("T-03 the source of the laws command has no way to sign", () => {
    const sources = readSources();
    assert.ok(sources.has("cli.ts") && sources.has("sign.ts") && sources.has("approvals.ts"), "src/ was not read");
    assert.deepEqual(findWaysToSign(sources), []);
  });
}
