// Helpers for the ordinary tests. The law tests in test/laws/ do not use this file: each of them is
// frozen with its card and carries everything it needs.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const CLI = join(import.meta.dirname, "../src/cli.ts");
export const SIGNER = join(import.meta.dirname, "../signer/signer.ts");

// A temporary folder with an empty repository, a throwaway key, the signers file that names it,
// and a signer command that runs the real signer program with that key.
export type World = { folder: string; repo: string; signers: string; key: string; signerCommand: string; log: string };

export type Printed = { exitCode: number | null; printed: string };

export function withWorld(body: (world: World) => void | Promise<void>): () => Promise<void> {
  return async () => {
    const folder = mkdtempSync(join(tmpdir(), "laws-test-"));
    try {
      const key = join(folder, "key");
      const log = join(folder, "signer.log");
      const world = {
        folder,
        repo: join(folder, "repo"),
        signers: join(folder, "allowed_signers"),
        key,
        signerCommand: `'${process.execPath}' '${SIGNER}' --key '${key}' --log '${log}'`,
        log,
      };
      mkdirSync(join(world.repo, "laws"), { recursive: true });
      const made = spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key], { encoding: "utf8" });
      assert.equal(made.status, 0, `ssh-keygen failed: ${made.stderr}`);
      writeFileSync(world.signers, `owner ${readFileSync(`${key}.pub`, "utf8")}`);
      await body(world);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  };
}

export function writeCard(world: World, id: string, frontMatter: string[], body = `# ${id} A law\n`): void {
  writeFileSync(join(world.repo, "laws", `${id}.md`), `---\nid: ${id}\n${frontMatter.join("\n")}\n---\n${body}`);
}

// Runs the laws command with exactly these words. LAWS_SIGNERS and LAWS_SIGNER are unset unless given.
export function lawsRaw(words: string[], environment: Record<string, string> = {}): Printed {
  const env = { ...process.env, LAWS_SIGNERS: undefined, LAWS_SIGNER: undefined, ...environment };
  const result = spawnSync(process.execPath, [CLI, ...words], { encoding: "utf8", env });
  return { exitCode: result.status, printed: result.stdout + result.stderr };
}

// Runs the laws command on the world's repository with the world's signers file.
export function laws(world: World, words: string[]): Printed {
  return lawsRaw([...words, "--repo", world.repo, "--signers", world.signers]);
}

// Approves cards through the real signer. With no ids: every card that is waiting or changed.
export function signCards(world: World, ids: string[] = []): Printed {
  return laws(world, ["sign", ...ids, "--signer", world.signerCommand]);
}
