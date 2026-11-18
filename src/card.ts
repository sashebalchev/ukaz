// A law card is laws/<ID>.md: a front matter block between "---" lines, then a Markdown body.
// Card format version 0. The parser is strict on purpose: what it does not know is an error.
// Values are taken literally. There are no quotes, no comments and no multi-line values.

export const GRADES = ["every-case", "bounded", "generated", "chosen", "prose"] as const;
export type Grade = (typeof GRADES)[number];

export type Card = {
  id: string;
  grade: Grade;
  check: string | null;
  bite: string | null;
  frozen: string[];
  scope: string[];
  timeout: number;
  figure: string | null;
  title: string;
};

export const DEFAULT_TIMEOUT_SECONDS = 60;
export const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]*$/;

const KNOWN_KEYS = ["id", "grade", "check", "bite", "frozen", "scope", "timeout", "figure"];

export class CardError extends Error {}

export function parseCard(bytes: Uint8Array, expectedId: string): Card {
  const text = decodeUtf8(bytes);
  if (text.includes("\r")) throw new CardError("the card has carriage returns; use Unix line endings");
  const lines = text.split("\n");
  if (lines[0] !== "---") throw new CardError('the first line must be "---"');
  const end = lines.indexOf("---", 1);
  if (end === -1) throw new CardError('the front matter has no closing "---" line');

  const values = readFrontMatter(lines.slice(1, end));

  const id = values.get("id");
  if (id === undefined) throw new CardError('the card has no "id"');
  if (!ID_PATTERN.test(id)) throw new CardError(`id "${id}" may only use letters, digits and "-"`);
  if (id !== expectedId) throw new CardError(`id "${id}" does not match the file name, which says "${expectedId}"`);

  const grade = GRADES.find((known) => known === values.get("grade"));
  if (grade === undefined) throw new CardError(`"grade" must be one of: ${GRADES.join(", ")}`);

  const figure = values.get("figure") ?? null;
  if (figure !== null) checkPath("figure", figure);

  return {
    id,
    grade,
    check: values.get("check") ?? null,
    bite: values.get("bite") ?? null,
    frozen: parseList("frozen", values.get("frozen")),
    scope: parseList("scope", values.get("scope")),
    timeout: parseTimeout(values.get("timeout")),
    figure,
    title: findTitle(lines.slice(end + 1), id),
  };
}

function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new CardError("the card is not valid UTF-8");
  }
}

function readFrontMatter(lines: string[]): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of lines) {
    const colon = line.indexOf(":");
    if (colon === -1) throw new CardError(`front matter line is not "key: value": "${line}"`);
    const key = line.slice(0, colon);
    const value = line.slice(colon + 1).trim();
    if (!KNOWN_KEYS.includes(key)) {
      throw new CardError(`unknown key "${key}"; the known keys are: ${KNOWN_KEYS.join(", ")}`);
    }
    if (values.has(key)) throw new CardError(`key "${key}" appears twice`);
    if (value === "") throw new CardError(`key "${key}" has no value; give it one or remove the line`);
    values.set(key, value);
  }
  return values;
}

function parseList(key: string, value: string | undefined): string[] {
  if (value === undefined) return [];
  if (!value.startsWith("[") || !value.endsWith("]")) {
    throw new CardError(`"${key}" must be a list on one line, like [a.ts, b.ts]`);
  }
  const inside = value.slice(1, -1).trim();
  if (inside === "") return [];
  const paths = inside.split(",").map((path) => path.trim());
  for (const path of paths) checkPath(key, path);
  if (new Set(paths).size !== paths.length) throw new CardError(`"${key}" lists the same file twice`);
  return paths;
}

// A path in a card is relative to the repository root and has exactly one spelling.
function checkPath(key: string, path: string): void {
  if (path === "") throw new CardError(`"${key}" has an empty path`);
  if (path.startsWith("/")) throw new CardError(`"${key}": ${path} is absolute; give it relative to the repository root`);
  if (path.includes("..")) throw new CardError(`"${key}": ${path} contains ".."`);
  if (path.includes("\\") || path.includes("[") || path.includes("]")) {
    throw new CardError(`"${key}": ${path} contains "\\", "[" or "]"`);
  }
  if (path.split("/").some((part) => part === "" || part === ".")) {
    throw new CardError(`"${key}": ${path} has an empty or "." part`);
  }
}

function parseTimeout(value: string | undefined): number {
  if (value === undefined) return DEFAULT_TIMEOUT_SECONDS;
  if (!/^[1-9][0-9]{0,4}$/.test(value)) {
    throw new CardError('"timeout" must be a whole number of seconds from 1 to 99999');
  }
  return Number(value);
}

// The title is the first heading of the body, without the id if the heading starts with it.
function findTitle(body: string[], id: string): string {
  const heading = body.find((line) => /^#{1,6} /.test(line));
  if (heading === undefined) throw new CardError("the body has no heading; its first heading is the title");
  let title = heading.replace(/^#+ +/, "").trim();
  if (title === id || title.startsWith(`${id} `)) title = title.slice(id.length).trim();
  if (title === "") throw new CardError("the title is empty");
  return title;
}
