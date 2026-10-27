// [LAW:single-enforcer] Whether a repository's cc-candybar config runs. The
// user answers once per directory, as Claude Code asks once per project
// before it starts the servers a project's `.mcp.json` declares, and the
// answer holds across every later edit of the files. A repository's configs
// are its cwd and project layers and its `.cc-candybar/plugins/`; the user's
// XDG file, an explicit config path and the user's and package managers'
// plugin roots never ask.
//
// [LAW:effects-at-boundaries] Pure: the answers are read at each caller's
// edge (src/daemon/repo-configs.ts) and handed in.

import type { Outcome } from "../../utils/outcome.js";

export type RepoAnswer = "approved" | "declined";
export const REPO_ANSWERS: readonly RepoAnswer[] = ["approved", "declined"];

// The answers, keyed by each directory's real path.
export type RepoConfigBook = Readonly<Record<string, RepoAnswer>>;

// The book as its reader found it, or why it could not be read: the shape the
// doctor's state-file store reads, so that one store keeps it.
export type RepoAnswers = Extract<
  Outcome<RepoConfigBook>,
  { kind: "ok" | "failed" }
>;

declare const approved: unique symbol;

// [LAW:parse-dont-validate] A project directory the user approved, spelled as
// the session spells it: the only value whose `.cc-candybar/plugins/` the
// loader lists. `gateRepos` is its one constructor, so no caller can hand the
// loader a project it did not gate.
export type ApprovedRepo = string & { readonly [approved]: true };

export type RepoStanding = RepoAnswer | "awaiting";

// A directory's standing: its answer, or awaiting one. A book that could not
// be read answers for no directory, so every repository waits on it.
export function standing(answers: RepoAnswers, dir: string): RepoStanding {
  return answers.kind === "ok" && Object.hasOwn(answers.value, dir)
    ? answers.value[dir]!
    : "awaiting";
}

// What a session's repositories contribute, as their answers decide it.
export interface RepoGate {
  // The project whose `.cc-candybar/plugins/` loads: approved, or none.
  readonly plugins: ApprovedRepo | null;
  // Directories holding a config nobody has answered for: the bar asks.
  readonly awaiting: readonly string[];
  // Directories whose config the user declined: nothing runs, nothing asks.
  readonly declined: readonly string[];
  // Why the answers could not be read, or null.
  readonly unread: string | null;
}

// A session's project: its real directory, which its answer is kept by, the
// path the session spells it as, and whether its plugin folder ships a plugin.
export interface RepoProject {
  readonly dir: string;
  readonly path: string;
  readonly ships: boolean;
}

// The gate over the real directories a session reaches that hold a config
// (each once, however many of its files are found), and its project. The
// project asks only when its plugin folder ships plugins, but once approved
// its folder is listed whatever it holds, so one that cannot be listed is
// said.
export function gateRepos(
  answers: RepoAnswers,
  dirs: readonly string[],
  project: RepoProject | null,
): RepoGate {
  const reached = [
    ...new Set([...dirs, ...(project?.ships ? [project.dir] : [])]),
  ];
  return {
    plugins:
      project !== null && standing(answers, project.dir) === "approved"
        ? (project.path as ApprovedRepo)
        : null,
    awaiting: reached.filter((d) => standing(answers, d) === "awaiting"),
    declined: reached.filter((d) => standing(answers, d) === "declined"),
    unread: answers.kind === "failed" ? answers.reason : null,
  };
}

// The book with `dir` answered: the latest answer is the directory's.
export function withAnswer(
  book: RepoConfigBook,
  dir: string,
  answer: RepoAnswer,
): RepoConfigBook {
  return { ...book, [dir]: answer };
}

// [LAW:parse-dont-validate] The document as a book: directory, then answer.
export function parseRepoConfigBook(doc: unknown): RepoAnswers {
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
    return { kind: "failed", reason: "is not an object" };
  }
  for (const [dir, answer] of Object.entries(doc)) {
    if (!(REPO_ANSWERS as readonly unknown[]).includes(answer)) {
      return {
        kind: "failed",
        reason: `answers ${JSON.stringify(dir)} ${JSON.stringify(answer)}, not ${REPO_ANSWERS.join(" or ")}`,
      };
    }
  }
  return { kind: "ok", value: doc as RepoConfigBook };
}

// [LAW:no-silent-failure] A book that cannot be read is said wherever the
// gate is: the bar's strip, `check`, the demo.
export function repoUnreadNotice(gate: RepoGate): string | null {
  return gate.unread === null
    ? null
    : `Repository config answers could not be read: ${gate.unread} — no repository's config runs until they can be`;
}

// What a verdict outside the bar (`check`, the demo) says of each repository
// it did not run. The bar asks instead.
export function repoGateLines(gate: RepoGate): readonly string[] {
  const unread = repoUnreadNotice(gate);
  return [
    ...(unread === null ? [] : [unread]),
    ...gate.awaiting.map(
      (d) =>
        `awaiting approval: ${d} — its cc-candybar config runs once it is approved in the bar`,
    ),
    ...gate.declined.map(
      (d) => `declined: ${d} — its cc-candybar config does not run`,
    ),
  ];
}
