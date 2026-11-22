// laws init [<path>] [--register]: set a project up for laws in one command. It creates the laws/ folder and a CI
// workflow that fails a pull request unless every law is approved exactly as it is now. It never overwrites a file.
// The signers file (who may approve) is NOT in the repository: CI reads it from the repository variable LAWS_SIGNERS,
// which the owner sets (public keys only), so an agent that can push cannot change who may approve by editing a file.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { LawsError } from "./cards.ts";
import { addProject, registryPath } from "./projects.ts";

const readText = (path: string): string => readFileSync(path, "utf8");

export type InitResult = { created: string[]; kept: string[] };

// The workflow. ukaz is pinned to one commit on purpose: moving the checker is a deliberate change.
export function workflowText(rev: string): string {
  return [
    "# laws: every law in this repository must be approved exactly as it is now. Made by \"laws init\".",
    "# Needs: the repository variable LAWS_SIGNERS (the lines of the allowed-signers file: public keys only). Make this check",
    "# required in the branch rules (Settings, Rules), with no bypass, or an agent can merge without it.",
    "name: laws",
    "on:",
    "  pull_request:",
    "  push:",
    "    branches: [main]",
    "permissions:",
    "  contents: read",
    "jobs:",
    "  verify:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - uses: actions/checkout@v4",
    "      - uses: actions/setup-node@v4",
    "        with:",
    "          node-version: 24",
    "      - uses: actions/checkout@v4",
    "        with:",
    "          repository: sashebalchev/ukaz",
    `          ref: ${rev}`,
    "          path: .laws-tool",
    "      - name: the signers file, outside the repository",
    "        env:",
    "          LAWS_SIGNERS_TEXT: ${{ vars.LAWS_SIGNERS }}",
    "        run: |",
    "          test -n \"$LAWS_SIGNERS_TEXT\" || { echo \"the repository variable LAWS_SIGNERS is not set\"; exit 1; }",
    "          printf '%s\\n' \"$LAWS_SIGNERS_TEXT\" > \"$RUNNER_TEMP/allowed_signers\"",
    "      - run: node .laws-tool/src/cli.ts verify --signers \"$RUNNER_TEMP/allowed_signers\"",
    "",
  ].join("\n");
}

export function initProject(dir: string, rev: string): InitResult {
  const root = resolve(dir);
  if (!existsSync(root)) throw new LawsError(`${root} does not exist.`);
  const result: InitResult = { created: [], kept: [] };
  const put = (path: string, text: string): void => {
    const file = join(root, path);
    if (existsSync(file)) { result.kept.push(path); return; }
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, text);
    result.created.push(path);
  };
  put("laws/README.md", "# Laws\n\nThe laws of this project, one card per file (laws/<ID>.md), with their checks. Approvals are in laws/approvals/. See github.com/sashebalchev/ukaz. Change a law only through its own pull request: an approved law that changes needs a new signature.\n");
  put(".github/workflows/laws.yml", workflowText(rev));
  return result;
}

// The commit of the ukaz checkout this code runs from, or "main" when it cannot be told.
function toolRevision(): string {
  try {
    const head = join(import.meta.dirname, "..", ".git", "HEAD");
    const ref = readText(head).trim();
    const sha = ref.startsWith("ref: ") ? readText(join(import.meta.dirname, "..", ".git", ref.slice(5))).trim() : ref;
    return /^[0-9a-f]{40}$/.test(sha) ? sha : "main";
  } catch {
    return "main";
  }
}
export function initCommand(rest: string[], repo: string, register: boolean, print: (line: string) => void): number {
  if (rest.length > 1) throw new LawsError("usage: laws init [<path>] [--register]");
  const dir = resolve(rest[0] ?? repo);
  const result = initProject(dir, toolRevision());
  for (const path of result.created) print(`created ${path}`);
  for (const path of result.kept) print(`kept    ${path} (it was already there)`);
  if (register) print(`registered ${addProject(registryPath(), dir)}`);
  print("Next, once per project (only you can do these):");
  print("  1. set the repository variable LAWS_SIGNERS to the lines of /etc/laws/allowed_signers (public keys only)");
  print("  2. make the \"verify\" check required in the branch rules, with no bypass");
  print("Then write the first laws: /grill, then /law.");
  return 0;
}
