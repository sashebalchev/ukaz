// The parts of Node that this repository uses, declared by hand.
// The usual @types/node is an npm package, and this project installs none.
// If you use a Node function that is missing here, add it with the signature from the Node documentation.

interface Buffer extends Uint8Array {
  toString(encoding?: "utf8" | "hex" | "latin1"): string;
  equals(other: Uint8Array): boolean;
}
declare const Buffer: {
  from(data: string | readonly number[] | Uint8Array, encoding?: "utf8" | "hex" | "latin1"): Buffer;
  concat(parts: readonly Uint8Array[]): Buffer;
  alloc(size: number, fill?: number): Buffer;
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
  unref(): Timer;
}
declare function setTimeout(callback: () => void, milliseconds: number): Timer;
declare function clearTimeout(timer: Timer): void;

declare const process: {
  argv: string[];
  env: Record<string, string | undefined>;
  execPath: string;
  exitCode: number | undefined;
  pid: number;
  platform: string;
  cwd(): string;
  kill(pid: number, signal?: string | number): true;
};

interface ImportMeta {
  readonly main: boolean;
  readonly dirname: string;
  readonly filename: string;
}

declare module "node:fs" {
  interface Stats {
    size: number;
    mode: number;
    isFile(): boolean;
    isDirectory(): boolean;
    isSymbolicLink(): boolean;
  }
  export function existsSync(path: string): boolean;
  export function readFileSync(path: string): Buffer;
  export function readFileSync(path: string, encoding: "utf8"): string;
  export function writeFileSync(path: string, data: string | Uint8Array, options?: { flag?: string; mode?: number }): void;
  export function appendFileSync(path: string, data: string | Uint8Array): void;
  export function readdirSync(path: string): string[];
  export function mkdirSync(path: string, options?: { recursive?: boolean }): string | undefined;
  export function mkdtempSync(prefix: string): string;
  export function rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void;
  export function cpSync(from: string, to: string, options?: { recursive?: boolean }): void;
  export function realpathSync(path: string): string;
  export function statSync(path: string): Stats;
  export function lstatSync(path: string): Stats;
  export function openSync(path: string, flags: string): number;
  export function closeSync(descriptor: number): void;
  export function symlinkSync(target: string, path: string): void;
  export function chmodSync(path: string, mode: number): void;
}

declare module "node:path" {
  export const sep: string;
  export function join(...parts: string[]): string;
  export function resolve(...parts: string[]): string;
  export function relative(from: string, to: string): string;
  export function dirname(path: string): string;
  export function basename(path: string): string;
}

declare module "node:os" {
  export function tmpdir(): string;
}

declare module "node:crypto" {
  interface Hash {
    update(data: string | Uint8Array): Hash;
    digest(encoding: "hex"): string;
  }
  export function createHash(algorithm: string): Hash;
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
