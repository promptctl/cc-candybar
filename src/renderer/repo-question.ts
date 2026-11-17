// The question the bar asks of a repository awaiting the user's answer, and
// what each answer's link signs. The answers book is the host's
// (src/daemon/config-discovery/repo-configs.ts); the bar reads the standing
// its session's snapshot carries.

import type { SessionId } from "../daemon/foundations/session-id.js";
import type { LinkSigner, SignedFields } from "../click/link-signer.js";
import { effectsUrl, VERB_REPO_CONFIG } from "../click/wire.js";
import { REPO_ANSWERS, type RepoAnswer } from "../config/loader/repo-gate.js";
import type { RepoQuestion } from "../config/config-snapshot.js";
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

// [LAW:dataflow-not-control-flow] One channel for a repository awaiting an
// answer, none otherwise — the list is the answer, so the diagnostics fold it
// beside the update notice with no "is there a question" branch. The sentence
// is plain text (the viewer's ⧉ copies it); each answer is its own signed
// click.
export function repoQuestions(
  repo: RepoQuestion | null,
  sessionId: SessionId,
  signer: LinkSigner,
): DiagnosticMessage[] {
  const awaiting = repo?.standing === "awaiting" ? [repo.dir] : [];
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
