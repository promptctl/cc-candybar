// The fixtures of a process started from a shell inside another repository:
// real repositories, the shell's variables that name one, a `git` that stands
// in for the machine's, and a child's environment read back.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// A repository at `dir/name`, on `branch`, with one commit.
export function gitRepo(dir: string, name: string, branch: string): string {
  const at = path.join(dir, name);
  fs.mkdirSync(at);
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: at, stdio: "pipe" });
  git("init", "-q", "-b", branch);
  git(
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "c",
  );
  return at;
}

// What a shell inside the repository at `repo` (a hook, a `rebase --exec`, a
// vcsh shell) sets that names it, and the forges' repositories.
export const shellInside = (repo: string): NodeJS.ProcessEnv => ({
  GIT_DIR: path.join(repo, ".git"),
  GIT_WORK_TREE: repo,
  GH_REPO: "someone/elsewhere",
  GITLAB_REPO: "someone/elsewhere",
});

// The names `shellInside` sets.
export const SHELL_NAMES = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GH_REPO",
  "GITLAB_REPO",
] as const;

// A PATH, under `dir`, whose `git`, ahead of every other, runs `script`.
export function pathWithGit(dir: string, script: string): string {
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, "git"), `#!/bin/sh\n${script}\n`, {
    mode: 0o755,
  });
  return `${bin}:${process.env.PATH}`;
}

// The machine's own git, for a stand-in that answers only some asks.
export const realGit = (): string =>
  execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();

// `env`'s output as its variables.
export const envOf = (printed: string): Record<string, string> =>
  Object.fromEntries(
    printed
      .split("\n")
      .filter((line) => line.includes("="))
      .map((line) => [
        line.slice(0, line.indexOf("=")),
        line.slice(line.indexOf("=") + 1),
      ]),
  );

// Whether the live process `pid` has each of `names` in its environment.
// [LAW:dataflow-not-control-flow] exception: where a process's environment
// can be read is the OS's to say, /proc on Linux and `ps -E` on macOS. `ps`
// prints the command and then each NAME=value with nothing to tell a space in
// a value from one between entries, so a name is found where an entry starts
// (after a separator) and nothing splits the line.
export function environmentHas(
  pid: number,
  names: readonly string[],
): boolean[] {
  const proc = `/proc/${pid}/environ`;
  const text = fs.existsSync(proc)
    ? `\0${fs.readFileSync(proc, "utf8")}`
    : execFileSync("ps", ["-E", "-ww", "-p", String(pid), "-o", "command="], {
        encoding: "utf8",
      });
  return names.map((name) => new RegExp(`[\\s\\0]${name}=`).test(text));
}
