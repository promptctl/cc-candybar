import type { ClaudeInputEdge } from "../../src/claude-input/typing";

// The claude-input edge of a case that never reaches Claude Code's input: a
// read or a type through it fails the case, naming what reached it.
export const UNREACHED_CLAUDE_INPUT: ClaudeInputEdge = {
  read: (hint) =>
    Promise.reject(new Error(`a case read Claude input in ${hint.pane}`)),
  type: (hint) =>
    Promise.reject(new Error(`a case typed Claude input in ${hint.pane}`)),
};
