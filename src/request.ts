import { CardError, hashedPaths, ID_PATTERN, parseCard } from "./card.ts";
import { hashCard } from "./hash.ts";
import type { FrozenFile } from "./hash.ts";

// A signing request: what the laws command sends to the laptop signer and to the signing server.
// It carries the bytes of each card and of each file that is hashed with the card, in base64:
//
//   { "cards": [ { "id": "T-01", "retire": false, "card": "<base64>",
//                  "files": [ { "path": "test/laws/t01-hash.test.ts", "bytes": "<base64>" } ] } ] }
//
// "retire": true asks to retire the card. Its card file is still sent, so that the title can be shown,
// but no other file. The receiver opens no path. It computes every hash from these bytes, and it
// refuses the whole request if anything is missing, unknown, too large or written sloppily.

export const MAX_FILE_BYTES = 1024 * 1024; // one file, as in the terminal signer
export const MAX_TOTAL_BYTES = 8 * 1024 * 1024; // all files of one request together
export const MAX_CARDS = 100;
// The request as text: base64 makes the bytes a third longer, and the names need some room.
export const MAX_REQUEST_CHARS = 12 * 1024 * 1024;

export type RequestCard = { id: string; retire: boolean; card: Uint8Array; files: FrozenFile[] };

// One line of the list that is shown and signed. hash is null for a card that is retired.
export type Line = { id: string; hash: string | null; title: string };

// A card of a request after the receiver has read it and computed its hash.
export type ReadCard = Line & { cardBytes: Uint8Array; files: FrozenFile[] };

export class RequestError extends Error {}

export function requestText(cards: RequestCard[]): string {
  const base64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");
  return JSON.stringify({
    cards: cards.map(({ id, retire, card, files }) => ({
      id,
      retire,
      card: base64(card),
      files: files.map((file) => ({ path: file.path, bytes: base64(file.bytes) })),
    })),
  });
}

// Reads a request and computes the hash of every card in it. The result is sorted by id.
export function readRequest(text: string): ReadCard[] {
  if (text.length > MAX_REQUEST_CHARS) throw new RequestError("the request is too large");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new RequestError("the request is not JSON");
  }
  const cards = exactly(value, ["cards"], "the request")["cards"];
  if (!Array.isArray(cards) || cards.length === 0) throw new RequestError("the request names no card");
  if (cards.length > MAX_CARDS) throw new RequestError(`the request has more than ${MAX_CARDS} cards`);

  const budget = { left: MAX_TOTAL_BYTES };
  const read = cards.map((card) => readCard(card, budget));
  read.sort((a, b) => (a.id < b.id ? -1 : 1));
  const twice = read.find((card, index) => card.id === read[index + 1]?.id);
  if (twice !== undefined) throw new RequestError(`the card ${twice.id} is in the request twice`);
  return read;
}

// The manifest for these lines, signed at the given time: the same text that approvals.ts reads.
export function manifestOf(time: string, lines: Line[]): string {
  const sorted = [...lines].sort((a, b) => (a.id < b.id ? -1 : 1));
  return `signed: ${time}\n${sorted.map((line) => `${line.id} ${line.hash ?? "retired"}\n`).join("")}`;
}

function readCard(value: unknown, budget: { left: number }): ReadCard {
  const fields = exactly(value, ["id", "retire", "card", "files"], "a card of the request");
  const { id, retire } = fields;
  if (typeof id !== "string" || !ID_PATTERN.test(id)) throw new RequestError(`${JSON.stringify(id)} is not a card id`);
  if (typeof retire !== "boolean") throw new RequestError(`${id}: "retire" must be true or false`);
  if (!Array.isArray(fields["files"])) throw new RequestError(`${id}: "files" must be a list`);

  const cardBytes = decode(fields["card"], `the card ${id}`, budget);
  const files = fields["files"].map((file): FrozenFile => {
    const { path, bytes } = exactly(file, ["path", "bytes"], `a file of ${id}`);
    if (typeof path !== "string") throw new RequestError(`${id}: a file has no path`);
    return { path, bytes: decode(bytes, `${id}: ${path}`, budget) };
  });

  let card;
  try {
    card = parseCard(cardBytes, id);
  } catch (error) {
    if (!(error instanceof CardError)) throw error;
    throw new RequestError(`${id} is not a valid card: ${error.message}`);
  }
  if (retire) {
    if (files.length > 0) throw new RequestError(`${id}: a card to retire comes without other files`);
    return { id, hash: null, title: card.title, cardBytes, files };
  }

  // Exactly the files that the card names: every one that must be there, and no other.
  const wanted = hashedPaths(card);
  const sent = files.map((file) => file.path);
  if (new Set(sent).size !== sent.length) throw new RequestError(`${id}: a file was sent twice`);
  for (const path of wanted.required) {
    if (!sent.includes(path)) throw new RequestError(`${id}: ${path} was not sent; the card lists it as frozen or as its figure`);
  }
  for (const path of sent) {
    if (!wanted.required.includes(path) && !wanted.ifPresent.includes(path)) {
      throw new RequestError(`${id}: ${path} was sent, and the card does not name it`);
    }
  }
  return { id, hash: hashCard(cardBytes, files), title: card.title, cardBytes, files };
}

// The value must be an object with exactly these keys.
function exactly(value: unknown, keys: string[], what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new RequestError(`${what} is not an object`);
  const record = value as Record<string, unknown>;
  const found = Object.keys(record);
  const unknown = found.find((key) => !keys.includes(key));
  if (unknown !== undefined) throw new RequestError(`${what} has an unknown field "${unknown}"`);
  const missing = keys.find((key) => !found.includes(key));
  if (missing !== undefined) throw new RequestError(`${what} has no field "${missing}"`);
  return record;
}

// Plain base64 with padding, in its one spelling. Counts the bytes against the limits.
function decode(value: unknown, what: string, budget: { left: number }): Uint8Array {
  if (typeof value !== "string") throw new RequestError(`${what}: the bytes are missing`);
  if (value.length > Math.ceil(MAX_FILE_BYTES / 3) * 4) throw new RequestError(`${what} is larger than 1 MB`);
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) throw new RequestError(`${what}: the bytes are not plain base64`);
  if (bytes.length > MAX_FILE_BYTES) throw new RequestError(`${what} is larger than 1 MB`);
  budget.left -= bytes.length;
  if (budget.left < 0) throw new RequestError("the files of the request are larger than 8 MB together");
  return bytes;
}
