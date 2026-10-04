// The command tray: the slash commands typed into Claude Code most often, one
// click each from the bar (brandon-context-ceiling-xta.qhj).
//
// [LAW:one-type-per-behavior] A command button is a `slash` action and nothing
// more: the line is its data, typed through the one verb every slash click
// takes, so a user's own command button is one more action of the same shape.

import type { ActionDecl } from "./action.js";
import type { VariableDecl } from "./dsl-types.js";
import { confirmStep } from "./confirm-step.js";
import { IN_TMUX } from "./payload-inputs.js";
import { slashLine } from "../claude-input/slash-line.js";

const COMMANDS = ["/compact", "/model"] as const;
const CLEAR = "/clear";

// [LAW:locality-or-seam] Instanced under any name prefix, like the
// quick-action tray: the bundled `commands` segment and the settings menu's
// `candybar.commands` are two instances of this one tray.
export function commandTray(prefix: string): {
  readonly template: string;
  // The tray is all slash buttons, so it shows only where a click can type.
  readonly when: string;
  readonly actions: Readonly<Record<string, ActionDecl>>;
  readonly variables: Readonly<Record<string, VariableDecl>>;
  readonly disarm: string;
} {
  const commandAction = (line: string) => `${prefix}${line.slice(1)}`;
  const typeClear = `${prefix}clear.slash`;
  // /clear throws the conversation away, so it takes two clicks.
  const clear = confirmStep(
    `${prefix}clear`,
    { arm: CLEAR, confirm: `${CLEAR} ✓ confirm` },
    [typeClear],
  );
  return {
    template:
      COMMANDS.map(
        (line) => `{{ action "${commandAction(line)}" "${line}" }} `,
      ).join("") + clear.template,
    when: `{{ ${IN_TMUX} }}`,
    actions: {
      ...Object.fromEntries(
        COMMANDS.map((line) => [
          commandAction(line),
          { slash: slashLine(line) },
        ]),
      ),
      ...clear.actions,
      [typeClear]: { slash: slashLine(CLEAR) },
    },
    variables: clear.variables,
    disarm: clear.disarm,
  };
}
