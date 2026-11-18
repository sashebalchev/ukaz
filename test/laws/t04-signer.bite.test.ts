// The bite of law T-04: the same property as the check, run against a signer that is broken on purpose.
// Every test in this file must FAIL. If one passes, the check of T-04 has lost its teeth.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  blockedFrozenLinkToOutside,
  refusesCardLinkToOutside,
  refusesFilesOverOneMegabyte,
} from "./t04-signer.test.ts";
import type { Signer } from "./t04-signer.test.ts";

const SOURCES = join(import.meta.dirname, "../../src");

// Broken on purpose: a signer that reads whatever a path leads to. It follows links out of the
// repository and has no size limit. Everything else it does like the real one.
const TRUSTING_SIGNER = `
import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseCard } from ${JSON.stringify(join(SOURCES, "card.ts"))};
import { hashCard } from ${JSON.stringify(join(SOURCES, "hash.ts"))};

const words = process.argv.slice(2);
const option = (name) => words[words.indexOf(name) + 1];
const ids = words.filter((word, at) => !word.startsWith("--") && !String(words[at - 1]).startsWith("--")).sort();
const repo = option("--repo");

const lines = ids.map((id) => {
  const cardBytes = readFileSync(join(repo, "laws", id + ".md"));
  const card = parseCard(cardBytes, id);
  const frozen = card.frozen.map((path) => ({ path, bytes: readFileSync(join(repo, path)) }));
  return { id, title: card.title, hash: hashCard(cardBytes, frozen) };
});
for (const line of lines) console.log(line.id, line.hash, line.title);

const manifest = lines.map((line) => line.id + " " + line.hash + "\\n").join("");
appendFileSync(option("--log"), new Date().toISOString() + " " + manifest.replaceAll("\\n", " ") + "\\n");
const signed = spawnSync("ssh-keygen", ["-Y", "sign", "-f", option("--key"), "-n", "laws"], { input: manifest, encoding: "utf8" });
writeFileSync(join(option("--out"), "manifest"), manifest);
writeFileSync(join(option("--out"), "manifest.sig"), signed.stdout);
`;

const folder = mkdtempSync(join(tmpdir(), "laws-t04-bite-"));
after(() => rmSync(folder, { recursive: true, force: true }));
writeFileSync(join(folder, "trusting-signer.mjs"), TRUSTING_SIGNER);
const trusting: Signer = [process.execPath, join(folder, "trusting-signer.mjs")];

test("bite: a signer that follows links fails the blocked case of a frozen link to outside", () => {
  blockedFrozenLinkToOutside(trusting);
});
test("bite: a signer that follows links fails on a card file that is a link to outside", () => {
  refusesCardLinkToOutside(trusting);
});
test("bite: a signer without a size limit fails on a file over 1 MB", () => {
  refusesFilesOverOneMegabyte(trusting);
});
