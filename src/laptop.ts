import { createConnection } from "node:net";
import { LawsError } from "./cards.ts";
import type { Line } from "./request.ts";

// The laws command's side of the talk with the laptop signer (signer/laptop.ts). It sends the request
// as one line. The service answers with one line that holds the list, asks the fingerprint reader, and
// then answers with a second line: the manifest and its signature, or why it refused.

export type LaptopList = { list: Line[]; finger: string; seconds: number };
export type LaptopAnswer = { manifest: string; signature: string };

const MAX_ANSWER_CHARS = 4 * 1024 * 1024;
const PATIENCE_SECONDS = 15; // for the list, and on top of the reader's own time for the result

// seen() is called with the list as soon as the service sent it, before anybody touches the reader.
// If it throws, the talk ends there.
export function askLaptop(socketPath: string, request: string, seen: (list: LaptopList) => void): Promise<LaptopAnswer> {
  return new Promise((done, failed) => {
    const socket = createConnection(socketPath);
    let text = "";
    let listed = false;
    let over = false;
    let timer = setTimeout(() => {}, 0);
    const end = (act: () => void): void => {
      if (over) return;
      over = true;
      clearTimeout(timer);
      socket.destroy();
      act();
    };
    const fail = (why: string): void => end(() => failed(new LawsError(`${why} Nothing was stored.`)));
    const waitAtMost = (seconds: number): void => {
      clearTimeout(timer);
      timer = setTimeout(() => fail(`the laptop signer at ${socketPath} did not answer in time.`), seconds * 1000);
    };

    const take = (line: string): void => {
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return fail("the laptop signer sent something that cannot be read.");
      }
      if (typeof message["refused"] === "string") return fail(`the laptop signer refused: ${plain(message["refused"])}.`);
      if (!listed) {
        const list = readList(message);
        if (list === null) return fail("the laptop signer sent something that is not a list.");
        listed = true;
        try {
          seen(list);
        } catch (error) {
          return end(() => failed(error));
        }
        waitAtMost(list.seconds + PATIENCE_SECONDS);
        return;
      }
      const { manifest, signature } = message;
      if (typeof manifest !== "string" || typeof signature !== "string") return fail("the laptop signer sent no signature.");
      end(() => done({ manifest, signature }));
    };

    waitAtMost(PATIENCE_SECONDS);
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${request}\n`));
    socket.on("data", (chunk) => {
      text += chunk;
      if (text.length > MAX_ANSWER_CHARS) return fail("the laptop signer sent too much.");
      for (let at = text.indexOf("\n"); at !== -1 && !over; at = text.indexOf("\n")) {
        const line = text.slice(0, at);
        text = text.slice(at + 1);
        take(line);
      }
    });
    socket.on("error", (error) => fail(`the laptop signer at ${socketPath} cannot be reached (${error.message}).`));
    socket.on("close", () => fail("the laptop signer hung up without a signature."));
  });
}

function readList(message: Record<string, unknown>): LaptopList | null {
  const { list, finger, seconds } = message;
  if (!Array.isArray(list) || typeof finger !== "string" || !/^[a-z-]{1,40}$/.test(finger)) return null;
  if (typeof seconds !== "number" || !(seconds > 0 && seconds <= 600)) return null;
  const lines: Line[] = [];
  for (const entry of list as unknown[]) {
    if (typeof entry !== "object" || entry === null) return null;
    const { id, hash, title } = entry as Record<string, unknown>;
    if (typeof id !== "string" || typeof title !== "string" || (hash !== null && typeof hash !== "string")) return null;
    lines.push({ id, hash, title });
  }
  return { list: lines, finger, seconds };
}

// What another program said, made safe to print on a terminal.
function plain(text: string): string {
  return text.replace(/[^\x20-\x7e]/g, "?").slice(0, 500).replace(/\.$/, "");
}
