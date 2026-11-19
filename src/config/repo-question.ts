// [LAW:effects-at-boundaries] The question the bar asks for a repository
// awaiting an answer and its typed answer targets. Pure: the snapshot's
// repository question carries every fact it reads, so the renderer draws it
// without opening the book of answers, which the host keeps.

import type { SessionId } from "../daemon/foundations/session-id.js";
import { REPO_ANSWERS } from "./loader/repo-gate.js";
import type { RepoQuestion } from "./config-snapshot.js";
import {
  APPROVAL_SEVERITY,
  diagnosticSpan,
  type DiagnosticMessage,
  type DiagnosticLine,
} from "../render/diagnostics.js";

// [LAW:dataflow-not-control-flow] One channel while the origin's repository
// awaits an answer. The viewer's ⧉ copies its plain text. Every answer has
// its own target to publish as a signed click.
export function repoQuestions(
  question: RepoQuestion | null,
  sessionId: SessionId,
): DiagnosticMessage[] {
  const awaiting = question?.standing === "awaiting" ? [question.dir] : [];
  return awaiting.map((dir) => {
    const message = `a cc-candybar config for ${dir} — run it?`;
    const answers = REPO_ANSWERS.map((answer) =>
      diagnosticSpan(`[${answer === "approved" ? "approve" : "decline"}]`, {
        kind: "repo-answer",
        session: sessionId,
        dir,
        answer,
      }),
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
