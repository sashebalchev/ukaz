import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type RunResult = {
  exitCode: number | null; // null if it was stopped at the time limit or killed by a signal
  timedOut: boolean;
  leftRunning: boolean; // it ended by itself and something it started was still running; that was stopped
  notStopped: boolean; // something it started could not be confirmed gone
  output: string; // everything it printed, both streams, in order
};

// Runs a shell command in its own process group, with a marker in its environment that everything it
// starts inherits. When the command ends, or when the time limit passes, the whole group is killed, and
// so is every process that carries the marker, also one that left the group. Then we wait until all are gone.
// Output goes to a file, not a pipe, so a process that outlives the command cannot make us wait.
export async function runCommand(command: string, folder: string, timeoutSeconds: number): Promise<RunResult> {
  // A variable name of its own, not a shared name with a value: a laws run inside this one adds its
  // marker and leaves ours in place.
  const marker = `LAWS_RUN_${randomBytes(16).toString("hex")}`;
  const scratch = mkdtempSync(join(tmpdir(), "laws-run-"));
  const outputFile = join(scratch, "output");
  const output = openSync(outputFile, "w");
  try {
    const child = spawn("sh", ["-c", command], {
      cwd: folder,
      detached: true, // makes the child the leader of a new process group
      stdio: ["ignore", output, output],
      env: { ...process.env, [marker]: "1" },
    });
    const group = child.pid;

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(group);
    }, timeoutSeconds * 1000);
    const exitCode = await new Promise<number | null>((done) => {
      child.on("error", () => done(null));
      child.on("exit", (code) => done(code));
    });
    clearTimeout(timer);

    const leftRunning = !timedOut && (await anyProcessWith(marker));
    const gone = await stopEverything(group, marker);
    return { exitCode: timedOut ? null : exitCode, timedOut, leftRunning, notStopped: !gone, output: read(outputFile) };
  } finally {
    closeSync(output);
    rmSync(scratch, { recursive: true, force: true });
  }
}

export function lastLines(output: string, count: number): string {
  return output.trimEnd().split("\n").slice(-count).join("\n");
}

function killGroup(group: number | undefined): void {
  if (group !== undefined) kill(-group);
}

function kill(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already gone. stopEverything() is what decides.
  }
}

// The running processes of this user whose environment carries the marker. A process that has ended
// and only waits to be collected has no environment any more, so it is not found.
// Not found either: a process that cleared its environment, or one that Linux does not let us read
// (it changed user, or made itself unreadable like ssh-agent does).
function processesWith(marker: string): number[] {
  let names: string[];
  try {
    names = readdirSync("/proc");
  } catch {
    return []; // no /proc on this system: only the process group is stopped
  }
  const found: number[] = [];
  for (const name of names.filter((candidate) => /^[0-9]+$/.test(candidate))) {
    try {
      if (readFileSync(`/proc/${name}/environ`).includes(`${marker}=`)) found.push(Number(name));
    } catch {
      // Another user's process, or it ended while we looked.
    }
  }
  return found;
}

// One look is not enough to say that nothing is left. A process that was just started shows an empty
// environment for a moment, while Linux swaps its old program for the new one, and one look in that
// moment misses it. So "nothing" counts only after this many looks in a row, 20 ms apart, found nothing.
const CLEAN_LOOKS = 4;
const LOOK_PAUSE_MS = 20;

function pause(): Promise<void> {
  return new Promise<void>((wake) => setTimeout(() => wake(), LOOK_PAUSE_MS));
}

// True as soon as one look finds a process with the marker. False only after CLEAN_LOOKS empty looks.
async function anyProcessWith(marker: string): Promise<boolean> {
  for (let look = 0; look < CLEAN_LOOKS; look++) {
    if (look > 0) await pause();
    if (processesWith(marker).length > 0) return true;
  }
  return false;
}

// Kills the group and every process with the marker until none is left. Killed processes take a moment
// to go, so this looks again for up to three seconds, and it wants CLEAN_LOOKS empty looks in a row before
// it says that all are gone. Signal 0 only asks whether the group has a process.
async function stopEverything(group: number | undefined, marker: string): Promise<boolean> {
  let cleanLooks = 0;
  for (let attempt = 0; attempt < 150; attempt++) {
    killGroup(group);
    const marked = processesWith(marker);
    for (const pid of marked) kill(pid);
    cleanLooks = marked.length === 0 && groupIsEmpty(group) ? cleanLooks + 1 : 0;
    if (cleanLooks >= CLEAN_LOOKS) return true;
    await pause();
  }
  return false;
}

function groupIsEmpty(group: number | undefined): boolean {
  if (group === undefined) return true;
  try {
    process.kill(-group, 0);
    return false;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "ESRCH";
  }
}

function read(file: string): string {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "(the output could not be read)";
  }
}
