// [LAW:effects-at-boundaries] The user's answers to "run this repository's
// cc-candybar config?" on disk, and the question the bar asks for each
// repository awaiting one. The gate itself is pure
// (src/config/loader/repo-gate.ts); this is where its answers are kept.

import path from "node:path";
import type { LinkSigner, SignedFields } from "../click/link-signer.js";
import {
  effectsUrl,
  VERB_REPO_CONFIG,
  VERB_SHOW_CONFIG_WARNING,
} from "../click/wire.js";
import { resolveDslConfig } from "../config/loader/discovery.js";
import {
  parseRepoConfigBook,
  REPO_ANSWERS,
  type RepoAnswer,
  type RepoConfigBook,
  type RepoGate,
} from "../config/loader/repo-gate.js";
import { stateFile, type StateFile } from "../doctor/state-file.js";
import {
  APPROVAL_SEVERITY,
  diagnosticSpan,
  type DiagnosticChannel,
  type DiagnosticLine,
} from "../render/diagnostic-strip.js";
import { stateDir } from "./paths.js";

const REPO_CONFIGS_FILE = "repo-configs.json";

// [LAW:one-source-of-truth] One book per user, under the state directory:
// an answer given in one session holds in every other, and after a restart.
export function repoConfigsPath(dir: string = stateDir()): string {
  return path.join(dir, REPO_CONFIGS_FILE);
}

export const repoConfigs = (
  dir: string = stateDir(),
): StateFile<RepoConfigBook> =>
  stateFile(dir, REPO_CONFIGS_FILE, {}, parseRepoConfigBook);

// The gate a one-shot load outside the daemon (the demo, the gallery) runs
// under: the file it was named, loaded from `cwd`, as a session there would.
export function repoGateAt(cwd: string, file: string | undefined): RepoGate {
  return resolveDslConfig(repoConfigs().read(), cwd, cwd, file).repos;
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
// answer — the list is the answer, so the strip folds it beside the update
// notice with no "is there a question" branch. The sentence copies itself, as
// every diagnostic row does; each answer is its own signed click.
export function repoQuestions(
  gate: RepoGate,
  sessionId: string,
  signer: LinkSigner,
): DiagnosticChannel[] {
  return gate.awaiting.map((dir) => {
    const message = `${dir} has a cc-candybar config — run it?`;
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
    const line: DiagnosticLine = [
      diagnosticSpan(
        message,
        effectsUrl([{ verb: VERB_SHOW_CONFIG_WARNING, args: [message] }]),
      ),
      ...answers,
    ];
    return { severity: APPROVAL_SEVERITY, message, lines: [line] };
  });
}
