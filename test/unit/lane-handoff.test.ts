// The tmux pane can draw the bar while Claude Code shows a handoff row.

import { effectsUrl, VERB_RESET_CONFIG } from "../../src/click/wire";
import { hrefOfDrawnLink } from "../../src/render/drawn-link";
import { laneSwitches } from "../../src/config/effective-globals";
import type { EffectiveGlobals } from "../../src/config/effective-globals";
import { DEFAULT_DSL_CONFIG } from "../../src/config/default-dsl-config";
import { mergeWithDefault } from "../../src/config/loader/merge";
import {
  HANDOFF_BUTTON,
  laneDefaultsAfterReset,
  laneHandoff,
} from "../../src/renderer/lane-handoff";
import { sessionIdOf } from "../../src/daemon/foundations/session-id";

const S1 = sessionIdOf("s1");
const OFF = { pane: false, statusline: false, window: false };

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
    const row = laneHandoff(S1, ["user"], ["pane"], OFF);
    expect(row.lines).toHaveLength(1);
    expect(row.lines[0]!.map((span) => span.text)).toEqual([HANDOFF_BUTTON]);
  });

  test("its button resets the switch of the pane preference", () => {
    const row = laneHandoff(S1, ["user"], ["pane"], OFF);
    expect(hrefOfDrawnLink(row.lines[0]![0]!.link!)).toBe(
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
    const row = laneHandoff(S1, ["user", "project", "local"], ["pane"], OFF);
    expect(hrefOfDrawnLink(row.lines[0]![0]!.link!)).toBe(
      effectsUrl(
        (["user", "local"] as const).map((layer) => ({
          verb: VERB_RESET_CONFIG,
          args: ["s1", layer, "experimentalPane"],
        })),
      ),
    );
  });

  test("a checked-in pane setting survives resetting personal layers", () => {
    const project = { globals: { experimentalPane: true } };
    const config = mergeWithDefault(project, DEFAULT_DSL_CONFIG);
    const remaining = laneDefaultsAfterReset(
      config,
      DEFAULT_DSL_CONFIG,
      project,
    ).get("default");
    if (remaining === undefined) throw new Error("missing default preset");
    const row = laneHandoff(
      S1,
      ["user", "project", "local"],
      ["pane"],
      remaining,
    );
    expect(row.lines[0]![0]).toMatchObject({
      text: "The pane stays enabled by its config",
      link: null,
    });
  });

  test("an unavailable personal layer has no reset link", () => {
    const row = laneHandoff(S1, ["project"], ["pane"], OFF);
    expect(row.lines[0]![0]).toMatchObject({
      text: "No writable personal config layer for the pane",
      link: null,
    });
  });
});

describe("laneHandoff names the lanes it hands off", () => {
  test("the window, when the window draws the bar", () => {
    const row = laneHandoff(S1, ["project"], ["window"], OFF);
    expect(row.lines[0]![0]!.text).toBe(
      "No writable personal config layer for the window",
    );
  });

  test("every lane its config keeps on, together", () => {
    const row = laneHandoff(S1, ["user"], ["pane", "window"], {
      ...OFF,
      pane: true,
      window: true,
    });
    expect(row.lines[0]![0]!.text).toBe(
      "The pane and the window stay enabled by their config",
    );
  });
});
