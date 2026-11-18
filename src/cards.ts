import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CardError, hashedPaths, parseCard } from "./card.ts";
import type { Card } from "./card.ts";
import { hashCard } from "./hash.ts";
import type { FrozenFile } from "./hash.ts";

// An error the person at the terminal can act on. The command line prints its message and exits 1.
export class LawsError extends Error {}

// A card file as found in the repository: either readable, with its hash, or broken, with the reason.
export type GoodCard = { id: string; ok: true; card: Card; hash: string };
export type BrokenCard = { id: string; ok: false; problem: string };
export type Loaded = GoodCard | BrokenCard;

// Every laws/*.md file is a card. Sorted by id.
export function loadCards(repo: string): Loaded[] {
  const folder = join(repo, "laws");
  if (!existsSync(folder)) {
    throw new LawsError(`no laws/ folder in ${repo}. Run from a repository root, or pass --repo <path>.`);
  }
  const ids = readdirSync(folder)
    .filter((name) => name.endsWith(".md"))
    .map((name) => name.slice(0, -".md".length))
    .sort();
  return ids.map((id) => loadCard(repo, id));
}

function loadCard(repo: string, id: string): Loaded {
  try {
    const { card, cardBytes, files } = readCardFiles(repo, id);
    return { id, ok: true, card, hash: hashCard(cardBytes, files) };
  } catch (error) {
    if (error instanceof CardError) return { id, ok: false, problem: error.message };
    return { id, ok: false, problem: `laws/${id}.md cannot be read: ${String(error)}` };
  }
}

// The bytes of a card file and of every file that is hashed with it.
export function readCardFiles(repo: string, id: string): { card: Card; cardBytes: Uint8Array; files: FrozenFile[] } {
  const cardBytes = readFileSync(join(repo, "laws", `${id}.md`));
  const card = parseCard(cardBytes, id);
  const paths = hashedPaths(card);
  const present = paths.ifPresent.filter((path) => existsSync(join(repo, path)));
  const files = [...paths.required, ...present].map((path) => readHashed(repo, path));
  return { card, cardBytes, files };
}

// A missing frozen file or figure is an error. It must never hash like an empty file.
function readHashed(repo: string, path: string): FrozenFile {
  try {
    return { path, bytes: readFileSync(join(repo, path)) };
  } catch {
    throw new CardError(`${path} is missing or cannot be read; the card lists it as frozen or as its figure`);
  }
}
