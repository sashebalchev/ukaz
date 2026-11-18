#!/usr/bin/env node
// laws-signerd: the laptop's fingerprint helper. It adds your finger to the signing server: it approves
// a request that waits there, after one named finger touched the fingerprint reader.
//
//   laws-signerd --socket <path> --server <https address> --key <private key file> --log <file>
//                --user <name> --finger <finger>
//
// It is meant to run as root under systemd, so that no program of the user can read the key.
// A call on the socket says one thing: "approve request <id>". For each call, in this order, it:
//   1. fetches the cards of that request from the signing server, at the address in its own settings.
//      The caller cannot name another server, and cannot hand it cards;
//   2. computes every hash itself from those bytes and answers the caller with the list: id, hash and
//      title of each card;
//   3. only then asks the fingerprint reader for the named finger of the named user, for 30 seconds;
//   4. on a match appends one line to the log, signs exactly that list, headed by the time, with the
//      laptop key, and hands the manifest and the signature to the server;
//   5. tells the caller "approved", or why not. The caller gets the signature from the server.
// Another finger, no touch in time, a reader that fails: nothing is signed, and the log says why.
// One call at a time: while one is being served, every other is refused at once.
// Nothing is kept from one call to the next. One match signs one list.
// What the server answers is read as strictly as what a stranger sends, and within size limits.
// From the laws command it shares request.ts (the request format), http.ts, card.ts and hash.ts.

import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, lstatSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import type { Socket } from "node:net";
import { exchange, jsonObject } from "../src/http.ts";
import type { Reply } from "../src/http.ts";
import { manifestOf, MAX_REQUEST_CHARS, readRequest, RequestError } from "../src/request.ts";
import type { Line } from "../src/request.ts";

const NAMESPACE = "laws";
const SSH_KEYGEN = "ssh-keygen"; // the Nix package writes the full path of ssh-keygen here
const FPRINTD_VERIFY = "fprintd-verify"; // and the full path of fprintd-verify here
const USAGE =
  "usage: laws-signerd --socket <path> --server <https address> --key <private key file> --log <file> --user <name> --finger <finger>";

export const FINGER_SECONDS = 30; // how long the reader waits for the finger
const CALL_SECONDS = 5; // how long a caller may take to say what it wants
const SERVER_SECONDS = 20; // how long the server may take for one answer
const REQUEST_ID = /^[0-9a-f]{32}$/;

// The names that fprintd gives to fingers. "any" is not one of them here: the helper asks for one finger.
export const FINGERS = [
  "left-thumb",
  "left-index-finger",
  "left-middle-finger",
  "left-ring-finger",
  "left-little-finger",
  "right-thumb",
  "right-index-finger",
  "right-middle-finger",
  "right-ring-finger",
  "right-little-finger",
];

export type Settings = { socket: string; server: string; key: string; log: string; user: string; finger: string };

// For tests only, and not reachable from the command line. fingerMilliseconds: a shorter wait for the
// finger. loopbackHttp: take a server at http://127.0.0.1, because the tests run one there without https.
export type TestSwitches = { fingerMilliseconds?: number; loopbackHttp?: boolean };

// Asks the fingerprint reader for this finger of this user and waits at most so many milliseconds.
// match is true only if the reader saw exactly that finger. detail is a few words for the log.
export type FingerResult = { match: boolean; detail: string };
export type FingerCheck = (finger: string, user: string, milliseconds: number) => Promise<FingerResult>;

export type Service = { stop: () => Promise<void> };

// Why a call was refused: a short word for the log, and a sentence for the caller.
class Refused extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export function readSettings(words: string[]): Settings {
  const options = new Map<string, string>();
  for (let i = 0; i < words.length; i += 2) {
    const word = words[i] ?? "";
    const value = words[i + 1];
    if (!["--socket", "--server", "--key", "--log", "--user", "--finger"].includes(word)) throw new Error(`unknown option ${word}.\n${USAGE}`);
    if (value === undefined || options.has(word)) throw new Error(`${word} needs one value, once.\n${USAGE}`);
    options.set(word, value);
  }
  const need = (name: string): string => {
    const value = options.get(name);
    if (value === undefined) throw new Error(`${name} is missing.\n${USAGE}`);
    return value;
  };
  const settings = { socket: need("--socket"), server: need("--server"), key: need("--key"), log: need("--log"), user: need("--user"), finger: need("--finger") };
  serverBase(settings, false);
  checkSettings(settings);
  return settings;
}

// The finger must be one finger by name. "any" would let every enrolled finger sign.
function checkSettings(settings: Settings): void {
  if (!FINGERS.includes(settings.finger)) {
    throw new Error(`--finger ${settings.finger} is not one finger. Name one of: ${FINGERS.join(", ")}. "any" is refused on purpose.`);
  }
  if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(settings.user)) throw new Error(`--user ${settings.user} is not a user name`);
}

// The address of the signing server, ending in "/". It must be https.
function serverBase(settings: Settings, loopbackHttp: boolean): string {
  let url: URL;
  try {
    url = new URL(settings.server);
  } catch {
    throw new Error(`--server ${settings.server} is not a web address`);
  }
  const forTests = loopbackHttp && url.protocol === "http:" && url.hostname === "127.0.0.1";
  if ((url.protocol !== "https:" && !forTests) || url.search !== "") throw new Error(`--server ${settings.server} must be an https address`);
  return `${url.origin}${url.pathname.endsWith("/") ? url.pathname : `${url.pathname}/`}`;
}

// Starts the service. The finger check is given from outside, so that tests can stand in for the reader.
// Everything the service says goes through print.
export async function startLaptopSigner(
  settings: Settings,
  checkFinger: FingerCheck,
  print: (line: string) => void,
  switches: TestSwitches = {},
): Promise<Service> {
  const { key, finger, user } = settings;
  const fingerMilliseconds = switches.fingerMilliseconds ?? FINGER_SECONDS * 1000;
  const loopbackHttp = switches.loopbackHttp ?? false;
  const server = serverBase(settings, loopbackHttp);
  checkSettings(settings);
  if (!existsSync(key)) {
    // A new key without a passphrase. ssh-keygen writes it for the owner only, and <key>.pub next to it.
    run(SSH_KEYGEN, ["-q", "-t", "ed25519", "-N", "", "-C", "laws laptop helper", "-f", key], "");
    chmodSync(key, 0o600);
    print(`laws-signerd: made a new key, ${key}`);
  }
  const fingerprint = keyFingerprint(key);
  const publicKey = run(SSH_KEYGEN, ["-y", "-f", key], "").trim().split(" ").slice(0, 2).join(" ");
  print(`laws-signerd: key ${fingerprint}. Its line for the signers file:`);
  print(`${user} namespaces="${NAMESPACE}" ${publicKey}`);

  const log = (what: string, list: string, detail = ""): void => {
    const note = detail === "" ? "" : ` (${plain(detail)})`;
    appendFileSync(settings.log, `${new Date().toISOString()} ${fingerprint} ${what} ${list}${note}\n`, { mode: 0o600 });
  };

  // Fetches the request from the server and computes the list from its bytes. The server's answer is
  // read as strictly as a request from anybody: exact fields, clean base64, sizes within the limits.
  const fetchList = async (id: string): Promise<Line[]> => {
    let reply: Reply;
    try {
      reply = await exchange(`${server}api/requests/${id}/request`, { maxBytes: MAX_REQUEST_CHARS, seconds: SERVER_SECONDS, loopbackHttp });
    } catch (error) {
      throw new Refused("no-server", `the signing server gave no answer: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (reply.status !== 200) {
      const why = jsonObject(reply.text)?.["error"];
      throw new Refused("not-waiting", `this request does not wait on the signing server: ${typeof why === "string" ? why : `status ${reply.status}`}`);
    }
    try {
      return readRequest(reply.text).map(({ id: card, hash, title }) => ({ id: card, hash, title }));
    } catch (error) {
      if (!(error instanceof RequestError)) throw error;
      throw new Refused("bad-answer", `the signing server answered with something that is not a request: ${error.message}`);
    }
  };

  // Hands the signed manifest to the server. Throws with the reason if the server does not take it.
  const deliver = async (id: string, manifest: string, signature: string): Promise<void> => {
    const limits = { maxBytes: 64 * 1024, seconds: SERVER_SECONDS, loopbackHttp };
    const reply = await exchange(`${server}api/requests/${id}/signature`, limits, JSON.stringify({ manifest, signature }));
    const answer = jsonObject(reply.text);
    if (reply.status === 200 && answer?.["stored"] === true) return;
    throw new Error(typeof answer?.["error"] === "string" ? answer["error"] : `status ${reply.status}`);
  };

  let busy = false;
  const open = new Set<Socket>();

  const serve = async (socket: Socket): Promise<void> => {
    const answer = (message: object): Promise<void> =>
      new Promise((done) => {
        if (socket.destroyed) done();
        else socket.write(`${JSON.stringify(message)}\n`, () => done());
      });
    const hangUp = (): void => {
      socket.end();
      setTimeout(() => socket.destroy(), 2000).unref(); // for a caller that does not hang up itself
    };
    const refuse = async (code: string, list: string, why: string): Promise<void> => {
      try {
        log(`refused:${code}`, list, why);
      } finally {
        await answer({ refused: plain(why) });
        hangUp();
      }
    };
    const busyNow = "another call is being served. Try again when it is done";

    if (busy) return refuse("busy", "-", busyNow);
    let id: string;
    try {
      id = readCall(await readLine(socket, 4096, CALL_SECONDS * 1000));
    } catch (error) {
      if (!(error instanceof Refused)) throw error;
      return refuse(error.code, "-", error.message);
    }
    if (busy) return refuse("busy", `request=${id}`, busyNow);

    busy = true;
    let list = `request=${id}`;
    try {
      const lines = await fetchList(id);
      list = `request=${id} ${lines.map((line) => `${line.id}=${line.hash ?? "retired"}`).join(" ")}`;

      // First the list goes out. Only when it has left this process is the reader asked.
      await answer({ list: lines, finger, seconds: fingerMilliseconds / 1000 });
      const result = await within(fingerMilliseconds, checkFinger(finger, user, fingerMilliseconds));
      if (result === null) throw new Refused("no-touch", `no touch of the ${finger} within ${fingerMilliseconds / 1000} seconds`);
      if (!result.match) throw new Refused("no-match", `the reader did not see the ${finger}: ${result.detail}`);
      if (socket.destroyed) throw new Refused("caller-gone", "the program that asked has gone");

      const time = new Date().toISOString();
      const manifest = manifestOf(time, lines);
      // The log line is written before the signature is made, so the log never misses a signature.
      appendFileSync(settings.log, `${time} ${fingerprint} signed ${list}\n`, { mode: 0o600 });
      // ssh-keygen signs what it reads on standard input and prints the signature.
      const signature = run(SSH_KEYGEN, ["-Y", "sign", "-f", key, "-n", NAMESPACE], manifest);
      try {
        await deliver(id, manifest, signature);
      } catch (error) {
        throw new Refused("not-delivered", `the signing server did not take the signature: ${error instanceof Error ? error.message : String(error)}`);
      }
      await answer({ approved: true });
      hangUp();
    } catch (error) {
      if (error instanceof Refused) await refuse(error.code, list, error.message);
      else await refuse("failed", list, error instanceof Error ? error.message : String(error));
    } finally {
      busy = false; // and nothing else is kept: the next call starts from nothing
    }
  };

  if (existsSync(settings.socket)) {
    if (!lstatSync(settings.socket).isSocket()) throw new Error(`--socket ${settings.socket} exists and is not a socket`);
    rmSync(settings.socket); // left behind by an earlier run
  }
  const listener = createServer((socket) => {
    open.add(socket);
    socket.on("close", () => open.delete(socket));
    socket.on("error", () => {}); // a caller that hangs up; "close" follows
    serve(socket).catch((error: unknown) => {
      print(`laws-signerd: ${error instanceof Error ? error.message : String(error)}`);
      socket.destroy();
    });
  });
  listener.maxConnections = 8;
  await new Promise<void>((done, failed) => {
    listener.on("error", failed);
    listener.listen(settings.socket, done);
  });
  // The owner and the group of the socket may call. A call alone signs nothing.
  chmodSync(settings.socket, 0o660);
  print(`laws-signerd: listening on ${settings.socket} for requests that wait at ${server}. It asks for the ${finger} of ${user}.`);

  return {
    stop: () =>
      new Promise((done) => {
        for (const socket of open) socket.destroy();
        listener.close(() => done());
      }),
  };
}

// A call is one line: {"approve":"<request id>"}. Nothing else is taken: no cards, no address.
function readCall(line: string): string {
  const call = jsonObject(line);
  const id = call?.["approve"];
  if (call === null || Object.keys(call).length !== 1 || typeof id !== "string" || !REQUEST_ID.test(id)) {
    throw new Refused("bad-call", 'a call must be {"approve":"<request id>"} and nothing else. This helper signs only what waits on the signing server');
  }
  return id;
}

// The real finger check: fprintd-verify -f <finger> <user>. It counts as a match only if the program
// exits with 0 and prints "verify-match". If it also names the finger it looked for, that must be
// the named one. At the time limit the program is killed with everything it started.
export function fprintdFinger(program: string = FPRINTD_VERIFY): FingerCheck {
  return (finger, user, milliseconds) =>
    new Promise((done) => {
      const child = spawn(program, ["-f", finger, user], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
      const killGroup = (): void => {
        try {
          if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
        } catch {
          // Already gone.
        }
      };
      let printed = "";
      let late = false;
      let exitCode: number | null = null;
      const timer = setTimeout(() => {
        late = true;
        killGroup();
      }, milliseconds);
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk) => {
        if (printed.length < 65536) printed += chunk;
      });
      const judge = (): void => {
        const asked = /^Verifying: (.*)$/m.exec(printed)?.[1];
        const result = [...printed.matchAll(/^Verify result: (\S+)/gm)].at(-1)?.[1] ?? "no result";
        if (late) done({ match: false, detail: "no touch in time" });
        else if (asked !== undefined && asked !== finger) done({ match: false, detail: `the reader looked for "${asked}"` });
        else if (exitCode === 0 && printed.includes("verify-match")) done({ match: true, detail: "verify-match" });
        else done({ match: false, detail: `exit ${exitCode ?? "by a signal"}, ${result}` });
      };
      child.on("error", (error) => {
        clearTimeout(timer);
        done({ match: false, detail: `${program} could not be run: ${error.message}` });
      });
      // "exit": the program ended. "close": all it printed was read. Something that the program left
      // behind could hold its output open, so everything in its group is killed, and after one more
      // second the answer is given from what was read.
      child.on("exit", (code) => {
        exitCode = code;
        clearTimeout(timer);
        killGroup();
        setTimeout(judge, 1000).unref();
      });
      child.on("close", judge);
    });
}

// The promise's value, or null if it does not come within the time. A value that comes later is dropped.
function within<Value>(milliseconds: number, promise: Promise<Value>): Promise<Value | null> {
  return new Promise((done, failed) => {
    const timer = setTimeout(() => done(null), milliseconds);
    timer.unref(); // the listening socket keeps the service running, not this timer
    promise.then(
      (value) => {
        clearTimeout(timer);
        done(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        failed(error);
      },
    );
  });
}

// The one line that a caller sends. Refuses a line that is too long or does not come in time.
function readLine(socket: Socket, maxChars: number, milliseconds: number): Promise<string> {
  return new Promise((done, failed) => {
    let text = "";
    let settled = false;
    const settle = (act: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      act();
    };
    const tooLong = "the call is too long. A call names a request on the signing server. This helper takes no cards";
    const timer = setTimeout(() => settle(() => failed(new Refused("bad-call", "the call did not arrive in time"))), milliseconds);
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      if (settled) return;
      text += chunk;
      const end = text.indexOf("\n");
      if (end !== -1 && end <= maxChars) settle(() => done(text.slice(0, end)));
      else if (end !== -1 || text.length > maxChars) settle(() => failed(new Refused("bad-call", tooLong)));
    });
    socket.on("close", () => settle(() => failed(new Refused("bad-call", "the call ended before its end of line"))));
  });
}

// One line of plain letters, not too long: for the log, and for what the caller prints.
function plain(text: string): string {
  return text.replace(/[^\x20-\x7e]/g, "?").slice(0, 300);
}

function keyFingerprint(key: string): string {
  const fingerprint = run(SSH_KEYGEN, ["-l", "-f", key], "").split(" ")[1];
  if (fingerprint === undefined) throw new Error(`ssh-keygen printed no fingerprint for ${key}`);
  return fingerprint;
}

function run(program: string, options: string[], input: string): string {
  const result = spawnSync(program, options, { input, encoding: "utf8" });
  if (result.error !== undefined) throw new Error(`${program} could not be run: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`"${program} ${options.join(" ")}" failed: ${result.stderr.trim()}`);
  return result.stdout;
}

if (import.meta.main) {
  try {
    process.umask(0o077); // what this service writes is for its own user only
    const settings = readSettings(process.argv.slice(2));
    const service = await startLaptopSigner(settings, fprintdFinger(), (line) => console.log(line));
    const stop = (): void => {
      service.stop().then(
        () => process.exit(0),
        () => process.exit(1),
      );
    };
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);
  } catch (error) {
    console.error(`laws-signerd: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
