// A session's stored pick can name something outside its setting's domain: a
// theme this build does not install, a style or preset the config no longer
// declares, an effect, an endcaps shape, a padding out of range, a placement's
// theme naming nothing installed. Driven through the real render, drawn as the
// daemon draws it (the session's picks resolved once, the payload's
// `.effective` fields and the strip's options read from that): the bar draws
// the fallback, says once per stale key what was stored and what it wears
// instead, and keeps the stored value, so a config declaring the member again
// draws the pick with nothing to say.

import { textOf } from "../src/render/frame";
import { EDIT_LIVE_KEY, placementDraftKey } from "../src/config/edit-chrome";
import { DISCLOSURE_OPEN } from "../src/config/disclosure";
import {
  EDIT_MODE_ARRANGE,
  EDIT_MODE_KEY,
} from "../src/config/loader/edit-mode";
import { effectsOf } from "./helpers/click";
import { linkUrls } from "./helpers/frame";
import { buildRig, type Rig } from "./helpers/rig";
import { globalsFor } from "./helpers/selection";
import {
  effectiveInputs,
  renderOptionsOf,
} from "../src/renderer/render-payload";
import { sessionIdOf } from "../src/daemon/foundations/session-id";
import type { DrawnFrame, RenderWarning } from "../src/dsl/render";

const SID = sessionIdOf("stale-1");

// The settings under test, in the order the cell draws them.
const SHOWN = ["theme", "style", "effect", "preset", "endcaps", "padding"];
const FALLBACK = ["nord", "vivid", "none", "default", "plain", "3"];

const STYLES = "vivid: { chromaScale: 1.2 }";
const PRESETS = "wide: { globals: {} }";

const source = ({
  styles = STYLES,
  presets = PRESETS,
  extra = "",
} = {}): string => `{
  globals: { palette: "nord", style: "vivid", padding: 3, endcaps: "plain" },
  styles: { ${styles} },
  presets: { ${presets} },
  actions: { padUp: { set: "padding", min: 0, max: 16, by: 1 } },
  segments: {
    shows: { template: '${SHOWN.map((s) => `{{ .${s}.effective }}`).join("|")}' },
    pad: { template: '{{ action "padUp" "+" }}' },
  },
  root: { v: [{ h: ["shows", "pad"] }] },
  ${extra}
}`;

function rigOver(src: string, picks: Readonly<Record<string, string>>): Rig {
  const rig = buildRig({ source: src, sessionId: SID });
  for (const [key, value] of Object.entries(picks)) {
    rig.sessionState.set(SID, key, value);
  }
  return rig;
}

// A draw as the daemon makes one: the session's picks resolved once, and the
// payload's `.effective` fields and the strip's options both read from that.
function drawOf(rig: Rig): DrawnFrame {
  const effective = globalsFor(rig.config, (key) =>
    rig.sessionState.get(SID, key),
  );
  return rig.draw({
    payload: { session_id: SID, ...effectiveInputs(effective) },
    opts: renderOptionsOf(effective, 400),
    selection: effective,
  });
}

const staleOf = (warnings: readonly RenderWarning[]) =>
  warnings.filter((w) => w.kind === "stale");

// What the `shows` cell drew, setting by setting.
const shown = (drawn: DrawnFrame): readonly string[] =>
  /[\w-]+\|[\w-]+\|[\w-]+\|[\w-]+\|[\w-]+\|\d+/
    .exec(textOf(drawn.frame))![0]
    .split("|");

const staleMessage = (setting: string, stored: string, wears: string) =>
  `the session's ${setting} rendered "${wears}": its stored "${stored}" is not one this build and config offer`;

describe("a stale session pick draws the fallback and says so", () => {
  test.each([
    ["theme", "dark"],
    ["theme", "no-such-theme"],
    ["style", "gone"],
    ["effect", "retired-loop"],
    ["preset", "removed"],
    ["endcaps", "wavy"],
    ["padding", "99"],
  ])("%s stored as %j", (setting, stored) => {
    const drawn = drawOf(rigOver(source(), { [setting]: stored }));
    expect(shown(drawn)).toEqual(FALLBACK);
    const wears = FALLBACK[SHOWN.indexOf(setting)]!;
    expect(staleOf(drawn.warnings)).toEqual([
      {
        kind: "stale",
        setting,
        stored,
        message: staleMessage(setting, stored, wears),
      },
    ]);
  });

  test("one warning per stale key, each naming its own", () => {
    const drawn = drawOf(
      rigOver(source(), { theme: "dark", padding: "99", style: "gone" }),
    );
    expect(
      staleOf(drawn.warnings)
        .map((w) => `${w.setting}=${w.stored}`)
        .sort(),
    ).toEqual(["padding=99", "style=gone", "theme=dark"]);
  });

  test("picks in their domains draw, with nothing to say", () => {
    const drawn = drawOf(
      rigOver(source(), { theme: "dracula", preset: "wide", padding: "5" }),
    );
    expect(shown(drawn)).toEqual([
      "dracula",
      "vivid",
      "none",
      "wide",
      "plain",
      "5",
    ]);
    expect(staleOf(drawn.warnings)).toEqual([]);
  });

  test("a staged edit-mode value outranking the stale pick hides it", () => {
    const drawn = drawOf(
      rigOver(
        source({
          styles: `${STYLES}, calm: { chromaScale: 0.5 }`,
          extra: `editGlobals: { style: "calm" },`,
        }),
        {
          style: "gone",
          [EDIT_MODE_KEY]: EDIT_MODE_ARRANGE,
          // The live view draws each placement as it renders, not its label.
          [EDIT_LIVE_KEY]: DISCLOSURE_OPEN,
        },
      ),
    );
    expect(shown(drawn)[1]).toBe("calm");
    expect(staleOf(drawn.warnings)).toEqual([]);
  });
});

describe("the stored value stays: a config declaring the member again draws it", () => {
  test("a style", () => {
    const picks = { style: "gone" };
    expect(staleOf(drawOf(rigOver(source(), picks)).warnings)).toHaveLength(1);
    const again = drawOf(
      rigOver(source({ styles: `${STYLES}, gone: { hueShift: 40 }` }), picks),
    );
    expect(shown(again)[1]).toBe("gone");
    expect(staleOf(again.warnings)).toEqual([]);
  });

  test("a preset", () => {
    const picks = { preset: "removed" };
    expect(staleOf(drawOf(rigOver(source(), picks)).warnings)).toHaveLength(1);
    const again = drawOf(
      rigOver(
        source({ presets: `${PRESETS}, removed: { globals: {} }` }),
        picks,
      ),
    );
    expect(shown(again)[3]).toBe("removed");
    expect(staleOf(again.warnings)).toEqual([]);
  });
});

describe("a placement's stale theme", () => {
  const SRC = `{
    segments: { shows: { template: 'cell' } },
    root: { v: [{ h: [{ seg: "shows", id: "here" }] }] },
  }`;
  const KEY = placementDraftKey("default", "here", "theme");

  test("draws the bar's theme and names the placement's setting", () => {
    const drawn = drawOf(rigOver(SRC, { [KEY]: "no-such-theme" }));
    expect(textOf(drawn.frame)).toContain("cell");
    expect(staleOf(drawn.warnings)).toEqual([
      {
        kind: "stale",
        setting: "here.theme",
        stored: "no-such-theme",
        message: staleMessage("here.theme", "no-such-theme", "bar"),
      },
    ]);
  });

  test("an installed theme draws, with nothing to say", () => {
    expect(
      staleOf(drawOf(rigOver(SRC, { [KEY]: "dracula" })).warnings),
    ).toEqual([]);
  });
});

describe("the stepper and the render agree on an out-of-range stored integer", () => {
  test("+ steps from what the bar wears", async () => {
    const rig = rigOver(source(), { padding: "99" });
    const before = drawOf(rig);
    expect(shown(before)[5]).toBe("3");
    const ups = linkUrls(before.frame).filter((u) =>
      effectsOf(u).some((e) => e.args[1] === "padding"),
    );
    expect(ups).toHaveLength(1);
    await rig.click(ups[0]!);
    expect(rig.sessionState.get(SID, "padding")).toBe("4");
    const after = drawOf(rig);
    expect(shown(after)[5]).toBe("4");
    expect(staleOf(after.warnings)).toEqual([]);
  });
});
