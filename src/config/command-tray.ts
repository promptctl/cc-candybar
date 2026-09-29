// The command tray: the slash commands typed into Claude Code most often, one
// click each from the bar (brandon-context-ceiling-xta.qhj).
//
// [LAW:one-type-per-behavior] A command button is a `slash` action and nothing
// more: the line is its data, typed through the one verb every slash click
// takes, so a user's own command button is one more action of the same shape.

import type { ActionDecl } from "./action.js";
import type { VariableDecl } from "./dsl-types.js";
import type { SlashLine } from "../claude-input/slash-line.js";

const COMMANDS = ["/compact", "/model"] as const;
const CLEAR = "/clear";
const ARMED = "armed";
const DISARMED = "disarmed";

// [LAW:locality-or-seam] Instanced under any name prefix, like the
// quick-action tray: the bundled `commands` segment and the settings menu's
// `candybar.commands` are two instances of this one tray.
export function commandTray(prefix: string): {
  readonly template: string;
  readonly actions: Readonly<Record<string, ActionDecl>>;
  readonly variables: Readonly<Record<string, VariableDecl>>;
  // The action that disarms /clear — fired by whatever reopens the tray, so a
  // confirm is only ever clicked in the view that armed it.
  readonly disarm: string;
} {
  const name = (action: string) => `${prefix}${action}`;
  const armed = name("clearArmed");
  const commandAction = (line: string) => name(line.slice(1));
  return {
    // [LAW:dataflow-not-control-flow] /clear throws the conversation away, so
    // it takes two clicks: which of its views the tray shows is the arm key's
    // value, read back here.
    template:
      COMMANDS.map(
        (line) => `{{ action "${commandAction(line)}" "${line}" }} `,
      ).join("") +
      `{{ if eq .${armed} "${ARMED}" }}` +
      `{{ action "${name("clear")}" "${CLEAR} ✓ confirm" }} {{ action "${name("clear.disarm")}" "✕" }}` +
      `{{ else }}{{ action "${name("clear.arm")}" "${CLEAR}" }}{{ end }}`,
    actions: {
      ...Object.fromEntries(
        COMMANDS.map((line) => [
          commandAction(line),
          { slash: line as SlashLine },
        ]),
      ),
      [name("clear.arm")]: { set: armed, to: ARMED },
      [name("clear.disarm")]: { set: armed, to: DISARMED },
      // The confirm types the line and disarms in the same click.
      [name("clear")]: { do: [name("clear.slash"), name("clear.disarm")] },
      [name("clear.slash")]: { slash: CLEAR as SlashLine },
    },
    variables: {
      [armed]: { kind: "state", key: armed, default: DISARMED },
    },
    disarm: name("clear.disarm"),
  };
}
