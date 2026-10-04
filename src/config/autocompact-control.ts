// Claude Code's auto-compact window, read and moved from the bar
// (brandon-context-ceiling-xta.e3p): where Claude Code itself will summarize
// the context. Claude Code's `/autocompact` is the window's only writer, so
// each control types that command into the session; the daemon names the
// window − and + land on (autoCompactControls, src/segments/autocompact.ts),
// and ↺ hands the window back to `auto`.

import type { ActionDecl } from "./action.js";
import { IN_TMUX } from "./payload-inputs.js";
import { AUTOCOMPACT_WINDOWS } from "../segments/autocompact.js";
import { slashLine } from "../claude-input/slash-line.js";

// [LAW:locality-or-seam] Instanced under any name prefix, like the command
// tray: the bundled `autocompact` segment and the settings menu's
// `candybar.autocompact` are two instances of this one control. `formatCount`
// spells the window's token count from a template expression: the bundled
// instance calls the config's overridable `formatTokenCount` helper, the
// menu's inlines the rule (src/config/format-token-count.ts).
export function autocompactControl(
  prefix: string,
  formatCount: (n: string) => string,
): {
  readonly template: string;
  readonly bg: string;
  readonly when: string;
  readonly actions: Readonly<Record<string, ActionDecl>>;
} {
  return {
    template:
      '{{ if ne .autocompact.error "" }}⇲ ⚠ {{ .autocompact.error }}{{ else }}' +
      "⇲ {{ if eq .autocompact.window 0 }}auto{{ else }}" +
      `${formatCount(".autocompact.applied")}{{ end }}` +
      // The window reads anywhere; its controls show only where a click has a
      // pane to type into.
      `{{ if ${IN_TMUX} }}` +
      `{{ if gt .autocompact.lower 0 }} {{ action (printf "${prefix}%d" .autocompact.lower) "−" }}{{ end }}` +
      `{{ if gt .autocompact.higher 0 }} {{ action (printf "${prefix}%d" .autocompact.higher) "+" }}{{ end }}` +
      `{{ if gt .autocompact.window 0 }} {{ action "${prefix}auto" "↺" }}{{ end }}{{ end }}{{ end }}`,
    // [LAW:no-silent-failure] An unreadable settings file paints `error`.
    bg: '{{ if ne .autocompact.error "" }}{{ color "error" }}{{ else }}{{ tint }}{{ end }}',
    when: '{{ or (ge .autocompact.window 0) (ne .autocompact.error "") }}',
    // [LAW:one-source-of-truth] One action per window Claude Code accepts, so
    // the lines a click can type are exactly AUTOCOMPACT_WINDOWS; the template
    // picks one by name.
    actions: {
      [`${prefix}auto`]: { slash: slashLine("/autocompact auto") },
      ...Object.fromEntries(
        AUTOCOMPACT_WINDOWS.map((w) => [
          `${prefix}${w}`,
          { slash: slashLine(`/autocompact ${w}`) },
        ]),
      ),
    },
  };
}
