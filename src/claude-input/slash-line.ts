// The line a `slash` action types into its session's Claude Code prompt.
//
// [LAW:parse-dont-validate] The loader is the one checkpoint a line crosses:
// what leaves it is a `SlashLine`, and the verb and the tmux edge take only
// that type, so no text a URL carried can reach a keystroke — a click is
// honoured only as a line some declared action already holds.
//
// [LAW:types-are-the-program] What makes a line safe to type is that the
// keystrokes ARE the text: a newline would submit early, an ESC would start a
// terminal or key sequence. So a line is one slash command — `/` then a
// command name — with no control character anywhere. The Enter that submits
// it is the edge's, never the author's.

export type SlashLine = string & { readonly __slashLine: unique symbol };

// C0, DEL and C1 are the characters a terminal reads as something other than
// text. The schema publishes this same source (loader/actions.ts).
export const SLASH_LINE_PATTERN =
  "^/[^\\s\\x00-\\x1f\\x7f-\\x9f/][^\\x00-\\x1f\\x7f-\\x9f]*$";
const SLASH_LINE = new RegExp(SLASH_LINE_PATTERN);

export type ParsedSlashLine =
  | { readonly kind: "line"; readonly line: SlashLine }
  | { readonly kind: "refused"; readonly reason: string };

export function parseSlashLine(raw: unknown): ParsedSlashLine {
  return typeof raw === "string" && SLASH_LINE.test(raw)
    ? { kind: "line", line: raw as SlashLine }
    : {
        kind: "refused",
        reason: `a slash command is "/" then its name, e.g. "/compact" or "/model opus", on one line with no control characters, got ${JSON.stringify(raw)}`,
      };
}
