import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

// One request to the signing server, and its answer as text. Used by the laws command and by the
// laptop's fingerprint helper. Whoever answers is not trusted, so there are limits: the answer may not
// be larger than maxBytes and must be complete within the given seconds. A redirect is not followed:
// it comes back as the status that it is.
//
// The address must be https. Plain http is taken only for this machine itself (127.0.0.1 or
// localhost), and only where the caller allows it: the tests run a server there.

export type Reply = { status: number; text: string };
export type Limits = { maxBytes: number; seconds: number; loopbackHttp: boolean };

// With a body the request is a POST of JSON, without one a GET. Throws an Error that says in plain
// words why there is no answer.
export function exchange(address: string, limits: Limits, body?: string): Promise<Reply> {
  return new Promise((done, failed) => {
    const url = new URL(address);
    const loopback = ["127.0.0.1", "localhost"].includes(url.hostname);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback && limits.loopbackHttp)) {
      return failed(new Error(`${url.origin} is not an https address`));
    }
    const headers: Record<string, string> = { Accept: "application/json" };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = String(Buffer.byteLength(body));
    }
    const send = url.protocol === "https:" ? httpsRequest : httpRequest;
    const request = send(url, { method: body === undefined ? "GET" : "POST", headers }, (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk) => {
        size += chunk.length;
        if (size > limits.maxBytes) request.destroy(new Error(`the answer is larger than ${limits.maxBytes} bytes`));
        else chunks.push(chunk);
      });
      response.on("end", () => {
        clearTimeout(timer);
        done({ status: response.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") });
      });
      response.on("error", () => {}); // the request reports it
    });
    const timer = setTimeout(() => request.destroy(new Error(`no answer within ${limits.seconds} seconds`)), limits.seconds * 1000);
    request.on("error", (error) => {
      clearTimeout(timer);
      failed(new Error(error.message === "" ? "the connection failed" : error.message));
    });
    request.end(body);
  });
}

// The answer as a JSON object. Null if it is not one.
export function jsonObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
