// [LAW:effects-at-boundaries] The user's answers to "run this repository's
// cc-candybar config?" on disk, and the question the bar asks for each
// repository awaiting one. The gate itself is pure
// (src/config/loader/repo-gate.ts); this is where its answers are kept.

import type { SessionId } from "../daemon/foundations/session-id.js";
import fs from "node:fs";
import path from "node:path";
import type { LinkSigner, SignedFields } from "../click/link-signer.js";
import { effectsUrl, VERB_REPO_CONFIG } from "../click/wire.js";
import {
  answerDir,
  parseRepoConfigBook,
  REPO_ANSWERS,
  withAnswer,
  type RepoAnswer,
  type RepoConfigBook,
} from "./loader/repo-gate.js";
import type { RepoQuestion } from "./config-snapshot.js";
import { worktreeLink } from "../utils/git-root.js";
import { ok } from "../utils/outcome.js";
import { presence, type Unchecked } from "../utils/presence.js";
import type { Asked } from "../doctor/checks.js";
import {
  stateFile,
  written,
  type Planned,
  type StateFile,
} from "../doctor/state-file.js";
import {
  APPROVAL_SEVERITY,
  diagnosticSpan,
  type DiagnosticMessage,
  type DiagnosticLine,
} from "../render/diagnostics.js";

const REPO_CONFIGS_FILE = "repo-configs.json";
// The book's own folder: the daemon watches it so a hand edit (removing an
// entry to be asked again) reaches every bar, and the state directory itself
// holds the log, which writes on every request — a watch there wakes on each
// line.
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
// to a move, and every reader — the daemon, `check`, the doctor — reads the
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

// [LAW:single-enforcer] What an answer link signs: the session it was drawn
// for, the directory and the answer. Any web page can open a
// `cc-candybar://` link, so only an answer the bar drew is recorded. A `run`
// link's declaration is a JSON array and an answer's a directory, so neither
// verifies as the other under the one key.
export function repoAnswerFields(
  sessionId: SessionId,
  dir: string,
  answer: RepoAnswer,
): SignedFields {
  return {
    sessionId,
    action: VERB_REPO_CONFIG,
    declaration: dir,
    evaluated: answer,
  };
}

// [LAW:dataflow-not-control-flow] One channel while the origin's repository
// awaits an answer — the list is the answer, so the diagnostics fold it beside
// the update notice with no "is there a question" branch. The sentence is
// plain text (the viewer's ⧉ copies it); each answer is its own signed click.
export function repoQuestions(
  question: RepoQuestion | null,
  sessionId: SessionId,
  signer: LinkSigner,
): DiagnosticMessage[] {
  const awaiting = question?.standing === "awaiting" ? [question.dir] : [];
  return awaiting.map((dir) => {
    const message = `a cc-candybar config for ${dir} — run it?`;
    const answers = REPO_ANSWERS.map((answer) =>
      diagnosticSpan(
        `[${answer === "approved" ? "approve" : "decline"}]`,
        effectsUrl([
          {
            verb: VERB_REPO_CONFIG,
            args: [
              sessionId,
              dir,
              answer,
              signer.sign(repoAnswerFields(sessionId, dir, answer)),
            ],
          },
        ]),
      ),
    );
    const line: DiagnosticLine = [diagnosticSpan(message, null), ...answers];
    return {
      severity: APPROVAL_SEVERITY,
      about: `repo-question\0${dir}`,
      message,
      copy: message,
      lines: [line],
    };
  });
}
