import { LawsError } from "./cards.ts";
import { MAX_REQUEST_CHARS } from "./request.ts";
import type { Line } from "./request.ts";

// The laws command's side of the talk with the signing server (server/server.ts). It posts the request,
// gets the list back as the server computed it, and then asks again and again whether the phone has
// signed. Nothing that the server says is believed here: sign.ts checks what comes back.

export type Posted = { id: string; list: Line[]; expires: string; page: string };
export type PhoneAnswer = { manifest: string; passkey: string };

const ANSWER_SECONDS = 20; // how long one request to the server may take

// The address of the server, ending in "/", so that the page and its api/ lie under it.
export function serverAddress(address: string): string {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    throw new LawsError(`"${address}" is not a web address. Give the address of the signing server, like https://pi.example.ts.net/laws/`);
  }
  if (!["https:", "http:"].includes(url.protocol) || url.search !== "") {
    throw new LawsError(`"${address}" must be an https address without a "?" part.`);
  }
  return `${url.origin}${url.pathname.endsWith("/") ? url.pathname : `${url.pathname}/`}`;
}

export async function postRequest(base: string, request: string): Promise<Posted> {
  if (request.length > MAX_REQUEST_CHARS) throw new LawsError("the cards and their files are too large for one request. Sign fewer cards at once.");
  const answer = await call(base, "api/requests", request);
  if (answer === null) throw new LawsError(`the signing server at ${base} cannot be reached. Nothing was stored.`);
  const { id, list, expires } = answer.body;
  if (!answer.ok || typeof id !== "string" || !/^[0-9a-f]{32}$/.test(id) || typeof expires !== "string" || !Array.isArray(list)) {
    throw new LawsError(`the signing server did not take the request: ${whyNot(answer)}. Nothing was stored.`);
  }
  const lines: Line[] = [];
  for (const entry of list as unknown[]) {
    const { id: card, hash, title } = (typeof entry === "object" && entry !== null ? entry : {}) as Record<string, unknown>;
    if (typeof card !== "string" || typeof title !== "string" || (hash !== null && typeof hash !== "string")) {
      throw new LawsError("the signing server answered with something that is not a list. Nothing was stored.");
    }
    lines.push({ id: card, hash, title });
  }
  return { id, list: lines, expires, page: `${base}?r=${id}` };
}

// Asks until the phone has signed or rejected, or until the request has run out on the server.
// It asks often at first and then every five seconds. A server that is away for a while is asked again.
export async function waitForPhone(base: string, posted: Posted, print: (line: string) => void): Promise<PhoneAnswer> {
  const end = Date.parse(posted.expires);
  let pause = 250;
  let away = false;
  for (;;) {
    await new Promise<void>((wake) => setTimeout(() => wake(), pause));
    pause = Math.min(pause * 2, 5000);
    const answer = await call(base, `api/requests/${posted.id}/result`);
    if (answer === null) {
      if (!away) print("the signing server cannot be reached right now. Trying again.");
      away = true;
    } else if (answer.status === 404) {
      throw new LawsError("the request is gone from the signing server: it ran out, or the server lost it. Nothing was stored.");
    } else if (!answer.ok) {
      throw new LawsError(`the signing server answered: ${whyNot(answer)}. Nothing was stored.`);
    } else {
      away = false;
      const { state, manifest, passkey } = answer.body;
      if (state === "rejected") throw new LawsError("every card was rejected on the phone. Nothing was stored.");
      if (state === "signed" && typeof manifest === "string" && typeof passkey === "string") return { manifest, passkey };
    }
    if (!(Date.now() < end)) throw new LawsError("nobody signed before the request ran out. Nothing was stored.");
  }
}

type Answer = { ok: boolean; status: number; body: Record<string, unknown> };

// One request to the server. Null: the server did not answer. A body is posted as JSON.
async function call(base: string, path: string, body?: string): Promise<Answer | null> {
  try {
    const options = body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body };
    const response = await fetch(`${base}${path}`, { ...options, signal: AbortSignal.timeout(ANSWER_SECONDS * 1000) });
    const value: unknown = await response.json();
    const record = typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
    return { ok: response.ok, status: response.status, body: record };
  } catch {
    return null;
  }
}

// Why the server said no, made safe to print on a terminal.
function whyNot(answer: Answer): string {
  const why = typeof answer.body["error"] === "string" ? answer.body["error"] : `status ${answer.status}`;
  return why.replace(/[^\x20-\x7e]/g, "?").slice(0, 500);
}
