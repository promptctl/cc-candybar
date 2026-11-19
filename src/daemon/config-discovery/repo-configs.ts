// [LAW:effects-at-boundaries] The user's answers to "run this repository's
// cc-candybar config?" on disk. The gate itself is pure (repo-gate.ts), and so
// is the question the bar asks (repo-question.ts); this is where the answers
// are kept, and it is the host's, because it opens the book.

import type { SessionId } from "../foundations/session-id.js";
import path from "node:path";
import {
  answerDir,
  parseRepoConfigBook,
  withAnswer,
  type RepoAnswer,
  type RepoConfigBook,
} from "../../config/loader/repo-gate.js";
import { worktreeLink } from "../../utils/git-root.js";
import { ok, type Asked } from "../../utils/outcome.js";
import { presence, type Unchecked } from "../../utils/presence.js";
import { stateFile, type Planned, type StateFile } from "../state-file.js";

const REPO_CONFIGS_FILE = "repo-configs.json";
// The book's own folder. The daemon polls the book's path, so a hand edit
// (removing an entry to be asked again) reaches every bar.
const REPO_CONFIGS_DIR = "repo-configs";

// [LAW:one-source-of-truth] One book per user, under the state directory:
// an answer given in one session holds in every other, and after a restart.
export function repoConfigsDir(dir: string): string {
  return path.join(dir, REPO_CONFIGS_DIR);
}

export function repoConfigsPath(dir: string): string {
  return path.join(repoConfigsDir(dir), REPO_CONFIGS_FILE);
}

// [LAW:one-source-of-truth] The book in its folder is the answers. One kept
// directly in the state directory, where the book used to live, is read
// only while the folder holds none, and the first answer recorded writes it
// into the folder with that answer and retires the older name.
export const repoConfigs = (
  dir: string,
  readText?: (file: string) => string | null,
): StateFile<RepoConfigBook> =>
  stateFile(
    [repoConfigsPath(dir), path.join(dir, REPO_CONFIGS_FILE)],
    {},
    parseRepoConfigBook,
    readText,
  );

// What recording an answer did to the book's other entries: the worktrees'
// own answers it superseded, and the entries no key can be proven for, which
// stay as they are: those whose directory is not there (a removed worktree,
// an unmounted volume), and those a stat could not see past.
export interface Recorded {
  readonly superseded: readonly string[];
  readonly absent: readonly string[];
  readonly unchecked: readonly Unchecked[];
}

// [LAW:single-enforcer] The repository at `dir` takes the
// answer, and every other entry whose directory is present and answers under
// `dir` (a linked worktree's own, kept from before answers were kept by
// repository) goes with it, so a repository holds one answer.
export function answering(
  book: RepoConfigBook,
  dir: string,
  answer: RepoAnswer,
): { readonly book: RepoConfigBook; readonly recorded: Recorded } {
  const others = Object.keys(book)
    .filter((d) => d !== dir)
    .map((d) => ({ d, found: presence(d) }));
  const recorded: Recorded = {
    superseded: others
      .filter(
        ({ d, found }) =>
          found === "present" &&
          answerDir({ dir: d, link: worktreeLink(d) }) === dir,
      )
      .map(({ d }) => d),
    absent: others.filter(({ found }) => found === "absent").map(({ d }) => d),
    unchecked: others.flatMap(({ found }) =>
      typeof found === "object" ? [found] : [],
    ),
  };
  return {
    book: withAnswer(book, dir, answer, recorded.superseded),
    recorded,
  };
}

// One repository's answer as a click gives it.
export interface Answer {
  readonly session: SessionId;
  readonly dir: string;
  readonly answer: RepoAnswer;
}

// [LAW:effects-at-boundaries] What answering `answers` in order makes of the
// book under `stateDir`: the disk changes and the messages emitted after
// those changes commit with the turn's config files.
export function answeredBook(
  stateDir: string,
  answers: readonly Answer[],
  readText: (file: string) => string | null,
): Asked<Planned<RepoConfigBook> & { readonly said: readonly string[] }> {
  const said: string[] = [];
  const planned = repoConfigs(stateDir, readText).plan((current) =>
    answers.reduce((book, { session, dir, answer }) => {
      const answered = answering(book, dir, answer);
      const { superseded, absent, unchecked } = answered.recorded;
      said.push(
        `repo-config: ${dir} ${answer} superseded=${superseded.join(",") || "-"} absent=${absent.join(",") || "-"} unchecked=${unchecked.length === 0 ? "-" : JSON.stringify(unchecked)} (session=${session})`,
      );
      return answered.book;
    }, current),
  );
  if (planned.kind === "failed") return planned;
  // [LAW:nothing-unseen] Identify the archive after a completed migration.
  if (planned.value.retire !== null)
    said.push(
      `repo-config: retired ${planned.value.retire.from} to ${planned.value.retire.to} after updating ${repoConfigsPath(stateDir)}`,
    );
  return ok({ ...planned.value, said });
}
