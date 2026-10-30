// [LAW:single-enforcer] Whether a repository's cc-candybar config runs. The
// user answers once per repository, as Claude Code asks once per project
// before it starts the servers a project's `.mcp.json` declares, and the
// answer holds across every later edit of the files and every worktree: a
// directory in a linked worktree answers under its main worktree's
// counterpart. A repository's configs are its cwd and project layers and its
// `.cc-candybar/plugins/`; the user's XDG file, an explicit config path and
// the user's and package managers' plugin roots never ask.
//
// [LAW:effects-at-boundaries] Pure: the answers are read at each caller's
// edge (src/daemon/repo-configs.ts) and handed in.

import type { WorktreeLink } from "../../utils/git-root.js";
import type { Outcome } from "../../utils/outcome.js";

export type RepoAnswer = "approved" | "declined";
export const REPO_ANSWERS: readonly RepoAnswer[] = ["approved", "declined"];

// The answers, keyed by each repository directory's real path (`answerDir`).
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

// [LAW:types-are-the-program] `unread` is not `awaiting`: a book that could
// not be read takes no answer either, so the bar asks nothing it could not
// record, and the unread notice speaks for every repository.
export type RepoStanding = RepoAnswer | "awaiting" | "unread";

// A directory a session reaches: its real path, and whether it sits in a
// linked worktree.
export interface RepoDir {
  readonly dir: string;
  readonly link: WorktreeLink;
}

// [LAW:one-source-of-truth] The directory a repository's answer is kept
// under: a linked worktree's counterpart in its main worktree, else the
// directory itself (an unproven link answers for nobody but itself).
export function answerDir(d: RepoDir): string {
  return d.link.kind === "linked" ? d.link.main : d.dir;
}

const answerOf = (book: RepoConfigBook, dir: string): RepoAnswer | null =>
  Object.hasOwn(book, dir) ? book[dir]! : null;

// A directory's standing, and the book entry it stands under. Only `approved`
// loads. The answer is its repository's; an answer the book still holds under
// a worktree's own path, kept from before answers were kept by repository,
// stands while the repository has none, and one that disagrees with the
// repository's leaves it awaiting, so neither answer wins unseen. Answering
// supersedes it (`withAnswer`).
interface Ruling {
  readonly standing: RepoStanding;
  readonly under: string;
}
function ruling(answers: RepoAnswers, d: RepoDir): Ruling {
  const key = answerDir(d);
  if (answers.kind === "failed") return { standing: "unread", under: key };
  const repo = answerOf(answers.value, key);
  const own = answerOf(answers.value, d.dir);
  if (repo === null) {
    return own === null
      ? { standing: "awaiting", under: key }
      : { standing: own, under: d.dir };
  }
  return {
    standing: own === null || own === repo ? repo : "awaiting",
    under: key,
  };
}
// A directory claiming to be a linked worktree that the repository does not
// vouch for, and why: it answers under its own path.
export interface UnprovenRepo {
  readonly dir: string;
  readonly reason: string;
}

// What a session's repositories contribute, as their answers decide it.
export interface RepoGate {
  // The project whose `.cc-candybar/plugins/` loads: approved, or none.
  readonly plugins: ApprovedRepo | null;
  // [LAW:single-enforcer] The reached directories whose config loads: what
  // the layer filter reads, so nothing else reads the answers.
  readonly approved: readonly string[];
  // Repositories holding a config nobody has answered for: the bar asks.
  readonly awaiting: readonly string[];
  // Repositories whose config the user declined: nothing runs, nothing asks.
  readonly declined: readonly string[];
  // Directories whose worktree claim failed its proof: each asks for itself.
  readonly unproven: readonly UnprovenRepo[];
  // Why the answers could not be read, or null.
  readonly unread: string | null;
}

// A session's project: its real directory, the path the session spells it
// as, and whether its plugin folder ships a plugin.
export interface RepoProject extends RepoDir {
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
  dirs: readonly RepoDir[],
  project: RepoProject | null,
): RepoGate {
  const reached = [
    ...new Map(
      [...dirs, ...(project?.ships ? [project] : [])].map((d) => [d.dir, d]),
    ).values(),
  ];
  // [LAW:one-source-of-truth] Each reached directory is ruled once, and
  // every list below is a view of those rulings.
  const ruled = reached.map((d) => ({ dir: d.dir, ...ruling(answers, d) }));
  const standing = (s: RepoStanding) => ruled.filter((r) => r.standing === s);
  const repos = (s: RepoStanding): string[] => [
    ...new Set(standing(s).map((r) => r.under)),
  ];
  return {
    plugins:
      project !== null && ruling(answers, project).standing === "approved"
        ? (project.path as ApprovedRepo)
        : null,
    approved: standing("approved").map((r) => r.dir),
    awaiting: repos("awaiting"),
    declined: repos("declined"),
    unproven: reached.flatMap((d) =>
      d.link.kind === "unproven" ? [{ dir: d.dir, reason: d.link.reason }] : [],
    ),
    unread: answers.kind === "failed" ? answers.reason : null,
  };
}

// The book with the repository at `dir` answered: the latest answer is the
// repository's, and the entries it supersedes (its worktrees' own, kept from
// before answers were kept by repository) go. The answer it already holds,
// superseding nothing, is the book itself, which the store writes nothing for.
export function withAnswer(
  book: RepoConfigBook,
  dir: string,
  answer: RepoAnswer,
  superseded: readonly string[],
): RepoConfigBook {
  if (book[dir] === answer && superseded.length === 0) return book;
  const rest = Object.entries(book).filter(([d]) => !superseded.includes(d));
  return { ...Object.fromEntries(rest), [dir]: answer };
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
    ...gate.unproven.map(
      (u) =>
        `not proven a worktree: ${u.dir} — it answers for itself, because ${u.reason}`,
    ),
  ];
}
