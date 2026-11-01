// The inputs a statusline tick reads, built to a size the benchmark names.
//
// [LAW:effects-at-boundaries] Everything a benchmark reads is built here under
// a directory it owns and removes: a measurement never reads the developer's
// repositories, transcripts or git config, because those change between runs
// and the numbers would be about them.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { transcriptTurn } from "../lib/transcript.js";

// A git that reads no configuration of the host's: its fsmonitor, untracked
// cache and aliases are variables the benchmark does not mean to measure.
export const HERMETIC_GIT_ENV: NodeJS.ProcessEnv = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "bench",
  GIT_AUTHOR_EMAIL: "bench@example.invalid",
  GIT_COMMITTER_NAME: "bench",
  GIT_COMMITTER_EMAIL: "bench@example.invalid",
};

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, {
    cwd,
    env: { ...process.env, ...HERMETIC_GIT_ENV },
    stdio: ["ignore", "ignore", "pipe"],
  });
}

// Short, under /tmp: a unix socket path is capped at 104 bytes on macOS, and
// os.tmpdir() there is already half of that.
export function scratchDir(prefix: string): string {
  return fs.mkdtempSync(path.join("/tmp", `${prefix}-`));
}

export interface RepoShape {
  // Tracked files, spread over directories of 100.
  readonly files: number;
  // Commits on main, the last two not yet on the remote.
  readonly commits: number;
  // Tracked files then modified, and files then added untracked: what `git
  // status` has to report.
  readonly modified: number;
  readonly untracked: number;
}

const fileAt = (root: string, i: number): string =>
  path.join(root, `d${Math.floor(i / 100)}`, `f${i}.ts`);

// A checkout on `main` with an upstream, two commits ahead of it, a dirty
// tree: the state the bundled bar's git segment spends its time on.
export function makeRepo(root: string, shape: RepoShape): void {
  fs.mkdirSync(root, { recursive: true });
  const remote = `${root}.remote.git`;
  git(root, "init", "-q", "-b", "main");
  for (let i = 0; i < shape.files; i++) {
    fs.mkdirSync(path.dirname(fileAt(root, i)), { recursive: true });
    fs.writeFileSync(
      fileAt(root, i),
      `export const f${i} = ${i}; // ${"x".repeat(60)}\n`,
    );
  }
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "seed");
  git(root, "init", "-q", "--bare", remote);
  git(root, "remote", "add", "origin", remote);
  git(root, "push", "-q", "-u", "origin", "main");
  for (let c = 1; c < shape.commits; c++) {
    fs.appendFileSync(fileAt(root, c % shape.files), `// commit ${c}\n`);
    git(root, "commit", "-q", "-a", "-m", `commit ${c}`);
    // The upstream stops two commits short of the head.
    if (c === shape.commits - 3) git(root, "push", "-q");
  }
  for (let i = 0; i < shape.modified; i++) {
    fs.appendFileSync(fileAt(root, i), "// dirty\n");
  }
  for (let i = 0; i < shape.untracked; i++) {
    fs.writeFileSync(path.join(root, `untracked-${i}.md`), "notes\n");
  }
}

// How many assistant turns a session has had: a session of a few hours is
// ~1,700 turns, ~5,000 lines.
export function writeTranscript(
  file: string,
  sessionId: string,
  cwd: string,
  turns: number,
): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const now = Date.now();
  const lines: string[] = [];
  for (let t = 0; t < turns; t++) {
    lines.push(
      transcriptTurn(sessionId, cwd, t, new Date(now - (turns - t) * 20_000)),
    );
  }
  fs.writeFileSync(file, lines.join(""));
}

// One more turn on the end of a transcript, as Claude Code appends it.
export function appendTurn(
  file: string,
  sessionId: string,
  cwd: string,
  t: number,
): void {
  fs.appendFileSync(file, transcriptTurn(sessionId, cwd, t, new Date()));
}

export function removeTree(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
}
