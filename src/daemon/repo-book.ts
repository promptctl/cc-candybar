// [LAW:single-enforcer] The one writer of the repository answers book
// (src/config/repo-book.ts): the host performs an `approve-repo` here.

import {
  answerDir,
  withAnswer,
  type RepoAnswer,
  type RepoConfigBook,
} from "../config/loader/repo-gate.js";
import { worktreeLink } from "../utils/git-root.js";
import { ok } from "../utils/outcome.js";
import { presence, type Unchecked } from "../utils/presence.js";
import type { Asked } from "../doctor/checks.js";
import type { StateFile } from "../doctor/state-file.js";

// What recording an answer did to the book's other entries: the worktrees'
// own answers it superseded, and the entries no key can be proven for, which
// stay as they are: those whose directory is not there (a removed worktree,
// an unmounted volume), and those a stat could not see past.
export interface Recorded {
  readonly superseded: readonly string[];
  readonly absent: readonly string[];
  readonly unchecked: readonly Unchecked[];
}

// [LAW:single-enforcer] The one way an answer reaches the book — the bar's
// click and the tests' approvals alike: the repository at `dir` takes the
// answer, and every other entry whose directory is present and answers under
// `dir` (a linked worktree's own, kept from before answers were kept by
// repository) goes with it, so a repository holds one answer.
export function recordAnswer(
  store: StateFile<RepoConfigBook>,
  dir: string,
  answer: RepoAnswer,
): Asked<Recorded> {
  let recorded: Recorded = { superseded: [], absent: [], unchecked: [] };
  const filed = store.update((book) => {
    const others = Object.keys(book)
      .filter((d) => d !== dir)
      .map((d) => ({ d, found: presence(d) }));
    recorded = {
      superseded: others
        .filter(
          ({ d, found }) =>
            found === "present" &&
            answerDir({ dir: d, link: worktreeLink(d) }) === dir,
        )
        .map(({ d }) => d),
      absent: others
        .filter(({ found }) => found === "absent")
        .map(({ d }) => d),
      unchecked: others.flatMap(({ found }) =>
        typeof found === "object" ? [found] : [],
      ),
    };
    return withAnswer(book, dir, answer, recorded.superseded);
  });
  return filed.kind === "failed" ? filed : ok(recorded);
}
