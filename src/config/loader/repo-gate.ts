// [LAW:single-enforcer] Whether a repository's cc-candybar config runs. The
// user answers once per repository, as Claude Code asks once per project
// before it starts the servers a project's `.mcp.json` declares, and the
// answer holds across every later edit of the files and every worktree: a
// directory in a linked worktree answers under its main worktree's
// counterpart. A repository's configs are its project and local layers and its
// `.cc-candybar/plugins/`; the user's XDG file, an explicit config path and
// the user's and package managers' plugin roots never ask.
//
// [LAW:effects-at-boundaries] Pure: the answers are read at each caller's
// edge (src/daemon/config-discovery/repo-configs.ts) and handed in.

import type { WorktreeLink } from "../../utils/git-root.js";
import type { RepoQuestion } from "../config-snapshot.js";
import type { Asked } from "../../utils/outcome.js";

export type RepoAnswer = "approved" | "declined";
export const REPO_ANSWERS: readonly RepoAnswer[] = ["approved", "declined"];

// The answers, keyed by each repository directory's real path (`answerDir`).
export type RepoConfigBook = Readonly<Record<string, RepoAnswer>>;

// The decisions the host read, or the error that prevented their use.
export type RepoAnswers = Asked<RepoConfigBook>;

declare const approved: unique symbol;

// [LAW:parse-dont-validate] A project directory the user approved, spelled as
// the session spells it. Only its plugin definitions may be opened.
export type ApprovedRepo = string & { readonly [approved]: true };

// [LAW:types-are-the-program] `unread` is not `awaiting`: a book that could
// not be read takes no answer either, so the bar asks nothing it could not
// record, and the unread notice speaks for every repository.
type RepoStanding = RepoQuestion["standing"];

// A directory a session reaches: its real path, and whether it sits in a
// linked worktree.
export interface RepoDir {
  readonly dir: string;
  readonly link: WorktreeLink;
}

// [LAW:one-source-of-truth] The directory a repository's answer is kept
// under: a linked worktree's counterpart in its main worktree, else the
// directory itself. [LAW:no-silent-failure] A failed read leaves the key
// unknown and cannot be treated as a decided standalone directory.
export function answerDir(d: RepoDir): string | null {
  switch (d.link.kind) {
    case "linked":
      return d.link.main;
    case "unreadable":
      return null;
    case "unlinked":
    case "unproven":
      return d.dir;
  }
}

const answerOf = (book: RepoConfigBook, dir: string): RepoAnswer | null =>
  Object.hasOwn(book, dir) ? book[dir]! : null;

// [LAW:one-source-of-truth] The project's decision covers every verified
// linked worktree. A worktree's older entry serves it until the project has
// a decision of its own. Answering the project supersedes its older entries.
interface Ruling {
  readonly standing: RepoStanding;
  readonly under: string;
}
function ruling(answers: RepoAnswers, d: RepoDir): Ruling {
  const key = answerDir(d);
  if (key === null) return { standing: "unread", under: d.dir };
  if (answers.kind === "failed") return { standing: "unread", under: key };
  const repo = answerOf(answers.value, key);
  if (repo !== null) return { standing: repo, under: key };
  const legacy = answerOf(answers.value, d.dir);
  return legacy === null
    ? { standing: "awaiting", under: key }
    : { standing: legacy, under: d.dir };
}
// [LAW:one-source-of-truth] A query reaches one project. Its approved path
// admits all of that project's read and write roles. Its question is shown
// only when the project actually supplies a config or a plugin.
export interface ProjectAccess {
  readonly approved: ApprovedRepo | null;
  readonly question: RepoQuestion | null;
  readonly unread: string | null;
  readonly unreadIdentity: {
    readonly dir: string;
    readonly reason: string;
  } | null;
}

export const NO_PROJECT_ACCESS: ProjectAccess = {
  approved: null,
  question: null,
  unread: null,
  unreadIdentity: null,
};

export interface RepoProject extends RepoDir {
  readonly path: string;
  readonly contributes: boolean;
}

export function projectAccess(
  answers: RepoAnswers,
  project: RepoProject | null,
): ProjectAccess {
  const unread = answers.kind === "failed" ? answers.reason : null;
  if (project === null) return { ...NO_PROJECT_ACCESS, unread };
  const { standing, under } = ruling(answers, project);
  return {
    approved: standing === "approved" ? (project.path as ApprovedRepo) : null,
    question: project.contributes
      ? {
          dir: under,
          standing,
          unproven:
            project.link.kind === "unproven" ? project.link.reason : null,
        }
      : null,
    unread,
    unreadIdentity:
      project.link.kind === "unreadable"
        ? { dir: project.dir, reason: project.link.reason }
        : null,
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

// [LAW:no-silent-failure] A book that cannot be read is said wherever the
// gate is presented on the bar.
export function repoUnreadNotice(gate: ProjectAccess): string | null {
  return gate.unread === null
    ? null
    : `Repository config answers could not be read: ${gate.unread} — no repository's config runs until they can be`;
}

// [LAW:one-source-of-truth] One wording per standing, for what a verdict
// outside the bar says of a repository it did not run. The bar asks instead.
const awaitingLine = (dir: string): string =>
  `awaiting approval: ${dir} — its cc-candybar config runs once it is approved in the bar`;
const declinedLine = (dir: string): string =>
  `declined: ${dir} — its cc-candybar config does not run`;
const unprovenLine = (dir: string, reason: string): string =>
  `not proven a worktree: ${dir} — it answers for itself, because ${reason}`;

// Current notices for the one repository the bar asks about: where it
// stands, and a worktree link that could not be proven. An approved one, and
// an answers book that could not be read (the load's own warning), add
// nothing.
export function repoQuestionLines(
  question: RepoQuestion | null,
): readonly string[] {
  if (question === null) return [];
  const standing = {
    awaiting: [awaitingLine(question.dir)],
    declined: [declinedLine(question.dir)],
    approved: [],
    unread: [],
  } satisfies Record<RepoQuestion["standing"], readonly string[]>;
  return [
    ...standing[question.standing],
    ...(question.unproven === null
      ? []
      : [unprovenLine(question.dir, question.unproven)]),
  ];
}
