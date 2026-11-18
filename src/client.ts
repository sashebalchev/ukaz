import { LawsError } from "./cards.ts";
import { exchange, jsonObject } from "./http.ts";
import { MAX_REQUEST_CHARS } from "./request.ts";
import type { Line } from "./request.ts";

// The laws command's side of the talk with the signing server (server/server.ts). It posts the request,
// gets the list back as the server computed it, and then asks again and again whether the request was
// approved. Nothing that the server says is believed here: sign.ts checks what comes back.

export type Posted = { id: string; list: Line[]; expires: string; page: string };
// What the server hands out for an approved request: the manifest, and the phone's passkey answer or
// the laptop's SSH signature.
export type Approval = { manifest: string; passkey: string | null; signature: string | null };

const LIMITS = { maxBytes: 4 * 1024 * 1024, seconds: 20, loopbackHttp: true };

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
  if (typeof answer === "string") throw new LawsError(`the signing server at ${base} cannot be reached (${answer}). Nothing was stored.`);
  const { id, list, expires } = answer.body;
  if (answer.status !== 200 || typeof id !== "string" || !/^[0-9a-f]{32}$/.test(id) || typeof expires !== "string" || !Array.isArray(list)) {
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

// Asks until the request was approved or rejected, or until it has run out on the server.
// It asks often at first and then every five seconds. A server that is away for a while is asked again.
export async function waitForApproval(base: string, posted: Posted, print: (line: string) => void): Promise<Approval> {
  const end = Date.parse(posted.expires);
  let pause = 250;
  let away = false;
  for (;;) {
    const answer = await call(base, `api/requests/${posted.id}/result`);
    if (typeof answer === "string") {
      if (!away) print(`the signing server cannot be reached right now (${answer}). Trying again.`);
      away = true;
    } else if (answer.status === 404) {
      throw new LawsError("the request is gone from the signing server: it ran out, or the server lost it. Nothing was stored.");
    } else if (answer.status !== 200) {
      throw new LawsError(`the signing server answered: ${whyNot(answer)}. Nothing was stored.`);
    } else {
      away = false;
      const { state, manifest, passkey, signature } = answer.body;
      if (state === "rejected") throw new LawsError("every card was rejected on the phone. Nothing was stored.");
      if (state === "signed" && typeof manifest === "string") {
        if (typeof passkey === "string") return { manifest, passkey, signature: null };
        if (typeof signature === "string") return { manifest, passkey: null, signature };
      }
    }
    if (!(Date.now() < end)) throw new LawsError("nobody signed before the request ran out. Nothing was stored.");
    await new Promise<void>((wake) => setTimeout(() => wake(), pause));
    pause = Math.min(pause * 2, 5000);
  }
}

type Answer = { status: number; body: Record<string, unknown> };

// One request to the server. A text instead of an answer says why there is none.
async function call(base: string, path: string, body?: string): Promise<Answer | string> {
  try {
    const reply = await exchange(`${base}${path}`, LIMITS, body);
    const json = jsonObject(reply.text);
    return json === null ? `status ${reply.status}, and no JSON` : { status: reply.status, body: json };
  } catch (error) {
    return plain(error instanceof Error ? error.message : String(error));
  }
}

// Why the server said no.
function whyNot(answer: Answer): string {
  return plain(typeof answer.body["error"] === "string" ? answer.body["error"] : `status ${answer.status}`);
}

// What another machine said, made safe to print on a terminal.
function plain(text: string): string {
  return text.replace(/[^\x20-\x7e]/g, "?").slice(0, 500);
}
