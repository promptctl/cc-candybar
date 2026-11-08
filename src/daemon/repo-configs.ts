// [LAW:effects-at-boundaries] Recording the user's answers to "run this
// repository's cc-candybar config?", and the question the bar asks for each
// repository awaiting one. Where the answers are kept and how a load reads
// them is Config's (src/config/loader/repo-book.ts); the gate itself is pure
// (src/config/loader/repo-gate.ts).

import type { Filesystem, FilesystemReads } from "../disk/filesystem.js";
import { filedAt, type StateFile } from "../disk/state-file.js";
import type { SignedFields } from "../click/link-signer.js";
import type { RendererLinks } from "../click/renderer-links.js";
import { effectsUrl, VERB_REPO_CONFIG } from "../click/wire.js";
import { repoProject } from "../config/loader/discovery.js";
import {
  readRepoAnswers,
  repoConfigsPath,
} from "../config/loader/repo-book.js";
import {
  answerDir,
  gateRepos,
  REPO_ANSWERS,
  withAnswer,
  type RepoAnswer,
  type RepoConfigBook,
  type RepoGate,
} from "../config/loader/repo-gate.js";
import { worktreeLink } from "../utils/git-root.js";
import { ok } from "../utils/outcome.js";
import { presence, type Unchecked } from "../utils/presence.js";
import type { Asked } from "../doctor/checks.js";
import {
  APPROVAL_SEVERITY,
  diagnosticSpan,
  type DiagnosticMessage,
  type DiagnosticLine,
} from "../render/diagnostics.js";

// [LAW:one-source-of-truth] The answers as a store: read as every load reads
// them, and filed in the folder, so the first answer that changes the book
// while the folder holds none writes the loose one's answers into the folder
// with it. An answer the loose book already holds changes nothing, so it
// writes nothing, as with every state file.
export const repoConfigs = (
  disk: Filesystem,
  dir: string,
): StateFile<RepoConfigBook> =>
  filedAt(disk, repoConfigsPath(dir), () => readRepoAnswers(disk, dir));

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
  disk: Filesystem,
  stateDir: string,
  dir: string,
  answer: RepoAnswer,
): Asked<Recorded> {
  const store = repoConfigs(disk, stateDir);
  let recorded: Recorded = { superseded: [], absent: [], unchecked: [] };
  const filed = store.update((book) => {
    const others = Object.keys(book)
      .filter((d) => d !== dir)
      .map((d) => ({ d, found: presence(disk, d) }));
    recorded = {
      superseded: others
        .filter(
          ({ d, found }) =>
            found === "present" &&
            answerDir({ dir: d, link: worktreeLink(disk, d) }) === dir,
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

// The gate a one-shot load outside the daemon (the demo, the gallery) runs
// under. It loads the one file it was named, or none, never a searched chain,
// so of a repository's it runs only the plugins the project at `cwd` ships.
export function repoGateAt(
  reads: FilesystemReads,
  stateDir: string,
  cwd: string,
): RepoGate {
  return gateRepos(
    readRepoAnswers(reads, stateDir),
    [],
    repoProject(reads, cwd),
  );
}

// [LAW:single-enforcer] What an answer link signs: the session it was drawn
// for, the directory and the answer. Any web page can open a
// `cc-candybar://` link, so only an answer the bar drew is recorded. A `run`
// link's declaration is a JSON array and an answer's a directory, so neither
// verifies as the other under the one key.
export function repoAnswerFields(
  sessionId: string,
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

// [LAW:dataflow-not-control-flow] One channel per directory awaiting an
// answer — the list is the answer, so the diagnostics fold it beside the
// update notice with no "is there a question" branch. The sentence is plain
// text (the viewer's ⧉ copies it); each answer is its own signed click.
export function repoQuestions(
  gate: RepoGate,
  sessionId: string,
  links: RendererLinks,
): DiagnosticMessage[] {
  return gate.awaiting.map((dir) => {
    const message = `a cc-candybar config for ${dir} — run it?`;
    const answers = REPO_ANSWERS.map((answer) =>
      diagnosticSpan(
        `[${answer === "approved" ? "approve" : "decline"}]`,
        effectsUrl(links.to, [
          {
            verb: VERB_REPO_CONFIG,
            args: [
              sessionId,
              dir,
              answer,
              links.signer.sign(repoAnswerFields(sessionId, dir, answer)),
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
