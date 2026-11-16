// The question the bar asks for each repository awaiting an answer to "run
// this repository's cc-candybar config?", and what its answer link signs. The
// gate itself is pure (src/config/loader/repo-gate.ts), and the answers are
// kept in src/config/repo-book.ts.

import type { SessionId } from "../daemon/foundations/session-id.js";
import type { LinkSigner, SignedFields } from "../click/link-signer.js";
import { effectsUrl, VERB_REPO_CONFIG } from "../click/wire.js";
import {
  REPO_ANSWERS,
  type RepoAnswer,
  type RepoGate,
} from "../config/loader/repo-gate.js";
import {
  APPROVAL_SEVERITY,
  diagnosticSpan,
  type DiagnosticMessage,
  type DiagnosticLine,
} from "../render/diagnostics.js";

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

// [LAW:dataflow-not-control-flow] One channel per directory awaiting an
// answer — the list is the answer, so the diagnostics fold it beside the
// update notice with no "is there a question" branch. The sentence is plain
// text (the viewer's ⧉ copies it); each answer is its own signed click.
export function repoQuestions(
  gate: RepoGate,
  sessionId: SessionId,
  signer: LinkSigner,
): DiagnosticMessage[] {
  return gate.awaiting.map((dir) => {
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
