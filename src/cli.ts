#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { biteCommand } from "./bite.ts";
import { CardError, ID_PATTERN, parseCard, renderedFigure } from "./card.ts";
import { LawsError, loadCards } from "./cards.ts";
import { checkCommand } from "./check.ts";
import { gate } from "./gate.ts";
import { retireCommand, signCommand } from "./sign.ts";
import { readLawbook, resolveSigners, verifyRepo } from "./verify.ts";

const USAGE = `usage: laws [--repo <path>] [--signers <file>] [--signer "<command>"] <command>

  status           one line per card: id, grade, state, title
  show <id>        print a card, and its figure if a rendered .txt exists
  check            run every card's check; ends with ALL LAWS HOLD or SOME LAWS FAIL
  bite             run every card's bite; each one must fail and print the card's bite-says text
  gate             print "open" if every card is approved as it is now and none is missing,
                   else "closed" and why
  verify           the same test as gate, worded for CI
  sign [<id>...]   ask the signer to approve the given cards, or all that are waiting or changed
  retire <id>...   ask the signer to retire the given cards, so that their files can be removed

  --repo     the repository to work on (default: the current folder)
  --signers  the allowed-signers file, outside the repository
             (default: $LAWS_SIGNERS, then /etc/laws/allowed_signers)
  --signer   the signer command for "sign" and "retire" (default: $LAWS_SIGNER)`;

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
  if (!["show", "sign", "retire"].includes(command) && rest.length > 0) {
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
    case "retire":
      return retireCommand({ repo, ids: rest, signerCommand: signer, signersFlag: signers }, print);
    default:
      throw new LawsError(`unknown command "${command}".\n\n${USAGE}`);
  }
}

function status(repo: string, signersFlag: string | null, print: (line: string) => void): number {
  const cards = loadCards(repo);
  const line = (id: string, grade: string, state: string, title: string): void => {
    print(`${id}  ${grade.padEnd(10)}  ${state.padEnd(10)}  ${title}`.trimEnd());
  };
  let book;
  try {
    book = readLawbook(repo, resolveSigners(repo, signersFlag));
  } catch (error) {
    if (!(error instanceof LawsError)) throw error;
    for (const card of cards) {
      if (card.ok) line(card.id, card.card.grade, "unverified", card.card.title);
      else line(card.id, "?", "broken", card.problem);
    }
    print(`unverified: ${error.message}`);
    return 0;
  }
  // Besides the card files, this lists the ids that signed manifests name and that have no file.
  for (const { id, state } of book.states) {
    const card = book.cards.find((candidate) => candidate.id === id);
    if (card === undefined) line(id, "-", state, `(no file laws/${id}.md)`);
    else if (card.ok) line(id, card.card.grade, state, card.card.title);
    else line(id, "?", state, card.problem);
  }
  if (cards.length === 0) print("no law cards in laws/");
  for (const note of book.notes) print(note);
  return 0;
}

function show(repo: string, rest: string[], print: (line: string) => void): number {
  const [id, ...more] = rest;
  if (id === undefined || more.length > 0 || !ID_PATTERN.test(id)) throw new LawsError("usage: laws show <id>");
  const file = join(repo, "laws", `${id}.md`);
  if (!existsSync(file)) throw new LawsError(`there is no card ${id}: ${file} does not exist.`);
  const bytes = readFileSync(file);
  print(bytes.toString("utf8").trimEnd());

  let rendered: string | null;
  try {
    rendered = renderedFigure(parseCard(bytes, id));
  } catch (error) {
    if (!(error instanceof CardError)) throw error;
    print("");
    print(`This card is broken: ${error.message}`);
    return 1;
  }
  if (rendered !== null && existsSync(join(repo, rendered))) {
    print("");
    print(readFileSync(join(repo, rendered), "utf8").trimEnd());
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
