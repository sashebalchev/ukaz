import { createConnection } from "node:net";
import type { Line } from "./request.ts";

// The laws command's side of the talk with the laptop's fingerprint helper (signer/laptop.ts).
// The call is one line: approve this request, which waits on the signing server. The helper fetches the
// cards from the server itself and answers with one line that holds the list. Then it asks the
// fingerprint reader, and answers with a second line: approved, or why not.
// No card and no signature passes through here. The signature goes from the helper to the server.

export type HelperList = { list: Line[]; finger: string; seconds: number };
export type HelperAnswer = { approved: true } | { approved: false; why: string };

const MAX_ANSWER_CHARS = 4 * 1024 * 1024;
const PATIENCE_SECONDS = 30; // for the list, and on top of the reader's own time for the result

// seen() is called with the list as soon as the helper sent it, before anybody touches the reader.
// If it throws, the talk ends there, and the helper signs nothing for a caller that has gone.
export function askHelper(socketPath: string, requestId: string, seen: (list: HelperList) => void): Promise<HelperAnswer> {
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
    const no = (why: string): void => end(() => done({ approved: false, why }));
    const waitAtMost = (seconds: number): void => {
      clearTimeout(timer);
      timer = setTimeout(() => no("it did not answer in time"), seconds * 1000);
    };

    const take = (line: string): void => {
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return no("it sent something that cannot be read");
      }
      if (typeof message["refused"] === "string") return no(plain(message["refused"]));
      if (!listed) {
        const list = readList(message);
        if (list === null) return no("it sent something that is not a list");
        listed = true;
        try {
          seen(list);
        } catch (error) {
          return end(() => failed(error));
        }
        return waitAtMost(list.seconds + PATIENCE_SECONDS);
      }
      if (message["approved"] === true) return end(() => done({ approved: true }));
      no("it sent no clear answer");
    };

    waitAtMost(PATIENCE_SECONDS);
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${JSON.stringify({ approve: requestId })}\n`));
    socket.on("data", (chunk) => {
      text += chunk;
      if (text.length > MAX_ANSWER_CHARS) return no("it sent too much");
      for (let at = text.indexOf("\n"); at !== -1 && !over; at = text.indexOf("\n")) {
        const line = text.slice(0, at);
        text = text.slice(at + 1);
        take(line);
      }
    });
    socket.on("error", (error) => no(`it cannot be reached at ${socketPath} (${plain(error.message)})`));
    socket.on("close", () => no("it hung up without an answer"));
  });
}

function readList(message: Record<string, unknown>): HelperList | null {
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
