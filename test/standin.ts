// A stand-in for the signing side, for the tests that need a laws sign to succeed.
// It runs a real signing server (server/server.ts) and an approver that does what the laptop's
// fingerprint helper does after the finger matched: it fetches each waiting request from the server,
// computes every hash from the bytes it got, signs that list with a throwaway key, and hands the
// signature to the server. It has no fingerprint reader and no phone: it approves everything that
// waits, in the form that the server and "laws verify" accept. The tests that use it freeze this file
// with their card, because what it approves is part of what those tests mean.
//
// In a test: const approver = await startStandIn(folder, key, log); approver.url; await approver.stop();
//   key   a throwaway SSH key that the test made, and named in its own signers file
//   log   one line is appended for each approval: "<time> signed A-01=<hash> A-02=retired"
// With lie set it is not a server that tells the truth: see Lie.

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { startServer } from "../server/server.ts";
import { manifestOf, readRequest } from "../src/request.ts";
import type { Line } from "../src/request.ts";

export type StandIn = { url: string; stop: () => Promise<void> };
// A server that lies, to see what the laws command does with a list that is not the one it asked for:
// "hash" signs a card with a hash that nobody computed from the card, "card" adds a card that was never asked.
export type Lie = "hash" | "card";

const SELF = join(import.meta.dirname, "standin.ts");
const ORIGIN = "https://laws.example.test";
const RP_ID = "laws.example.test";

// Starts the stand-in as a program of its own, so that a test can run the laws command and wait for it.
export async function startStandIn(folder: string, key: string, log: string, lie: Lie | null = null): Promise<StandIn> {
  const words = [SELF, "--state", `${folder}/server`, "--key", key, "--log", log, ...(lie === null ? [] : ["--lie", lie])];
  const child = spawn(process.execPath, words, { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  const gone = new Promise<void>((done) => child.on("exit", () => done()));
  const port = await new Promise<number>((found, failed) => {
    const timer = setTimeout(() => failed(new Error(`the stand-in did not start: ${output}`)), 15000);
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => (output += chunk));
    child.stdout?.on("data", (chunk: string) => {
      output += chunk;
      const match = /^port (\d+)$/m.exec(output);
      if (match !== null) {
        clearTimeout(timer);
        found(Number(match[1]));
      }
    });
    child.on("exit", () => {
      clearTimeout(timer);
      failed(new Error(`the stand-in ended at once: ${output}`));
    });
  });
  return {
    url: `http://127.0.0.1:${port}/`,
    stop: async () => {
      child.kill("SIGTERM");
      await gone;
    },
  };
}

function signed(key: string, manifest: string): string {
  const made = spawnSync("ssh-keygen", ["-Y", "sign", "-f", key, "-n", "laws"], { input: manifest, encoding: "utf8" });
  if (made.status !== 0) throw new Error(`ssh-keygen failed: ${made.stderr}`);
  return made.stdout;
}

const listOf = (lines: Line[]): string => lines.map((line) => `${line.id}=${line.hash ?? "retired"}`).join(" ");

// The approver: every request that waits on the server is approved once, with exactly the list that
// was computed from the bytes the server holds.
async function approveWhatWaits(base: string, key: string, log: string): Promise<never> {
  const seen = new Set<string>();
  for (;;) {
    try {
      const waiting = ((await (await fetch(`${base}api/requests`)).json()) as { requests?: { id: string }[] }).requests ?? [];
      for (const { id } of waiting) {
        if (seen.has(id)) continue;
        seen.add(id);
        const request = (await (await fetch(`${base}api/requests/${id}/request`)).json()) as { cards: unknown[] };
        const lines = readRequest(JSON.stringify(request)).map(({ id: card, hash, title }) => ({ id: card, hash, title }));
        const time = new Date().toISOString();
        const manifest = manifestOf(time, lines);
        const body = JSON.stringify({ manifest, signature: signed(key, manifest) });
        const reply = await fetch(`${base}api/requests/${id}/signature`, { method: "POST", headers: { "Content-Type": "application/json" }, body });
        if (reply.status === 200) appendFileSync(log, `${time} signed ${listOf(lines)}\n`);
      }
    } catch {
      // The server may not be ready yet, or a request ran out. Look again.
    }
    await new Promise<void>((wake) => setTimeout(() => wake(), 40));
  }
}

// A server that signs a list that is not the one it was asked about. It answers the way the real one does.
async function lyingServer(key: string, lie: Lie): Promise<number> {
  const id = "0123456789abcdef0123456789abcdef";
  let lines: Line[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const send = (body: object): void => {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify(body));
      };
      if (request.method === "POST") {
        lines = readRequest(Buffer.concat(chunks).toString("utf8")).map(({ id: card, hash, title }) => ({ id: card, hash, title }));
        return send({ id, list: lines, expires: new Date(Date.now() + 3600_000).toISOString() });
      }
      const wrong = lines.map((line, at) => (at === 0 && lie === "hash" ? { ...line, hash: createHash("sha256").update("not this card").digest("hex") } : line));
      if (lie === "card") wrong.push({ id: "Z-99", hash: createHash("sha256").update("never asked").digest("hex"), title: "Never asked" });
      const manifest = manifestOf(new Date().toISOString(), wrong);
      send({ state: "signed", by: "laptop", manifest, signature: signed(key, manifest) });
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  return typeof address === "object" && address !== null ? address.port : 0;
}

if (import.meta.main) {
  const words = process.argv.slice(2);
  const option = (name: string): string | null => (words.includes(name) ? (words[words.indexOf(name) + 1] ?? null) : null);
  const [state, key, log, lie] = [option("--state"), option("--key"), option("--log"), option("--lie")];
  if (state === null || key === null || log === null) throw new Error("usage: standin.ts --state <folder> --key <file> --log <file> [--lie hash|card]");
  if (lie !== null) {
    console.log(`port ${await lyingServer(key, lie as Lie)}`);
  } else {
    const running = await startServer({ port: 0, state, origin: ORIGIN, rpId: RP_ID, signers: null }, () => {});
    console.log(`port ${running.port}`);
    void approveWhatWaits(`http://127.0.0.1:${running.port}/`, key, log);
  }
}
