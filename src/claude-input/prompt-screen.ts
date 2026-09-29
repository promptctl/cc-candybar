// Whether Claude Code's pane is at a prompt a typed command can land in —
// read off the pane itself, because nothing else knows.
//
// Measured on Claude Code 2.1.284 inside tmux (brandon-context-ceiling-xta.7xt):
//   - A turn in progress is safe. An immediate command (`/rename`) runs at
//     once; the rest (`/compact`, `/context`) queue and run when the turn ends.
//   - A draft in the input is safe once stashed: ctrl+s stashes it, and Claude
//     Code restores a stash after every submit, queued ones included.
//   - A stash the user already holds is NOT safe: ctrl+s on an empty input
//     pops it, and the command is appended to it and sent as a prompt.
//   - A dialog is NOT safe: with a permission prompt up, the Enter approves the
//     pending tool call. Pickers and other dialogs replace the input the same way.
//   - A pane in tmux copy mode takes keys as copy-mode commands, not input.
// So the edge types only into the bare input box, with no stash held, in a
// pane tmux is not holding in a mode. Everything else is a refusal, and a
// screen this module does not recognise is one too: an unrecognised
// Claude Code is never typed into blind.

export interface PaneSnapshot {
  // tmux's `#{pane_in_mode}`: copy mode, view mode, or any other mode.
  readonly inMode: boolean;
  readonly screen: readonly string[];
}

export type PromptState =
  | { readonly kind: "ready" }
  | { readonly kind: "in-mode" }
  | { readonly kind: "stashed" }
  | { readonly kind: "no-prompt" };

// The input box is the last two rules on the screen with the `❯` prompt
// directly under the first; the hint row directly above it names a held stash
// (`… · › stashed`), queued messages or not. A dialog draws its own `❯`
// indented under text, never directly under a rule. A rule starts in column 0
// only as Claude Code's chrome: transcript text is indented under its `⏺`, and
// a markdown `---` draws no rule at all.
const RULE = /^─{20,}/;
const PROMPT = /^❯(\s|$)/;
const STASHED = /›\s*stashed$/;

export function promptState(snapshot: PaneSnapshot): PromptState {
  if (snapshot.inMode) return { kind: "in-mode" };
  const lines = snapshot.screen.map((l) => l.trimEnd());
  const rules = lines.flatMap((l, i) => (RULE.test(l) ? [i] : []));
  const top = rules.at(-2);
  if (top === undefined || !PROMPT.test(lines[top + 1] ?? "")) {
    return { kind: "no-prompt" };
  }
  return STASHED.test(lines[top - 1] ?? "")
    ? { kind: "stashed" }
    : { kind: "ready" };
}

export const REFUSALS: Record<Exclude<PromptState["kind"], "ready">, string> = {
  "in-mode":
    "the Claude Code pane is in tmux copy mode — leave it (q) and click again",
  stashed:
    "Claude Code is holding a stashed prompt (ctrl+s) — restore or send it, then click again",
  "no-prompt":
    "Claude Code is not at its prompt (a dialog or picker is open) — close it and click again",
};
