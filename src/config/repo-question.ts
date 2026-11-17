// [LAW:effects-at-boundaries] The question the bar asks for a repository
// awaiting an answer, and what its answer link signs. Pure: the snapshot's
// repository question carries every fact it reads, so the renderer draws it
// without opening the book of answers, which the host keeps.

import type { SessionId } from "../daemon/foundations/session-id.js";
import type { LinkSigner, SignedFields } from "../click/link-signer.js";
import { effectsUrl, VERB_REPO_CONFIG } from "../click/wire.js";
import { REPO_ANSWERS, type RepoAnswer } from "./loader/repo-gate.js";
import type { RepoQuestion } from "./config-snapshot.js";
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
