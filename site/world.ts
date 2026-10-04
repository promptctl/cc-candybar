// The simulated machine the daemon runs on in the page: a home directory, a
// repository with its .git, Claude Code's config dir, and a `git` that answers
// from the repository's state. The scenario (scenario.ts) moves that state and
// the session's transcript; the daemon reads both exactly as it reads a real
// machine, through node:fs and node:child_process (site/shims).

import { vol } from "./shims/fs";
import { HOME } from "./shims/os";
import { programs, type ProgramRun } from "./shims/child_process";

export { HOME };
export const REPO = `${HOME}/code/tidepool`;
export const CLAUDE_DIR = `${HOME}/.claude`;
const GIT = `${REPO}/.git`;
const REMOTE = "https://github.com/example/tidepool.git";

/** The repository as `git status` would report it. */
export interface RepoState {
  readonly branch: string;
  readonly ahead: number;
  readonly behind: number;
  /** Tracked files with unstaged changes. */
  readonly modified: readonly string[];
  readonly untracked: readonly string[];
  /** When HEAD was committed, unix seconds. */
  readonly headTime: number;
  readonly head: string;
}

let repo: RepoState;

export const CONFIG_FILE = `${HOME}/.config/cc-candybar/config.json5`;

/**
 * Lay the machine out, once per page: the daemon's watchers hold on to these
 * files, so a replay moves the repository (`updateRepo`) and starts a new
 * transcript rather than laying the machine out again.
 */
export function seedWorld(state: RepoState): void {
  vol.fromJSON({
    [`${REPO}/README.md`]: "# tidepool\n",
    [`${REPO}/src/cache.ts`]: "export {};\n",
    [`${GIT}/HEAD`]: `ref: refs/heads/${state.branch}\n`,
    [`${GIT}/config`]: `[core]\n\tbare = false\n[remote "origin"]\n\turl = ${REMOTE}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`,
    [`${GIT}/index`]: "",
    [`${GIT}/refs/heads/${state.branch}`]: `${state.head}\n`,
    [`${GIT}/logs/refs/stash`]: "0000 1111 demo <demo@example.com> 1759000000 +0000\tWIP on main: try a bigger TTL\n",
    [`${CLAUDE_DIR}/settings.json`]: "{}\n",
    [`${HOME}/.config/cc-candybar/.keep`]: "",
    [`${HOME}/.local/state/.keep`]: "",
    "/tmp/.keep": "",
  });
  repo = state;
}

/**
 * Change the repository. Its index is rewritten too, as a real `git add` or
 * edit-and-status would leave it: the daemon's git cache is invalidated by
 * that file changing, so a change it cannot see would never be drawn.
 */
export function updateRepo(next: Partial<RepoState>): void {
  repo = { ...repo, ...next };
  vol.writeFileSync(`${GIT}/index`, JSON.stringify(repo));
  vol.writeFileSync(`${GIT}/refs/heads/${repo.branch}`, `${repo.head}\n`);
}

const ok = (stdout: string): ProgramRun => ({ code: 0, stdout });

// The four commands the git segment runs (src/segments/git.ts); anything else
// fails as git does, and says so in the console, so a new one is noticed.
programs.set("git", (args) => {
  const line = args.join(" ");
  if (line.startsWith("status --porcelain=v2 --branch")) {
    const rows = [
      `# branch.oid ${repo.head}`,
      `# branch.head ${repo.branch}`,
      `# branch.upstream origin/${repo.branch}`,
      `# branch.ab +${repo.ahead} -${repo.behind}`,
      ...repo.modified.map((f) => `1 .M N... 100644 100644 100644 ${"a".repeat(40)} ${"b".repeat(40)} ${f}`),
      ...repo.untracked.map((f) => `? ${f}`),
    ];
    return ok(rows.join("\n") + "\n");
  }
  if (line.startsWith("log -1 --format=%ct")) return ok(`${repo.headTime}\n`);
  if (line.startsWith("describe --tags --abbrev=0")) return ok("v0.4.2\n");
  if (line.startsWith("config --local --get-regexp")) return ok(`remote.origin.url ${REMOTE}\n`);
  console.warn(`simulated git: no answer for \`git ${line}\``);
  return { code: 128, stdout: "", stderr: `fatal: the demo's git does not answer \`${line}\`\n` };
});

/** Forget what the settings menu saved: the next render is the bundled default again. */
export function forgetConfig(): void {
  if (vol.existsSync(CONFIG_FILE)) vol.unlinkSync(CONFIG_FILE);
}

/** A session's transcript file, empty, ready to be appended to. */
export function newTranscript(sessionId: string): string {
  const file = `${CLAUDE_DIR}/projects/-home-demo-code-tidepool/${sessionId}.jsonl`;
  vol.mkdirSync(`${CLAUDE_DIR}/projects/-home-demo-code-tidepool`, { recursive: true });
  vol.writeFileSync(file, "");
  return file;
}

export function appendTranscript(file: string, entries: readonly object[]): void {
  if (entries.length === 0) return;
  vol.appendFileSync(file, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
}
