#!/usr/bin/env node
// laws-signer: the only program that uses the signing key.
//
//   laws-signer --repo <path> --key <private key file> --log <file> --out <folder> <id>...
//
// In this order it:
//   1. reads the named cards and their frozen files from the repository and computes every hash itself;
//   2. prints the id, hash and title of each card;
//   3. appends one line to the log: time, key fingerprint, and id=hash for each card;
//   4. signs exactly the printed list and writes <out>/manifest and <out>/manifest.sig.
//
// It refuses the whole batch if any file it would read is not a regular file inside the repository
// (after following symbolic links) or is larger than 1 MB. It never writes inside the repository.
// From the laws command it shares card.ts (the card parser) and hash.ts (the hash), and nothing else.

import { spawnSync } from "node:child_process";
import { appendFileSync, lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { ID_PATTERN, parseCard } from "../src/card.ts";
import { hashCard } from "../src/hash.ts";

const MAX_FILE_BYTES = 1024 * 1024;
const NAMESPACE = "laws";
const USAGE = "usage: laws-signer --repo <path> --key <private key file> --log <file> --out <folder> <id>...";

type Arguments = { repo: string; key: string; log: string; out: string; ids: string[] };
type Line = { id: string; hash: string; title: string };

function main(words: string[]): void {
  const { repo, key, log, out, ids } = readArguments(words);

  const repoFolder = realpathSync(repo);
  const outFolder = realpathSync(out);
  const logFile = join(realpathSync(dirname(resolve(log))), basename(log));
  if (isInside(repoFolder, outFolder)) throw new Error(`--out ${out} is inside the repository`);
  if (isInside(repoFolder, logFile)) throw new Error(`--log ${log} is inside the repository`);
  if (isSymbolicLink(logFile)) throw new Error(`--log ${log} is a symbolic link`);

  const lines = ids.map((id) => readCard(repoFolder, id));
  const fingerprint = keyFingerprint(key);

  console.log(`laws-signer: signing ${lines.length} card(s) of ${repoFolder} with key ${fingerprint}`);
  for (const line of lines) console.log(`  ${line.id}  ${line.hash}  ${line.title}`);

  const manifest = lines.map((line) => `${line.id} ${line.hash}\n`).join("");

  // The log line is written before the signature is made, so the log never misses a signature.
  const time = new Date().toISOString();
  appendFileSync(logFile, `${time} ${fingerprint} ${lines.map((line) => `${line.id}=${line.hash}`).join(" ")}\n`);

  // ssh-keygen signs what it reads on standard input and prints the signature.
  const signature = run("ssh-keygen", ["-Y", "sign", "-f", key, "-n", NAMESPACE], manifest);

  // "wx" refuses to write over anything that is already there, including a symbolic link.
  writeFileSync(join(outFolder, "manifest"), manifest, { flag: "wx" });
  writeFileSync(join(outFolder, "manifest.sig"), signature, { flag: "wx" });
  console.log(`laws-signer: signed. Wrote manifest and manifest.sig to ${outFolder}`);
}

function readArguments(words: string[]): Arguments {
  const options = new Map<string, string>();
  const ids: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const word = words[i] ?? "";
    if (["--repo", "--key", "--log", "--out"].includes(word)) {
      const value = words[i + 1];
      if (value === undefined || options.has(word)) throw new Error(`${word} needs one value, once.\n${USAGE}`);
      options.set(word, value);
      i += 1;
    } else if (word.startsWith("-")) {
      throw new Error(`unknown option ${word}.\n${USAGE}`);
    } else {
      ids.push(word);
    }
  }
  const need = (name: string): string => {
    const value = options.get(name);
    if (value === undefined) throw new Error(`${name} is missing.\n${USAGE}`);
    return value;
  };
  if (ids.length === 0) throw new Error(`no card id given.\n${USAGE}`);
  if (new Set(ids).size !== ids.length) throw new Error("a card id is given twice");
  return { repo: need("--repo"), key: need("--key"), log: need("--log"), out: need("--out"), ids: [...ids].sort() };
}

// Each file is read once. The title that is printed and the hash that is signed come from the same bytes.
function readCard(repoFolder: string, id: string): Line {
  if (!ID_PATTERN.test(id)) throw new Error(`"${id}" is not a card id`);
  const cardBytes = readRepoFile(repoFolder, `laws/${id}.md`);
  let card;
  try {
    card = parseCard(cardBytes, id);
  } catch (error) {
    throw new Error(`laws/${id}.md is not a valid card: ${error instanceof Error ? error.message : String(error)}`);
  }
  const frozen = card.frozen.map((path) => ({ path, bytes: readRepoFile(repoFolder, path) }));
  return { id, hash: hashCard(cardBytes, frozen), title: card.title };
}

function readRepoFile(repoFolder: string, path: string): Uint8Array {
  let real: string;
  try {
    real = realpathSync(join(repoFolder, path));
  } catch {
    throw new Error(`${path} does not exist in the repository`);
  }
  if (!isInside(repoFolder, real)) throw new Error(`${path} leads outside the repository, to ${real}`);
  const info = lstatSync(real);
  if (!info.isFile()) throw new Error(`${path} is not a regular file`);
  if (info.size > MAX_FILE_BYTES) throw new Error(`${path} is larger than 1 MB`);
  return readFileSync(real);
}

function isInside(folder: string, path: string): boolean {
  return path === folder || path.startsWith(folder + sep);
}

function isSymbolicLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false; // it does not exist yet
  }
}

function keyFingerprint(key: string): string {
  const fingerprint = run("ssh-keygen", ["-l", "-f", key], "").split(" ")[1];
  if (fingerprint === undefined) throw new Error(`ssh-keygen printed no fingerprint for ${key}`);
  return fingerprint;
}

function run(program: string, options: string[], input: string): string {
  const result = spawnSync(program, options, { input, encoding: "utf8", stdio: ["pipe", "pipe", "inherit"] });
  if (result.error !== undefined) throw new Error(`${program} could not be run: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`"${program} ${options.join(" ")}" failed`);
  return result.stdout;
}

try {
  main(process.argv.slice(2));
} catch (error) {
  console.error(`laws-signer: refused: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
