// [LAW:effects-at-boundaries] The user's answers to "run this repository's
// cc-candybar config?" on disk. The gate itself is pure (repo-gate.ts), and so
// is the question the bar asks (repo-question.ts); this is where the answers
// are kept, and it is the host's, because it opens the book.

import type { SessionId } from "../foundations/session-id.js";
import fs from "node:fs";
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
import {
  stateFile,
  written,
  type Planned,
  type StateFile,
} from "../state-file.js";

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
// into the folder with that answer: nothing is moved, so no answer is lost
// to a move, and every reader — the daemon and `check` — reads the
// same answers.
export const repoConfigs = (dir: string): StateFile<RepoConfigBook> => {
  const book = stateFile(
    repoConfigsDir(dir),
    REPO_CONFIGS_FILE,
    {},
    parseRepoConfigBook,
  );
  const loose = stateFile(dir, REPO_CONFIGS_FILE, {}, parseRepoConfigBook);
  const filed = (): boolean => fs.existsSync(repoConfigsPath(dir));
  const plan: StateFile<RepoConfigBook>["plan"] = (next) => {
    if (filed()) return book.plan(next);
    const kept = loose.read();
    if (kept.kind === "failed") return kept;
    return book.plan(() => next(kept.value));
  };
  return {
    read: () => (filed() ? book : loose).read(),
    plan,
    update: (next) => written(plan(next)),
  };
};

// What recording an answer did to the book's other entries: the worktrees'
// own answers it superseded, and the entries no key can be proven for, which
// stay as they are: those whose directory is not there (a removed worktree,
// an unmounted volume), and those a stat could not see past.
export interface Recorded {
  readonly superseded: readonly string[];
  readonly absent: readonly string[];
  readonly unchecked: readonly Unchecked[];
}

// [LAW:single-enforcer] The one way an answer changes the book — the bar's
// click and the tests' approvals alike: the repository at `dir` takes the
// answer, and every other entry whose directory is present and answers under
// `dir` (a linked worktree's own, kept from before answers were kept by
// repository) goes with it, so a repository holds one answer.
function answering(
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

export function recordAnswer(
  store: StateFile<RepoConfigBook>,
  dir: string,
  answer: RepoAnswer,
): Asked<Recorded> {
  let recorded: Recorded = { superseded: [], absent: [], unchecked: [] };
  const filed = store.update((book) => {
    const answered = answering(book, dir, answer);
    recorded = answered.recorded;
    return answered.book;
  });
  return filed.kind === "failed" ? filed : ok(recorded);
}

// One repository's answer as a click gives it.
export interface Answer {
  readonly session: SessionId;
  readonly dir: string;
  readonly answer: RepoAnswer;
}

// [LAW:effects-at-boundaries] What answering `answers` in order makes of the
// book under `stateDir`, unwritten, so it lands with the config files its
// click changed: the file and its next text, and each answer's line.
export function answeredBook(
  stateDir: string,
  answers: readonly Answer[],
): Asked<Planned<RepoConfigBook> & { readonly said: readonly string[] }> {
  const said: string[] = [];
  const planned = repoConfigs(stateDir).plan((current) =>
    answers.reduce((book, { session, dir, answer }) => {
      const answered = answering(book, dir, answer);
      const { superseded, absent, unchecked } = answered.recorded;
      said.push(
        `repo-config: ${dir} ${answer} superseded=${superseded.join(",") || "-"} absent=${absent.join(",") || "-"} unchecked=${unchecked.length === 0 ? "-" : JSON.stringify(unchecked)} (session=${session})`,
      );
      return answered.book;
    }, current),
  );
  return planned.kind === "failed" ? planned : ok({ ...planned.value, said });
}
