// The update notice as a session's bar shows it: one update, the act on it
// and the session's own context folded into zero or one offer and zero or one
// failure. Shared, because the host's watch owns the update and its act, and
// the renderer folds the notice from what its world state carries.
//
// [LAW:one-type-per-behavior] Both facts render through one `Update` and one
// sentence shape; what differs is a table of words and a command.
//
// [LAW:effects-at-boundaries] Pure: every value arrives as an argument.

import {
  effectsUrl,
  VERB_APPLY_UPDATE,
  VERB_SET_CONFIG,
  VERB_SET_STATE,
} from "../../click/wire";
import {
  diagnosticSpan,
  UPDATE_SEVERITY,
  type DiagnosticLine,
  type DiagnosticMessage,
  type SourcedText,
} from "../../render/diagnostics";
import {
  formatVersion,
  shortDigest,
  type ActState,
  type SourceStamp,
  type Update,
} from "../../facts/world-state";
import type { SessionId } from "./session-id";
import {
  UPDATE_DISMISSED_KEY,
  UPDATE_NOTICE_FIELD,
  UPDATE_NOTICE_SESSION_KEY,
} from "./update-keys";

// What a dismissal names: the newer thing's identity, so a dismissal lapses
// the moment something newer again appears — the digest for source (the
// version alone would miss every uncommitted edit), the version for a release.
export function updateIdentity(update: Update): string {
  return update.kind === "source"
    ? update.newer.digest
    : formatVersion(update.newer);
}

// How a stamp reads to a person: the version it reports and the short digest
// that tells two builds of one version apart.
export const describeStamp = (s: SourceStamp): string =>
  `${s.version} [${shortDigest(s.digest)}]`;

// [LAW:dataflow-not-control-flow] The words, as one table the notice and the
// act both read. Nothing downstream asks which kind it is.
export interface UpdateWords {
  readonly headline: string;
  readonly newer: string;
  readonly running: string;
  readonly act: string;
  readonly busy: string;
}

export function wordsOf(update: Update): UpdateWords {
  switch (update.kind) {
    case "source":
      return {
        headline: "Newer source",
        newer: describeStamp(update.newer),
        running: describeStamp(update.running),
        act: "rebuild",
        busy: "rebuilding…",
      };
    case "release":
      return {
        headline: "Newer release",
        newer: formatVersion(update.newer),
        running: formatVersion(update.running),
        act: "upgrade",
        busy: "upgrading…",
      };
  }
}

// The per-session facts the notice reads: whose clicks these are, what this
// session dismissed (the identity it wrote, or nothing), and whether the
// session's config allows the notice at all (Globals.updateNotice).
export interface NoticeContext {
  readonly sessionId: SessionId;
  readonly dismissed: string | null;
  readonly enabled: boolean;
}

// What one update tells a session: the offer, an info message whose line is
// the sentence and the three affordances, and the failure of the last act on
// it, a plain warning of its own. They are two messages because they are two
// levels: the offer is nothing going wrong, a failed click is
// [LAW:no-silent-failure].
// [LAW:types-are-the-program] At most one of each, and no failure without its
// offer: a failure with nothing to retry is unrepresentable.
export type UpdateNotice =
  | { readonly offer: readonly []; readonly failure: readonly [] }
  | {
      readonly offer: readonly [DiagnosticMessage];
      readonly failure: readonly [] | readonly [SourcedText];
    };

const NO_NOTICE: UpdateNotice = { offer: [], failure: [] };

// [LAW:dataflow-not-control-flow] One update becomes zero or one offer and
// zero or one failure — the lists ARE the answer, so the diagnostics fold
// them beside the errors and warnings with no "is there a notice" branch.
// Both stand under the one gate: a dismissed or disabled offer hides its
// failure too. While the act runs the offer's affordance is a busy label.
export function updateNotice(
  update: Update | null,
  act: ActState,
  ctx: NoticeContext,
): UpdateNotice {
  if (update === null) return NO_NOTICE;
  const identity = updateIdentity(update);
  if (!ctx.enabled || ctx.dismissed === identity) return NO_NOTICE;
  const words = wordsOf(update);
  const sentence = `${words.headline}: ${words.newer}. You're on ${words.running}.`;
  const failedText = (text: string): SourcedText => ({
    about: `update-failed\0${identity}`,
    text,
    copy: text,
  });
  const failure: readonly [] | readonly [SourcedText] =
    act.kind === "failed" && act.identity === identity
      ? [failedText(`${words.act} failed: ${act.reason}`)]
      : [];
  // The sentence is plain text (the viewer's ⧉ copies it); the affordances
  // each carry their own effect.
  const actSpan =
    act.kind === "running"
      ? diagnosticSpan(`[${words.busy}]`, null)
      : diagnosticSpan(
          `[${words.act}]`,
          effectsUrl([{ verb: VERB_APPLY_UPDATE, args: [ctx.sessionId] }]),
        );
  const first: DiagnosticLine = [
    diagnosticSpan(sentence, null),
    actSpan,
    diagnosticSpan(
      "[dismiss]",
      effectsUrl([
        {
          verb: VERB_SET_STATE,
          args: [ctx.sessionId, UPDATE_DISMISSED_KEY, identity],
        },
      ]),
    ),
    diagnosticSpan(
      "[disable]",
      effectsUrl([
        {
          verb: VERB_SET_CONFIG,
          // The user's own file: the notice is the user's to turn off.
          args: [ctx.sessionId, "user", UPDATE_NOTICE_FIELD, "false"],
        },
        {
          verb: VERB_SET_STATE,
          args: [ctx.sessionId, UPDATE_NOTICE_SESSION_KEY, "false"],
        },
      ]),
    ),
  ];
  return {
    offer: [
      {
        severity: UPDATE_SEVERITY,
        about: `update\0${identity}`,
        message: sentence,
        copy: sentence,
        lines: [first],
      },
    ],
    failure,
  };
}
