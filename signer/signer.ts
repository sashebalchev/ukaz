#!/usr/bin/env node
// laws-signer: the only program that uses the signing key.
//
//   laws-signer --repo <path> --key <private key file> --log <file> --out <folder> [<id>...] [--retire <id>]...
//
// A plain <id> asks to approve that card as it is now. --retire <id> asks to retire it.
// In this order the signer:
//   1. reads the named cards from the repository, and for a card to approve the files that are hashed
//      with it, and computes every hash itself;
//   2. prints the list, one line per card: "sign <id> <hash> <title>" or "retire <id> <title>";
//   3. asks at the terminal for the word "sign" ("retire" if the list only retires). With no terminal,
//      or with any other answer, it refuses;
//   4. appends one line to the log: time, key fingerprint, "signed" or why it refused, and the list;
//   5. signs exactly that list, headed by the time, and writes <out>/manifest and <out>/manifest.sig.
//
// It refuses the whole batch if a file it would read is not a regular file inside the repository
// (wherever a symbolic link may lead) or is larger than 1 MB. It never writes inside the repository.
// No option and no environment variable skips the question.
// From the laws command it shares card.ts (the card parser) and hash.ts (the hash), and nothing else.

import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readlinkSync,
  readSync,
  realpathSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { hashedPaths, ID_PATTERN, parseCard } from "../src/card.ts";
import { hashCard } from "../src/hash.ts";

const MAX_FILE_BYTES = 1024 * 1024;
const NAMESPACE = "laws";
const SSH_KEYGEN = "ssh-keygen"; // the Nix package writes the full path of ssh-keygen here
const USAGE =
  "usage: laws-signer --repo <path> --key <private key file> --log <file> --out <folder> [<id>...] [--retire <id>]...";

// Asks the person to type the given word. Returns what was typed, or null if there is nobody to ask.
export type Ask = (word: string) => string | null;

type Arguments = { repo: string; key: string; log: string; out: string; approve: string[]; retire: string[] };
// hash is null for a card that is retired.
type Line = { id: string; hash: string | null; title: string };

// Runs the signer and returns its exit code. Everything it says goes through print.
export function runSigner(words: string[], ask: Ask, print: (line: string) => void): number {
  try {
    signList(words, ask, print);
    return 0;
  } catch (error) {
    print(`laws-signer: refused: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

function signList(words: string[], ask: Ask, print: (line: string) => void): void {
  const { repo, key, log, out, approve, retire } = readArguments(words);

  const repoFolder = realpathSync(repo);
  const outFolder = realpathSync(out);
  const logFile = join(realpathSync(dirname(resolve(log))), basename(log));
  if (isInside(repoFolder, outFolder)) throw new Error(`--out ${out} is inside the repository`);
  if (isInside(repoFolder, logFile)) throw new Error(`--log ${log} is inside the repository`);
  if (isSymbolicLink(logFile)) throw new Error(`--log ${log} is a symbolic link`);

  const lines = [
    ...approve.map((id) => readCard(repoFolder, id, "approve")),
    ...retire.map((id) => readCard(repoFolder, id, "retire")),
  ].sort((a, b) => (a.id < b.id ? -1 : 1));
  const fingerprint = keyFingerprint(key);

  print(`laws-signer: ${lines.length} card(s) of ${repoFolder}, key ${fingerprint}`);
  for (const line of lines) {
    if (line.hash === null) print(`  retire  ${line.id}  ${line.title}`);
    else print(`  sign    ${line.id}  ${line.hash}  ${line.title}`);
  }
  const list = lines.map((line) => `${line.id}=${line.hash ?? "retired"}`).join(" ");

  const word = lines.every((line) => line.hash === null) ? "retire" : "sign";
  const typed = ask(word);
  if (typed !== word) {
    const why = typed === null ? "no-terminal" : "not-confirmed";
    appendFileSync(logFile, `${new Date().toISOString()} ${fingerprint} refused:${why} ${list}\n`);
    if (typed === null) throw new Error(`there is no terminal to type "${word}" at. Run this yourself, in a terminal.`);
    throw new Error(`"${word}" was not typed. Nothing was signed.`);
  }

  const time = new Date().toISOString();
  const manifest = `signed: ${time}\n${lines.map((line) => `${line.id} ${line.hash ?? "retired"}\n`).join("")}`;

  // The log line is written before the signature is made, so the log never misses a signature.
  appendFileSync(logFile, `${time} ${fingerprint} signed ${list}\n`);

  // ssh-keygen signs what it reads on standard input and prints the signature.
  const signature = run(SSH_KEYGEN, ["-Y", "sign", "-f", key, "-n", NAMESPACE], manifest);

  // "wx" refuses to write over anything that is already there, including a symbolic link.
  writeFileSync(join(outFolder, "manifest"), manifest, { flag: "wx" });
  writeFileSync(join(outFolder, "manifest.sig"), signature, { flag: "wx" });
  print(`laws-signer: signed. Wrote manifest and manifest.sig to ${outFolder}`);
}

// The real question. It is asked at the controlling terminal and nowhere else: standard input could be
// a pipe that another program fills.
export function askAtTerminal(word: string): string | null {
  let terminal: number;
  try {
    terminal = openSync("/dev/tty", "r+");
  } catch {
    return null;
  }
  try {
    writeSync(terminal, `Type ${word} and press Enter to sign this list. Anything else refuses: `);
    let typed = "";
    const byte = new Uint8Array(1);
    while (typed.length < 100 && readSync(terminal, byte) === 1 && byte[0] !== 10) {
      typed += String.fromCharCode(byte[0] ?? 0);
    }
    return typed;
  } finally {
    closeSync(terminal);
  }
}

function readArguments(words: string[]): Arguments {
  const options = new Map<string, string>();
  const approve: string[] = [];
  const retire: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const word = words[i] ?? "";
    const value = words[i + 1];
    if (word === "--retire") {
      if (value === undefined) throw new Error(`--retire needs a card id.\n${USAGE}`);
      retire.push(value);
      i += 1;
    } else if (["--repo", "--key", "--log", "--out"].includes(word)) {
      if (value === undefined || options.has(word)) throw new Error(`${word} needs one value, once.\n${USAGE}`);
      options.set(word, value);
      i += 1;
    } else if (word.startsWith("-")) {
      throw new Error(`unknown option ${word}.\n${USAGE}`);
    } else {
      approve.push(word);
    }
  }
  const need = (name: string): string => {
    const value = options.get(name);
    if (value === undefined) throw new Error(`${name} is missing.\n${USAGE}`);
    return value;
  };
  const ids = [...approve, ...retire];
  if (ids.length === 0) throw new Error(`no card id given.\n${USAGE}`);
  if (new Set(ids).size !== ids.length) throw new Error("a card id is given twice");
  return { repo: need("--repo"), key: need("--key"), log: need("--log"), out: need("--out"), approve, retire };
}

// The title that is printed and the hash that is signed come from the same bytes, read once.
// A card to retire must still be there, so that its title can be shown.
function readCard(repoFolder: string, id: string, purpose: "approve" | "retire"): Line {
  if (!ID_PATTERN.test(id)) throw new Error(`"${id}" is not a card id`);
  const cardBytes = readRepoFile(repoFolder, `laws/${id}.md`);
  let card;
  try {
    card = parseCard(cardBytes, id);
  } catch (error) {
    throw new Error(`laws/${id}.md is not a valid card: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (purpose === "retire") return { id, hash: null, title: card.title };

  const paths = hashedPaths(card);
  const present = paths.ifPresent.filter((path) => existsSync(join(repoFolder, path)));
  const files = [...paths.required, ...present].map((path) => ({ path, bytes: readRepoFile(repoFolder, path) }));
  return { id, hash: hashCard(cardBytes, files), title: card.title };
}

function readRepoFile(repoFolder: string, path: string): Uint8Array {
  let real: string;
  try {
    real = realpathSync(join(repoFolder, path));
  } catch {
    throw new Error(`${path} does not exist in the repository`);
  }
  if (!isInside(repoFolder, real)) throw new Error(`${path} leads outside the repository, to ${real}`);
  if (!lstatSync(real).isFile()) throw new Error(`${path} is not a regular file`);

  // The checks above keep the signer from opening what it should not. The checks that count are the
  // ones below: they look at the open file itself, which cannot be swapped for another any more.
  const file = openSync(real, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = fstatSync(file);
    const opened = readlinkSync(`/proc/self/fd/${file}`);
    if (!info.isFile()) throw new Error(`${path} is not a regular file`);
    if (!isInside(repoFolder, opened)) throw new Error(`${path} leads outside the repository, to ${opened}`);
    if (info.size > MAX_FILE_BYTES) throw new Error(`${path} is larger than 1 MB`);
    const bytes = readFileSync(file);
    if (bytes.length > MAX_FILE_BYTES) throw new Error(`${path} is larger than 1 MB`);
    return bytes;
  } finally {
    closeSync(file);
  }
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
  const fingerprint = run(SSH_KEYGEN, ["-l", "-f", key], "").split(" ")[1];
  if (fingerprint === undefined) throw new Error(`ssh-keygen printed no fingerprint for ${key}`);
  return fingerprint;
}

function run(program: string, options: string[], input: string): string {
  const result = spawnSync(program, options, { input, encoding: "utf8", stdio: ["pipe", "pipe", "inherit"] });
  if (result.error !== undefined) throw new Error(`${program} could not be run: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`"${program} ${options.join(" ")}" failed`);
  return result.stdout;
}

if (import.meta.main) {
  process.exitCode = runSigner(process.argv.slice(2), askAtTerminal, (line) => console.log(line));
}
