// Typing a slash line into a session's Claude Code, over an edge that reads
// its pane and types into it. The host's acts type through the one edge the
// daemon is given (the tmux one is src/claude-input/edge.ts).
//
// [LAW:effects-at-boundaries] The two tmux calls — read the pane, type into
// it — live behind `ClaudeInputEdge`; whether to type is `typeSlash`'s fold
// over pure facts (the session's recorded tmux hint, promptState).
//
// [LAW:single-enforcer] tmux is the only route: the client reports the
// session's tmux socket and pane (src/tmux-hint.ts), so the keys reach THAT
// pane and nothing else. Outside tmux there is no pane to address, and typing
// into whatever window has focus is exactly what this must never do.

import type { ClientHints } from "../daemon/foundations/protocol.js";
import type { TmuxHint } from "../tmux-hint.js";
import { promptState, REFUSALS, type PaneSnapshot } from "./prompt-screen.js";
import type { SlashLine } from "./slash-line.js";

export interface ClaudeInputEdge {
  // Both throw naming tmux's own failure. `type` answers with the refusal
  // when a line was typed into the session too recently to type another.
  readonly read: (hint: TmuxHint) => Promise<PaneSnapshot>;
  readonly type: (hint: TmuxHint, line: SlashLine) => Promise<Typed>;
}

export type Typed =
  | { readonly kind: "typed" }
  | { readonly kind: "refused"; readonly reason: string };

export type TypeResult =
  | { readonly kind: "typed"; readonly pane: string }
  | { readonly kind: "refused"; readonly reason: string };

// A slash line typed into a pane, once the prompt there reads ready.
export type SlashTyper = (
  pane: TmuxHint,
  line: SlashLine,
) => Promise<TypeResult>;

// The pane a session's client reported, or why the bar has none to act in.
export type SessionPane =
  | { readonly kind: "pane"; readonly hint: TmuxHint }
  | { readonly kind: "refused"; readonly reason: string };

// [LAW:parse-dont-validate] The one reading of the tmux hint's three states
// for everything the daemon does in a session's pane.
export function tmuxPaneOf(tmux: ClientHints["tmux"]): SessionPane {
  if (tmux === undefined) {
    return {
      kind: "refused",
      reason:
        "this session's statusline client reports no tmux facts (it predates this daemon) — rebuild or reinstall cc-candybar",
    };
  }
  if (tmux === null) {
    return {
      kind: "refused",
      reason:
        "this Claude Code is not running inside tmux — the bar can only act in a tmux pane",
    };
  }
  return { kind: "pane", hint: tmux };
}

// A slash line typed into the session's pane: refused for a session whose
// client reported none, and otherwise typed into it (`typeInPane`).
export async function typeSlash(
  type: SlashTyper,
  pane: SessionPane,
  line: SlashLine,
): Promise<TypeResult> {
  return pane.kind === "refused" ? pane : type(pane.hint, line);
}

// A slash line typed into `tmux`, once the prompt there reads ready.
export const typeInPane =
  (edge: ClaudeInputEdge) =>
  async (tmux: TmuxHint, line: SlashLine): Promise<TypeResult> => {
    const state = promptState(await edge.read(tmux));
    if (state.kind !== "ready") {
      return { kind: "refused", reason: REFUSALS[state.kind] };
    }
    const typed = await edge.type(tmux, line);
    return typed.kind === "typed" ? { kind: "typed", pane: tmux.pane } : typed;
  };
