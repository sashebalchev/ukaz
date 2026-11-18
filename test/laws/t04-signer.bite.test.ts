// The bite of law T-04: the same property as the check, run against signers that are broken on purpose.
// Every test in this file must FAIL. If one passes, the check of T-04 has lost its teeth.

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runSigner } from "../../signer/signer.ts";
import {
  blockedFrozenLinkToOutside,
  blockedNoTerminal,
  refusesCardLinkToOutside,
  signsOnlyOnTheExactWord,
} from "./t04-signer.test.ts";
import type { Signer } from "./t04-signer.test.ts";

function runWith(words: string[], answer: (word: string) => string | null): ReturnType<Signer> {
  const printed: string[] = [];
  const exitCode = runSigner(words, answer, (line) => printed.push(line));
  return { exitCode, printed: printed.join("\n") };
}

// Broken on purpose: it does not wait for a person. It gives itself the word it asks for.
const confirmsByItself: Signer = (words) => runWith(words, (word) => word);

// Broken on purpose: it reads whatever a path leads to. It signs a copy of the repository in which
// every symbolic link has been replaced by the file it points at, also a file outside the repository.
const followsEveryLink: Signer = (words, typed) => {
  const copy = mkdtempSync(join(tmpdir(), "laws-t04-bite-"));
  try {
    const repoAt = words.indexOf("--repo") + 1;
    copyFollowingLinks(words[repoAt] ?? "", copy);
    return runWith([...words.slice(0, repoAt), copy, ...words.slice(repoAt + 1)], () => typed);
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
};

// Copies a folder. Where it meets a symbolic link, it copies what the link leads to.
function copyFollowingLinks(from: string, to: string): void {
  mkdirSync(to, { recursive: true });
  for (const name of readdirSync(from)) {
    if (statSync(join(from, name)).isDirectory()) copyFollowingLinks(join(from, name), join(to, name));
    else writeFileSync(join(to, name), readFileSync(join(from, name)));
  }
}

test("bite: a signer that confirms by itself fails the blocked case of no terminal", () => {
  blockedNoTerminal(confirmsByItself);
});
test("bite: a signer that confirms by itself fails when another word is typed", () => {
  signsOnlyOnTheExactWord(confirmsByItself);
});
test("bite: a signer that follows every link fails the blocked case of a frozen link to outside", () => {
  blockedFrozenLinkToOutside(followsEveryLink);
});
test("bite: a signer that follows every link fails on a card file that is a link to outside", () => {
  refusesCardLinkToOutside(followsEveryLink);
});
