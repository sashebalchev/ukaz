import { spawn } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type RunResult = {
  exitCode: number | null; // null if it was stopped at the time limit or killed by a signal
  timedOut: boolean;
  leftBehind: boolean; // true if something it started could not be confirmed gone
  lastLines: string;
};

const LINES_KEPT = 15;

// Runs a shell command in its own process group. When it ends, or when the time limit passes,
// the whole group is killed and we wait until no process of the group is left.
// Output goes to a file, not a pipe, so a process that outlives the command cannot make us wait.
export async function runCommand(command: string, folder: string, timeoutSeconds: number): Promise<RunResult> {
  const scratch = mkdtempSync(join(tmpdir(), "laws-run-"));
  const outputFile = join(scratch, "output");
  const output = openSync(outputFile, "w");
  try {
    const child = spawn("sh", ["-c", command], { cwd: folder, detached: true, stdio: ["ignore", output, output] });
    const group = child.pid; // "detached" makes the child the leader of a new process group

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

    killGroup(group);
    const gone = await groupIsGone(group);
    return { exitCode: timedOut ? null : exitCode, timedOut, leftBehind: !gone, lastLines: lastLines(outputFile) };
  } finally {
    closeSync(output);
    rmSync(scratch, { recursive: true, force: true });
  }
}

function killGroup(group: number | undefined): void {
  if (group === undefined) return;
  try {
    process.kill(-group, "SIGKILL");
  } catch {
    // Nothing left to kill. groupIsGone() is what decides.
  }
}

// Signal 0 only asks whether the group still has a process. Killed processes take a moment to go.
async function groupIsGone(group: number | undefined): Promise<boolean> {
  if (group === undefined) return true;
  for (let attempt = 0; attempt < 150; attempt++) {
    try {
      process.kill(-group, 0);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ESRCH") return true;
    }
    await new Promise<void>((wake) => setTimeout(() => wake(), 20));
  }
  return false;
}

function lastLines(file: string): string {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return "(the output could not be read)";
  }
  return text.trimEnd().split("\n").slice(-LINES_KEPT).join("\n");
}
