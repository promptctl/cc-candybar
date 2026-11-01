// [LAW:verifiable-goals] candybar-isolated-daemon-bfab.abb moves the draw's
// output from bytes to a structured frame and must not move a byte. This file
// was committed FIRST, against the draw that still held bytes, so its snapshot
// is evidence rather than a description of the change: every terminal lane's
// output, at every colour depth, with menus closed and open, from the bundled
// default and from a config using the supported API's reach. A later commit may
// change how this file calls a lane; its snapshot does not move.
//
// [LAW:verifiable-goals] A snapshot pins only what it was drawn over, so the
// reach is asserted too: a config that stops drawing a blank row, a wrapped
// row, a ColorBlend, a moving effect or a fade fails here, not silently.

import { ColorDepth, Style, type ColorSpec } from "@promptctl/rich-js";
import { processLauncher } from "../src/proc/launch";
import { TEST_SIGNER } from "./helpers/link-signer";
import { selectionFor } from "./helpers/selection";
import { parseAndValidate } from "./helpers/parse-and-validate";
import { stripAnsi } from "./helpers/ansi";
import { VariableStore } from "../src/var-system/store";
import { SourceRegistry } from "../src/var-system/sources";
import { registerDslConfig, drawPayload } from "../src/dsl/render";
import { SessionState } from "../src/daemon/session-state";
import { LANE_FRAMES } from "../src/daemon/lane-frames";
import { ansiOf, renderFailedFrame, type Frame } from "../src/render/frame";
import {
  COLOR_COMPATIBILITIES,
  listResolvablePaletteNames,
  type ColorCompatibility,
} from "../src/themes/policy";
import { DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import { SETTINGS_ANCHOR, SETTINGS_OPEN } from "../src/config/door";
import { SessionEffects } from "../src/render/effect";
import type { RenderedLine } from "../src/dsl/node-registry";
import type { BuildLineOptions } from "../src/render/strip";
import type { Instant } from "../src/utils/instant";

const SID = "s1";
const START = 1_800_000_000;
const at = (seconds: number): Instant => (START + seconds) as Instant;

// Static effective values, so the bytes carry no environment in them.
const PAYLOAD = {
  hook_event_name: "Status",
  session_id: SID,
  cwd: "/tmp/proj",
  model: { id: "claude-opus-4-7", display_name: "Opus" },
  workspace: {
    current_dir: "/tmp/proj",
    project_dir: "/tmp/proj",
    added_dirs: [],
  },
};

// What a subscriber of each lane that draws runs receives for a bar, beside the
// bar's bytes. `json` is the response the daemon sends: a bar and its newline
// (`composeBar`).
function lanes(frame: Frame) {
  const ansi = ansiOf(frame);
  const json = JSON.stringify({ ok: true, output: `${ansi}\n` });
  return {
    ansi,
    band: LANE_FRAMES.band(frame, json),
    tmuxStatus: LANE_FRAMES.tmuxStatus(frame, json),
  };
}

// One load of `src`, drawn at `depth` through a held session effect memory, so
// motion advances from frame to frame. No step awaits, so no source a config
// declares can answer part-way through a run of frames.
function rig(
  src: string,
  opts: Omit<BuildLineOptions, "colorCompatibility">,
  depth: ColorCompatibility,
) {
  const config = parseAndValidate(
    "<user>",
    src,
    new Set(listResolvablePaletteNames()),
    DEFAULT_DSL_CONFIG,
  );
  const sessionState = new SessionState();
  const store = new VariableStore();
  const registry = new SourceRegistry(processLauncher, store, "", sessionState);
  const compiled = registerDslConfig(config, registry, {
    signer: TEST_SIGNER,
    cwd: "/tmp/proj",
  });
  const effects = new SessionEffects<RenderedLine>(SID);
  return {
    effects,
    draw: (seconds: number, payload: object = PAYLOAD): Frame =>
      drawPayload(
        config,
        compiled,
        store,
        registry,
        payload,
        at(seconds),
        { ...opts, colorCompatibility: depth },
        undefined,
        selectionFor(config, { effects }),
      ).frame,
    openMenus: () => sessionState.set(SID, SETTINGS_ANCHOR, SETTINGS_OPEN),
    dispose: () => registry.dispose(),
  };
}

// The supported API's reach. `{{ fg }}` and `{{ bg }}` over a standard name
// keep a colour only the terminal's theme knows, and with no padding that
// colour is a cell's edge, so the prism seams' mixes between two grounds stay
// ColorBlends instead of collapsing to RGB (a padded cell's edge is its
// segment's hex ground). `empty` is a row of no cells. `left` and `right`
// overflow WIDTH together, so FlexStrip wraps their one row. `fades` comes and
// goes with the payload, as `shown` says.
const LONG = "x".repeat(24);
const WIDTH = 40;
const REACH = `{
  globals: { effect: 'wheel', transitions: true },
  variables: {
    shown: { kind: 'input', path: 'shown', type: 'boolean', default: false },
  },
  segments: {
    top: { template: '{{ bg "red" (fg "bright_white" "TOP") }}' },
    empty: { template: '' },
    bot: { template: '{{ bg "green" (fg "black" (bold "BOT")) }}' },
    mate: { template: '{{ bg "blue" (fg "#f0d0a0" (italic "MATE")) }}' },
    left: { template: '{{ bg "magenta" (fg "white" "LEFT${LONG}") }}' },
    right: { template: '{{ bg "cyan" (fg "color(17)" "RIGHT${LONG}") }}' },
    fades: { template: '{{ bg "yellow" (fg "black" "FADES") }}', when: '{{ .shown }}' },
  },
  root: { v: ['top', 'empty', { h: ['bot', 'mate'] }, { h: ['left', 'right', 'fades'] }] },
}`;
const REACH_OPTS = {
  endcaps: "prism",
  wrap: true,
  padding: 0,
  width: WIDTH,
} as const;

// The frames of a run of REACH, each at seconds past the start, in order: the
// effect's calm first frame, then motion, `fades` appearing and leaving, and
// the door opening, a write to session state, which nothing fades across.
const REACH_FRAMES = [
  { seconds: 0, shown: false },
  { seconds: 5, shown: false },
  { seconds: 10, shown: false },
  { seconds: 15, shown: true },
  { seconds: 25, shown: true },
  { seconds: 40, shown: false },
  { seconds: 45, shown: false },
  { seconds: 50, shown: false, open: true },
  { seconds: 55, shown: false, open: true },
] as const;

// Every frame of a run of REACH, as drawn at `depth`.
function reachFrames(depth: ColorCompatibility) {
  const run = rig(REACH, REACH_OPTS, depth);
  const frames = REACH_FRAMES.map((frame) => {
    if ("open" in frame) run.openMenus();
    const drawn = run.draw(frame.seconds, { ...PAYLOAD, shown: frame.shown });
    return {
      ...frame,
      drawn,
      ansi: ansiOf(drawn),
      passing: run.effects.lastFrame(),
    };
  });
  run.dispose();
  return frames;
}

const DEPTHS = COLOR_COMPATIBILITIES;

describe("the reach of the config these bytes are drawn from", () => {
  test.each(DEPTHS)(
    "at %s it draws a blank row and a row FlexStrip wrapped",
    (depth) => {
      for (const { ansi } of reachFrames(depth)) {
        const lines = stripAnsi(ansi).split("\n");
        const top = lines.findIndex((line) => line.includes("TOP"));
        // The row of no cells is one empty line, between its neighbours.
        expect(lines[top + 1]).toBe("");
        expect(lines[top + 2]).toContain("BOT");
        // One authored row, drawn across two lines.
        const left = lines.findIndex((line) => line.includes("LEFT"));
        expect(left).toBeGreaterThan(top + 2);
        expect(lines[left]).not.toContain("RIGHT");
        expect(lines[left + 1]).toContain("RIGHT");
      }
    },
  );

  test("it draws ColorBlends: a mix with an end only the terminal's theme fixes", () => {
    const blend = (spec: ColorSpec | undefined): boolean =>
      spec?.type === ColorDepth.TRUECOLOR && spec.fixedValue === undefined;
    const drawnColors = jest.spyOn(Style.prototype, "drawnColors");
    try {
      reachFrames("truecolor");
      const drawn = drawnColors.mock.contexts as unknown as readonly Style[];
      expect(
        drawn.filter((style) => blend(style.color) || blend(style.bgcolor)),
      ).not.toEqual([]);
    } finally {
      drawnColors.mockRestore();
    }
  });

  test("its frames move, and a placement fades in and dissolves out", () => {
    const frames = reachFrames("truecolor");
    const ansis = frames.map(({ ansi }) => ansi);
    expect(new Set(ansis).size).toBe(ansis.length);
    const fading = frames.filter(({ passing }) => passing.fades.length > 0);
    const leaving = frames.filter(({ passing }) => passing.leaves.length > 0);
    expect(fading.map(({ seconds }) => seconds)).toEqual([15, 25]);
    expect(leaving.map(({ seconds }) => seconds)).toEqual([40, 45]);
  });
});

describe.each(DEPTHS)("the bytes of every lane at %s", (depth) => {
  test("the bundled default, menus closed and open", () => {
    const run = rig(
      "{ globals: {} }",
      { endcaps: "powerline", wrap: true, padding: 1, width: 120 },
      depth,
    );
    expect(lanes(run.draw(0))).toMatchSnapshot("closed");
    run.openMenus();
    expect(lanes(run.draw(0))).toMatchSnapshot("open");
    run.dispose();
  });

  test("the reach config, frame by frame", () => {
    for (const { seconds, drawn } of reachFrames(depth)) {
      expect(lanes(drawn)).toMatchSnapshot(`+${seconds}s`);
    }
  });
});

describe("a render that failed", () => {
  const error = "the draw threw";
  const bar = renderFailedFrame(error);
  const json = JSON.stringify({ ok: false, error, code: "RENDER_FAILED" });

  test("the band draws the statusline's error glyph", () => {
    expect(LANE_FRAMES.band(bar, json)).toMatchSnapshot();
  });

  test("the tmux status line draws it too", () => {
    expect(LANE_FRAMES.tmuxStatus(bar, json)).toMatchSnapshot();
  });
});
