// The statusline's click mode: a session value that picks which of a region's
// bindings its link carries, on a surface whose links deliver only the plain
// click. Driven through the real loader and draw, so what a click does is read
// from the link the frame drew.

import { drawPayload } from "../scripts/lib/draw-fixtures/draw-payload";
import { parseAndValidate } from "../scripts/lib/draw-fixtures/parse-and-validate";
import { VariableStore } from "../src/var-system/store";
import { SourceRegistry } from "../src/var-system/sources";
import { registerDslConfig } from "../src/dsl/render";
import { SessionState } from "../src/renderer/session-state";
import { listResolvablePaletteNames } from "../src/themes/policy";
import { DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import { recordRender } from "./helpers/click";
import { effectsOf } from "../src/click/read";
import { instantOf } from "../src/utils/instant";
import { systemTimekeeper } from "../scripts/lib/system-clock";
import { sessionIdOf } from "../src/daemon/foundations/session-id";
import { hrefOfDrawnLink } from "../src/render/drawn-link";
import type { Run } from "../src/render/frame";
import { SETTINGS_ANCHOR } from "../src/config/door";
import {
  CLICK_MODE_KEY,
  CLICK_MODES,
  HOVER_KEY,
  modeInForce,
  NO_HOVER,
} from "../src/config/click-mode";
import { hoverOf, surfaceOf } from "../src/render/pointer-facts";
import { inClickMode } from "../src/render/click-mode-frame";
import { buildRig } from "./helpers/rig";
import { clickUrl, writesOf } from "./helpers/click";
import { linkUrls } from "./helpers/frame";

const S1 = sessionIdOf("s1");
const ALLOWED = new Set(listResolvablePaletteNames());
const OPTS = {
  endcaps: "powerline" as const,
  colorCompatibility: "truecolor" as const,
  wrap: true,
  padding: 0,
  width: Number.POSITIVE_INFINITY,
};
const TOGGLE = `${CLICK_MODE_KEY}.toggle`;
const PAYLOAD = { session_id: "s1", workspace: { current_dir: "/tmp/proj" } };

const CONFIG = `{
  variables: {
    panel: { kind: 'state', key: 'panel', default: 'open' },
    focus: { kind: 'state', key: 'focus', default: 'off' },
  },
  actions: {
    open: { set: 'panel', to: 'open', on: { 'alt+left': 'close', hover: 'blur' } },
    close: { set: 'panel', to: 'closed' },
    blur: { set: 'focus', to: 'off' },
    plain: { set: 'focus', to: 'on' },
  },
  segments: {
    bar: { template: '{{ action "open" "OPEN" }} {{ action "plain" "PLAIN" }}', fg: 'foreground' },
  },
  root: 'bar',
}`;

interface Held {
  readonly mode?: string;
  readonly hover?: string;
}

// The runs a draw produces with the session holding `held` and the surface
// delivering `surface`.
function draw(held: Held, surface = "left"): readonly Run[] {
  const cfg = parseAndValidate("<user>", CONFIG, ALLOWED, DEFAULT_DSL_CONFIG);
  const sessionState = new SessionState();
  const store = new VariableStore(systemTimekeeper);
  const registry = new SourceRegistry(store, "", sessionState);
  const compiled = registerDslConfig(cfg, registry, { cwd: "/tmp/proj" });
  recordRender(sessionState, S1);
  if (held.mode !== undefined) sessionState.set(S1, CLICK_MODE_KEY, held.mode);
  if (held.hover !== undefined) sessionState.set(S1, HOVER_KEY, held.hover);
  const { frame } = drawPayload(
    cfg,
    compiled,
    store,
    registry,
    {
      session_id: "s1",
      workspace: { current_dir: "/tmp/proj" },
      surface,
    },
    instantOf(new Date()),
    OPTS,
  );
  // The draw's own step, as draw-bar takes it, over the same two facts.
  return inClickMode(
    frame,
    modeInForce(held.mode, surface.split(" ")),
  ).rows.flatMap((row) => row.runs);
}

// What a click on the region named `name` runs, or "no link" for a region the
// draw gave none.
function clicked(runs: readonly Run[], name: string) {
  const link = runs.find(
    (run) =>
      typeof run.link !== "string" &&
      run.link?.kind === "action" &&
      run.link.region?.name === name,
  )?.link;
  return link === undefined || typeof link === "string"
    ? "no link"
    : effectsOf(hrefOfDrawnLink(link));
}

const set = (key: string, value: string) => [
  { verb: "set-state", args: ["s1", key, value] },
];

describe("the click mode on a surface that delivers only the plain click", () => {
  test("click mode draws each region's own effects", () => {
    const runs = draw({});
    expect(clicked(runs, "open")).toEqual(set("panel", "open"));
    expect(clicked(runs, "plain")).toEqual(set("focus", "on"));
  });

  test("alt+click mode draws a region's alt+click binding, and no link for a region with none", () => {
    const runs = draw({ mode: "alt" });
    expect(clicked(runs, "open")).toEqual(set("panel", "closed"));
    expect(clicked(runs, "plain")).toBe("no link");
  });

  test("hover mode draws a region's hover binding, and for a region with none the write that hovers it", () => {
    const runs = draw({ mode: "hover" });
    expect(clicked(runs, "open")).toEqual(set("focus", "off"));
    expect(clicked(runs, "plain")).toEqual(set(HOVER_KEY, "plain"));
  });

  test("a surface that delivers the mode's gesture draws as in click mode", () => {
    const runs = draw({ mode: "alt" }, "left alt+left hover");
    expect(clicked(runs, "open")).toEqual(set("panel", "open"));
    expect(clicked(runs, "plain")).toEqual(set("focus", "on"));
  });

  test("the toggle, the door and the diagnostics' own bindings keep them live in every mode", () => {
    for (const mode of ["click", "hover", "alt"]) {
      const runs = draw({ mode });
      expect(clicked(runs, TOGGLE)).not.toBe("no link");
      expect(clicked(runs, SETTINGS_ANCHOR)).not.toBe("no link");
    }
  });

  // The toggle's link carries its step, never the mode it lands on, so it is
  // the same in every mode; the click steps from the mode in force.
  test("the toggle steps the mode and puts the hovered region away", () => {
    const step = [
      { verb: "cycle-state", args: ["s1", CLICK_MODE_KEY, ...CLICK_MODES] },
      ...set(HOVER_KEY, "candybar.none"),
    ];
    expect(clicked(draw({ mode: "hover", hover: "plain" }), TOGGLE)).toEqual(
      step,
    );
    expect(clicked(draw({}), TOGGLE)).toEqual(step);
  });

  test("the toggle is drawn where the surface lacks a mode's gesture, and not where it delivers both", () => {
    expect(clicked(draw({}), TOGGLE)).not.toBe("no link");
    expect(clicked(draw({}, "left alt+left hover"), TOGGLE)).toBe("no link");
    expect(clicked(draw({}, "left hover"), TOGGLE)).not.toBe("no link");
  });
});

// What the clicks the draw makes land as: the gate the config derives admits a
// click's writes to the hover key, whichever region it names.
describe("a click in hover mode", () => {
  test("makes its region the hovered one, and the toggle puts it away", async () => {
    const rig = buildRig({
      source: CONFIG,
      label: "<user>",
      base: DEFAULT_DSL_CONFIG,
      palettes: ALLOWED,
      sessionId: S1,
    });
    const drawn = () =>
      linkUrls(
        inClickMode(
          rig.draw({ payload: PAYLOAD, at: instantOf(new Date()) }).frame,
          modeInForce(rig.sessionState.get(S1, CLICK_MODE_KEY), ["left"]),
        ),
      );
    const clickWriting = async (key: string, value: string): Promise<void> => {
      const url = drawn().find((u) =>
        writesOf(u, rig.config, (k) => rig.sessionState.get(S1, k)).some(
          (w) => w.key === key && w.value === value,
        ),
      );
      if (!url) throw new Error(`no affordance writing ${key}=${value}`);
      await clickUrl(url, rig.ctx);
    };
    await clickWriting(CLICK_MODE_KEY, "hover");
    await clickWriting(HOVER_KEY, "plain");
    expect(rig.sessionState.get(S1, HOVER_KEY)).toBe("plain");
    await clickWriting(CLICK_MODE_KEY, "alt");
    expect(rig.sessionState.get(S1, HOVER_KEY)).toBe(NO_HOVER);
  });
});

describe("the hovered region a draw reads", () => {
  // The hover a draw reads, over the mode it is in, as draw-bar derives it.
  const hovered = (
    pointer: Parameters<typeof hoverOf>[0],
    mode: string | null,
    held: string | null,
  ) => hoverOf(pointer, modeInForce(mode, surfaceOf(pointer)), held);
  const pane = { gestures: ["left", "hover"], hover: "open" };

  test("is the pane's where the pane sees the pointer move", () => {
    expect(hovered(pane, "hover", "plain")).toBe("open");
  });

  test("is the region a click last hovered, in hover mode on a surface that cannot see the pointer", () => {
    expect(hovered(null, "hover", "plain")).toBe("plain");
    expect(hovered({ gestures: ["left"], hover: null }, "hover", "plain")).toBe(
      "plain",
    );
  });

  test("is none outside hover mode, and after the toggle put it away", () => {
    expect(hovered(null, "click", "plain")).toBe("");
    expect(hovered(null, "alt", "plain")).toBe("");
    expect(hovered(null, "hover", NO_HOVER)).toBe("");
    expect(hovered(null, null, null)).toBe("");
  });
});
