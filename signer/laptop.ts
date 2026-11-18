#!/usr/bin/env node
// laws-signerd: the laptop signer. A service that holds the laptop key and signs a list only after
// one named finger touched the fingerprint reader.
//
//   laws-signerd --socket <path> --key <private key file> --log <file> --user <name> --finger <finger>
//
// It is meant to run as root under systemd, so that no program of the user can read the key.
// For each request, in this order, it:
//   1. reads the request from the socket: the bytes of each card and of each file that is hashed with
//      it. It opens no path that the client names;
//   2. computes every hash itself and answers with the list: id, hash and title of each card;
//   3. only then asks the fingerprint reader for the named finger of the named user, for 30 seconds;
//   4. on a match appends one line to the log, then signs exactly that list, headed by the time, and
//      answers with the manifest and the signature.
// Another finger, no touch in time, a reader that fails: nothing is signed, and the log says why.
// One request at a time: while one is being served, every other is refused at once.
// Nothing is kept from one request to the next. One match signs one list.
// From the laws command it shares request.ts (the request format), card.ts and hash.ts, and nothing else.

import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, lstatSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import type { Socket } from "node:net";
import { manifestOf, MAX_REQUEST_CHARS, readRequest, RequestError } from "../src/request.ts";
import type { Line } from "../src/request.ts";

const NAMESPACE = "laws";
const SSH_KEYGEN = "ssh-keygen"; // the Nix package writes the full path of ssh-keygen here
const FPRINTD_VERIFY = "fprintd-verify"; // and the full path of fprintd-verify here
const USAGE = "usage: laws-signerd --socket <path> --key <private key file> --log <file> --user <name> --finger <finger>";

export const FINGER_SECONDS = 30; // how long the reader waits for the finger
const REQUEST_SECONDS = 10; // how long a client may take to send its request

// The names that fprintd gives to fingers. "any" is not one of them here: the signer asks for one finger.
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

export type Settings = { socket: string; key: string; log: string; user: string; finger: string };

// Asks the fingerprint reader for this finger of this user and waits at most so many milliseconds.
// match is true only if the reader saw exactly that finger. detail is a few words for the log.
export type FingerResult = { match: boolean; detail: string };
export type FingerCheck = (finger: string, user: string, milliseconds: number) => Promise<FingerResult>;

export type Service = { stop: () => Promise<void> };

export function readSettings(words: string[]): Settings {
  const options = new Map<string, string>();
  for (let i = 0; i < words.length; i += 2) {
    const word = words[i] ?? "";
    const value = words[i + 1];
    if (!["--socket", "--key", "--log", "--user", "--finger"].includes(word)) throw new Error(`unknown option ${word}.\n${USAGE}`);
    if (value === undefined || options.has(word)) throw new Error(`${word} needs one value, once.\n${USAGE}`);
    options.set(word, value);
  }
  const need = (name: string): string => {
    const value = options.get(name);
    if (value === undefined) throw new Error(`${name} is missing.\n${USAGE}`);
    return value;
  };
  const settings = { socket: need("--socket"), key: need("--key"), log: need("--log"), user: need("--user"), finger: need("--finger") };
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

// Starts the service. The finger check is given from outside, so that tests can stand in for the reader.
// Everything the service says goes through print.
export async function startLaptopSigner(
  settings: Settings,
  checkFinger: FingerCheck,
  print: (line: string) => void,
  fingerMilliseconds: number = FINGER_SECONDS * 1000,
): Promise<Service> {
  const { key, finger, user } = settings;
  checkSettings(settings);
  if (!existsSync(key)) {
    // A new key without a passphrase. ssh-keygen writes it for the owner only, and <key>.pub next to it.
    run(SSH_KEYGEN, ["-q", "-t", "ed25519", "-N", "", "-C", "laws laptop signer", "-f", key], "");
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
      setTimeout(() => socket.destroy(), 2000).unref(); // for a client that does not hang up itself
    };
    const refuse = async (code: string, list: string, why: string): Promise<void> => {
      try {
        log(`refused:${code}`, list, why);
      } finally {
        await answer({ refused: why });
        hangUp();
      }
    };

    if (busy) return refuse("busy", "-", "another request is being served. Try again when it is done.");
    let lines: Line[];
    try {
      const cards = readRequest(await readLine(socket, MAX_REQUEST_CHARS, REQUEST_SECONDS * 1000));
      lines = cards.map(({ id, hash, title }) => ({ id, hash, title }));
    } catch (error) {
      if (!(error instanceof RequestError)) throw error;
      return refuse("bad-request", "-", error.message);
    }
    const list = lines.map((line) => `${line.id}=${line.hash ?? "retired"}`).join(" ");
    if (busy) return refuse("busy", list, "another request is being served. Try again when it is done.");

    busy = true;
    try {
      // First the list goes out. Only when it has left this process is the reader asked.
      await answer({ list: lines, finger, seconds: fingerMilliseconds / 1000 });
      const result = await within(fingerMilliseconds, checkFinger(finger, user, fingerMilliseconds));
      if (result === null) return await refuse("no-touch", list, `no touch of the ${finger} within ${fingerMilliseconds / 1000} seconds`);
      if (!result.match) return await refuse("no-match", list, `the reader did not see the ${finger}: ${result.detail}`);
      if (socket.destroyed) return await refuse("client-gone", list, "the program that asked has gone");

      const time = new Date().toISOString();
      const manifest = manifestOf(time, lines);
      // The log line is written before the signature is made, so the log never misses a signature.
      appendFileSync(settings.log, `${time} ${fingerprint} signed ${list}\n`, { mode: 0o600 });
      // ssh-keygen signs what it reads on standard input and prints the signature.
      const signature = run(SSH_KEYGEN, ["-Y", "sign", "-f", key, "-n", NAMESPACE], manifest);
      await answer({ manifest, signature });
      hangUp();
    } catch (error) {
      await refuse("failed", list, error instanceof Error ? error.message : String(error));
    } finally {
      busy = false; // and nothing else is kept: the next request starts from nothing
    }
  };

  if (existsSync(settings.socket)) {
    if (!lstatSync(settings.socket).isSocket()) throw new Error(`--socket ${settings.socket} exists and is not a socket`);
    rmSync(settings.socket); // left behind by an earlier run
  }
  const server = createServer((socket) => {
    open.add(socket);
    socket.on("close", () => open.delete(socket));
    socket.on("error", () => {}); // a client that hangs up; "close" follows
    serve(socket).catch((error: unknown) => {
      print(`laws-signerd: ${error instanceof Error ? error.message : String(error)}`);
      socket.destroy();
    });
  });
  server.maxConnections = 8;
  await new Promise<void>((done, failed) => {
    server.on("error", failed);
    server.listen(settings.socket, done);
  });
  // The owner and the group of the socket may ask. Asking alone signs nothing.
  chmodSync(settings.socket, 0o660);
  print(`laws-signerd: listening on ${settings.socket}. It asks for the ${finger} of ${user}.`);

  return {
    stop: () =>
      new Promise((done) => {
        for (const socket of open) socket.destroy();
        server.close(() => done());
      }),
  };
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

// The first line that the client sends. Refuses a line that is too long or does not come in time.
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
    const timer = setTimeout(() => settle(() => failed(new RequestError("the request did not arrive in time"))), milliseconds);
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      if (settled) return;
      text += chunk;
      const end = text.indexOf("\n");
      if (end !== -1) settle(() => done(text.slice(0, end)));
      else if (text.length > maxChars) settle(() => failed(new RequestError("the request is too large")));
    });
    socket.on("close", () => settle(() => failed(new RequestError("the request ended before its end of line"))));
  });
}

// For the log: one line of plain letters, not too long.
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
