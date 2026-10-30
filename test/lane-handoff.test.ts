// candybar-plugins-vf6g.qzx: the tmux status line is switched by the renderer
// setting, and the statusline a lane hands the bar off from is one small row
// whose button draws it back in Claude Code's.

import { effectsUrl, VERB_RESET_CONFIG } from "../src/click/wire";
import { laneSwitches } from "../src/config/effective-globals";
import type { EffectiveGlobals } from "../src/config/effective-globals";
import { HANDOFF_BUTTON, laneHandoff } from "../src/daemon/lane-handoff";

const effective = (
  globals: Partial<Record<string, unknown>>,
): EffectiveGlobals =>
  ({
    renderer: "claude",
    experimentalBand: false,
    experimentalStatusline: false,
    experimentalPane: false,
    ...globals,
  }) as unknown as EffectiveGlobals;

describe("laneSwitches", () => {
  test("the renderer tmux switches the tmux status line on, and claude off", () => {
    expect(laneSwitches(effective({ renderer: "tmux" }), true).tmuxStatus).toBe(
      true,
    );
    expect(
      laneSwitches(effective({ renderer: "claude" }), true).tmuxStatus,
    ).toBe(false);
  });

  test("a session outside tmux ignores the renderer tmux: its tmux status line stays off", () => {
    expect(
      laneSwitches(effective({ renderer: "tmux" }), false).tmuxStatus,
    ).toBe(false);
  });

  test("a 🧪 toggle switches its own lane alone, in tmux or out", () => {
    expect(laneSwitches(effective({ experimentalPane: true }), false)).toEqual({
      band: false,
      statusline: false,
      pane: true,
      tmuxStatus: false,
    });
  });
});

describe("laneHandoff", () => {
  test("is one row holding the button alone", () => {
    const row = laneHandoff("s1", ["tmuxStatus"]);
    expect(row.lines).toHaveLength(1);
    expect(row.lines[0]!.map((span) => span.text)).toEqual([HANDOFF_BUTTON]);
  });

  test("its button resets the switch of each lane it hands off to: the renderer, and a 🧪 toggle", () => {
    const row = laneHandoff("s1", ["band", "tmuxStatus"]);
    expect(row.lines[0]![0]!.link).toBe(
      effectsUrl([
        {
          verb: VERB_RESET_CONFIG,
          args: ["s1", "experimentalBand", "renderer"],
        },
      ]),
    );
  });
});
