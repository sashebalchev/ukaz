// The registry: a list of the projects that have laws, so one command can say where all of them stand.
// It is a plain file, one absolute path per line, outside every repository. Nothing in it is trusted: it only says
// where to look; what is approved is still decided by each project's own signed manifests.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { LawsError } from "./cards.ts";

// $LAWS_PROJECTS, else $XDG_CONFIG_HOME/laws/projects, else ~/.config/laws/projects.
export function registryPath(): string {
  const own = process.env["LAWS_PROJECTS"];
  if (own !== undefined && own !== "") return resolve(own);
  const config = process.env["XDG_CONFIG_HOME"];
  const base = config !== undefined && config !== "" ? config : join(process.env["HOME"] ?? "/", ".config");
  return join(base, "laws", "projects");
}

export function readProjects(path: string): string[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").map((l) => l.trim()).filter((l) => l !== "" && !l.startsWith("#"));
}

function writeProjects(path: string, projects: string[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "# Projects that have laws (one absolute path per line). Managed by: laws projects add|remove <path>\n" + projects.join("\n") + (projects.length > 0 ? "\n" : ""));
}

export function addProject(path: string, dir: string): string {
  const absolute = resolve(dir);
  if (!existsSync(join(absolute, "laws"))) throw new LawsError(`${absolute} has no laws/ folder, so it is not a project with laws.`);
  const projects = readProjects(path);
  if (!projects.includes(absolute)) writeProjects(path, [...projects, absolute].sort());
  return absolute;
}

export function removeProject(path: string, dir: string): boolean {
  const absolute = resolve(dir);
  const projects = readProjects(path);
  if (!projects.includes(absolute)) return false;
  writeProjects(path, projects.filter((p) => p !== absolute));
  return true;
}

// laws projects [add <path> | remove <path>]
export function projectsCommand(rest: string[], print: (line: string) => void): number {
  const path = registryPath();
  const [verb, dir, ...more] = rest;
  if (verb === undefined) {
    const projects = readProjects(path);
    if (projects.length === 0) print(`no projects yet. Add one: laws projects add <path>  (the list is ${path})`);
    for (const p of projects) print(existsSync(join(p, "laws")) ? p : `${p}  (missing: no laws/ folder there any more)`);
    return 0;
  }
  if ((verb !== "add" && verb !== "remove") || dir === undefined || more.length > 0) throw new LawsError("usage: laws projects [add <path> | remove <path>]");
  if (verb === "add") print(`added ${addProject(path, dir)}`);
  else print(removeProject(path, dir) ? `removed ${resolve(dir)}` : `${resolve(dir)} was not in the list`);
  return 0;
}
