#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { biteCommand } from "./bite.ts";
import { CardError, ID_PATTERN, parseCard } from "./card.ts";
import { LawsError, loadCards } from "./cards.ts";
import { checkCommand } from "./check.ts";
import { gate } from "./gate.ts";
import { signCommand } from "./sign.ts";
import { readLawbook, resolveSigners, verifyRepo } from "./verify.ts";

const USAGE = `usage: laws [--repo <path>] [--signers <file>] [--signer "<command>"] <command>

  status         one line per card: id, grade, state, title
  show <id>      print a card, and its figure if a rendered .txt exists
  check          run every card's check; ends with ALL LAWS HOLD or SOME LAWS FAIL
  bite           run every card's bite; each one must fail
  gate           print "open" if every card is approved as it is now, else "closed" and why
  verify         the same test as gate, worded for CI
  sign [<id>...] ask the signer to approve the given cards, or all that are waiting or changed

  --repo     the repository to work on (default: the current folder)
  --signers  the allowed-signers file, outside the repository
             (default: $LAWS_SIGNERS, then /etc/laws/allowed_signers)
  --signer   the signer command for "sign" (default: $LAWS_SIGNER)`;

type Arguments = { repo: string; signers: string | null; signer: string | null; command: string; rest: string[] };

function readArguments(words: string[]): Arguments {
  const options = new Map<string, string>();
  const plain: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const word = words[i] ?? "";
    if (["--repo", "--signers", "--signer"].includes(word)) {
      const value = words[i + 1];
      if (value === undefined || options.has(word)) throw new LawsError(`${word} needs one value, once.\n\n${USAGE}`);
      options.set(word, value);
      i += 1;
    } else if (word.startsWith("-")) {
      throw new LawsError(`unknown option ${word}.\n\n${USAGE}`);
    } else {
      plain.push(word);
    }
  }
  const [command, ...rest] = plain;
  if (command === undefined) throw new LawsError(USAGE);
  return {
    repo: resolve(options.get("--repo") ?? "."),
    signers: options.get("--signers") ?? null,
    signer: options.get("--signer") ?? null,
    command,
    rest,
  };
}

async function main(words: string[]): Promise<number> {
  const { repo, signers, signer, command, rest } = readArguments(words);
  const print = (line: string): void => console.log(line);
  if (command !== "show" && command !== "sign" && rest.length > 0) {
    throw new LawsError(`"laws ${command}" takes no further words, got: ${rest.join(" ")}`);
  }
  switch (command) {
    case "status":
      return status(repo, signers, print);
    case "show":
      return show(repo, rest, print);
    case "check":
      return checkCommand(repo, print);
    case "bite":
      return biteCommand(repo, print);
    case "gate": {
      const result = gate(repo, signers);
      print(result.open ? "open" : "closed");
      for (const reason of result.reasons) print(`  ${reason}`);
      return result.open ? 0 : 1;
    }
    case "verify": {
      const verdict = verifyRepo(repo, signers);
      print(verdict.ok ? "verified: every card is approved as it is now" : "not verified");
      for (const reason of verdict.reasons) print(`  ${reason}`);
      return verdict.ok ? 0 : 1;
    }
    case "sign":
      return signCommand({ repo, ids: rest, signerCommand: signer, signersFlag: signers }, print);
    default:
      throw new LawsError(`unknown command "${command}".\n\n${USAGE}`);
  }
}

function status(repo: string, signersFlag: string | null, print: (line: string) => void): number {
  const cards = loadCards(repo);
  const states = new Map<string, string>();
  const notes: string[] = [];
  try {
    const book = readLawbook(repo, resolveSigners(repo, signersFlag));
    for (const card of book.states) states.set(card.id, card.state);
    notes.push(...book.notes);
  } catch (error) {
    if (!(error instanceof LawsError)) throw error;
    notes.push(`unverified: ${error.message}`);
  }
  for (const card of cards) {
    const grade = card.ok ? card.card.grade : "?";
    const state = card.ok ? (states.get(card.id) ?? "unverified") : "broken";
    const title = card.ok ? card.card.title : card.problem;
    print(`${card.id}  ${grade.padEnd(10)}  ${state.padEnd(10)}  ${title}`);
  }
  if (cards.length === 0) print("no law cards in laws/");
  for (const note of notes) print(note);
  return 0;
}

function show(repo: string, rest: string[], print: (line: string) => void): number {
  const [id, ...more] = rest;
  if (id === undefined || more.length > 0 || !ID_PATTERN.test(id)) throw new LawsError("usage: laws show <id>");
  const file = join(repo, "laws", `${id}.md`);
  if (!existsSync(file)) throw new LawsError(`there is no card ${id}: ${file} does not exist.`);
  const bytes = readFileSync(file);
  print(bytes.toString("utf8").trimEnd());

  let figure: string | null;
  try {
    figure = parseCard(bytes, id).figure;
  } catch (error) {
    if (!(error instanceof CardError)) throw error;
    print("");
    print(`This card is broken: ${error.message}`);
    return 1;
  }
  // The figure spec figures/NAME.spec.json is rendered to figures/NAME.txt.
  if (figure !== null && figure.endsWith(".spec.json")) {
    const rendered = join(repo, `${figure.slice(0, -".spec.json".length)}.txt`);
    if (existsSync(rendered)) {
      print("");
      print(readFileSync(rendered, "utf8").trimEnd());
    }
  }
  return 0;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  if (!(error instanceof LawsError)) throw error;
  console.error(`laws: ${error.message}`);
  process.exitCode = 1;
}
