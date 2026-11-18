// The parts of Node that this repository uses, declared by hand.
// The usual @types/node is an npm package, and this project installs none.
// If you use a Node function that is missing here, add it with the signature from the Node documentation.

type BufferEncoding = "utf8" | "hex" | "base64" | "base64url";
interface Buffer extends Uint8Array {
  toString(encoding?: BufferEncoding): string;
  includes(value: string | number, fromIndex?: number): boolean;
  equals(other: Uint8Array): boolean;
  subarray(begin?: number, end?: number): Buffer;
}
declare const Buffer: {
  alloc(size: number, fill?: number): Buffer;
  from(text: string, encoding?: BufferEncoding): Buffer;
  from(bytes: Uint8Array | ArrayBuffer | readonly number[]): Buffer;
  concat(list: readonly Uint8Array[]): Buffer;
  byteLength(text: string): number;
};

declare class TextEncoder {
  encode(text: string): Uint8Array;
}
declare class TextDecoder {
  constructor(encoding?: string, options?: { fatal?: boolean; ignoreBOM?: boolean });
  decode(bytes: Uint8Array): string;
}

declare const console: {
  log(...values: unknown[]): void;
  error(...values: unknown[]): void;
};

interface Timer {
  hasRef(): boolean;
}
declare function setTimeout(callback: () => void, milliseconds: number): Timer;
declare function clearTimeout(timer: Timer): void;

declare const process: {
  argv: string[];
  env: Record<string, string | undefined>;
  execPath: string;
  exitCode: number | undefined;
  kill(pid: number, signal?: string | number): true;
};

interface ImportMeta {
  readonly main: boolean;
  readonly dirname: string;
}

declare module "node:fs" {
  interface Stats {
    size: number;
    isFile(): boolean;
    isDirectory(): boolean;
    isSymbolicLink(): boolean;
  }
  export const constants: { O_RDONLY: number; O_NOFOLLOW: number; O_NONBLOCK: number };
  export function existsSync(path: string): boolean;
  // The first argument is a path, or the number of an open file.
  export function readFileSync(file: string | number): Buffer;
  export function readFileSync(file: string | number, encoding: "utf8"): string;
  export function writeFileSync(path: string, data: string | Uint8Array, options?: { flag?: string; mode?: number }): void;
  export function appendFileSync(path: string, data: string | Uint8Array): void;
  export function readdirSync(path: string): string[];
  export function mkdirSync(path: string, options?: { recursive?: boolean }): string | undefined;
  export function mkdtempSync(prefix: string): string;
  export function rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void;
  export function realpathSync(path: string): string;
  export function statSync(path: string): Stats;
  export function lstatSync(path: string): Stats;
  export function fstatSync(descriptor: number): Stats;
  export function readlinkSync(path: string): string;
  export function chmodSync(path: string, mode: number): void;
  export function renameSync(from: string, to: string): void;
  export function openSync(path: string, flags: string | number): number;
  export function closeSync(descriptor: number): void;
  // Both return the number of bytes read or written.
  export function readSync(descriptor: number, into: Uint8Array): number;
  export function writeSync(descriptor: number, text: string): number;
  export function symlinkSync(target: string, path: string): void;
}

declare module "node:path" {
  export const sep: string;
  export function join(...parts: string[]): string;
  export function resolve(...parts: string[]): string;
  export function dirname(path: string): string;
  export function basename(path: string): string;
}

declare module "node:os" {
  export function tmpdir(): string;
}

declare module "node:crypto" {
  interface Hash {
    update(data: string | Uint8Array): Hash;
    digest(): Buffer;
    digest(encoding: "hex" | "base64url"): string;
  }
  export function createHash(algorithm: string): Hash;
  export function randomBytes(size: number): Buffer;

  // A public or private key. "spki" is the usual DER form of a public key, "pkcs8" of a private key.
  export interface KeyObject {
    readonly type: "public" | "private" | "secret";
    readonly asymmetricKeyType?: string;
    readonly asymmetricKeyDetails?: { namedCurve?: string };
    export(options: { format: "der"; type: "spki" | "pkcs8" }): Buffer;
  }
  export function createPublicKey(key: { key: Uint8Array; format: "der"; type: "spki" }): KeyObject;
  // dsaEncoding "der" is the form of an ECDSA signature that passkeys use.
  export function verify(
    algorithm: string,
    data: Uint8Array,
    key: { key: KeyObject; dsaEncoding: "der" },
    signature: Uint8Array,
  ): boolean;
  // The next two are used by tests only: a software passkey needs a key and has to sign with it.
  export function generateKeyPairSync(type: "ec", options: { namedCurve: string }): { publicKey: KeyObject; privateKey: KeyObject };
  export function sign(algorithm: string, data: Uint8Array, key: { key: KeyObject; dsaEncoding: "der" }): Buffer;
}

declare module "node:child_process" {
  type Stdio = "pipe" | "ignore" | "inherit" | number;
  interface SpawnOptions {
    cwd?: string;
    env?: Record<string, string | undefined>;
    stdio?: Stdio | Stdio[];
    detached?: boolean;
  }
  interface SpawnSyncOptions extends SpawnOptions {
    input?: string | Uint8Array;
    timeout?: number;
  }
  interface ChildProcess {
    readonly pid: number | undefined;
    on(event: "exit", listener: (code: number | null, signal: string | null) => void): this;
    on(event: "error", listener: (error: Error) => void): this;
  }
  interface SpawnSyncResult<Output> {
    status: number | null;
    signal: string | null;
    stdout: Output;
    stderr: Output;
    error?: Error;
  }
  export function spawn(command: string, args: readonly string[], options?: SpawnOptions): ChildProcess;
  export function spawnSync(
    command: string,
    args: readonly string[],
    options: SpawnSyncOptions & { encoding: "utf8" },
  ): SpawnSyncResult<string>;
  export function spawnSync(
    command: string,
    args: readonly string[],
    options?: SpawnSyncOptions,
  ): SpawnSyncResult<Buffer | null>;
}

declare module "node:test" {
  export function test(name: string, body: () => void | Promise<void>): void;
  export function after(body: () => void | Promise<void>): void;
}

declare module "node:assert/strict" {
  const assert: {
    ok(value: unknown, message?: string): void;
    equal(actual: unknown, expected: unknown, message?: string): void;
    notEqual(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    match(text: string, pattern: RegExp, message?: string): void;
    doesNotMatch(text: string, pattern: RegExp, message?: string): void;
    throws(body: () => unknown, expected?: RegExp, message?: string): void;
    fail(message?: string): never;
  };
  export default assert;
}
