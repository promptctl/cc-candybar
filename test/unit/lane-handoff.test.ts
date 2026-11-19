// The tmux pane can draw the bar while Claude Code shows a handoff row.

import { effectsUrl, VERB_RESET_CONFIG } from "../../src/click/wire";
import { laneSwitches } from "../../src/config/effective-globals";
import type { EffectiveGlobals } from "../../src/config/effective-globals";
import { HANDOFF_BUTTON, laneHandoff } from "../../src/renderer/lane-handoff";
import { sessionIdOf } from "../../src/daemon/foundations/session-id";

const S1 = sessionIdOf("s1");

const effective = (
  globals: Partial<Record<string, unknown>>,
): EffectiveGlobals =>
  ({
    experimentalStatusline: false,
    experimentalPane: false,
    ...globals,
  }) as unknown as EffectiveGlobals;

test("the tmux pane preference gates its lane independently of the statusline", () => {
  expect(laneSwitches(effective({ experimentalPane: true }))).toEqual({
    pane: true,
    statusline: false,
  });
});

describe("laneHandoff", () => {
  test("is one row holding the button alone", () => {
    const row = laneHandoff(S1, ["user"], ["pane"]);
    expect(row.lines).toHaveLength(1);
    expect(row.lines[0]!.map((span) => span.text)).toEqual([HANDOFF_BUTTON]);
  });

  test("its button resets the switch of the pane preference", () => {
    const row = laneHandoff(S1, ["user"], ["pane"]);
    expect(row.lines[0]![0]!.link).toBe(
      effectsUrl([
        {
          verb: VERB_RESET_CONFIG,
          args: ["s1", "user", "experimentalPane"],
        },
      ]),
    );
  });

  // The way out of a lane holds however this person saved the switch, and
  // leaves the project's checked-in file alone.
  test("its button resets the switch in this person's own layers, never the project's", () => {
    const row = laneHandoff(S1, ["user", "project", "local"], ["pane"]);
    expect(row.lines[0]![0]!.link).toBe(
      effectsUrl(
        (["user", "local"] as const).map((layer) => ({
          verb: VERB_RESET_CONFIG,
          args: ["s1", layer, "experimentalPane"],
        })),
      ),
    );
  });
});
