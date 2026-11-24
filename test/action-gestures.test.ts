// A region binds an action to each gesture: an action's `on:` names the action
// each other gesture runs. Driven through the real loader and draw, so what a
// click delivers is read from the link the frame drew for that gesture.

import { drawPayload } from "../scripts/lib/draw-fixtures/draw-payload";
import { parseAndValidate } from "../scripts/lib/draw-fixtures/parse-and-validate";
import { VariableStore } from "../src/var-system/store";
import { SourceRegistry } from "../src/var-system/sources";
import { registerDslConfig } from "../src/dsl/render";
import { SessionState } from "../src/renderer/session-state";
import { listResolvablePaletteNames } from "../src/themes/policy";
import { ConfigError } from "../src/config/dsl-loader";
import { DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import { recordRender } from "./helpers/click";
import { effectsOf } from "../src/click/read";
import { instantOf } from "../src/utils/instant";
import { systemTimekeeper } from "../scripts/lib/system-clock";
import { sessionIdOf } from "../src/daemon/foundations/session-id";
import { hrefOfDrawnLink } from "../src/render/drawn-link";
import type { Run } from "../src/render/frame";

const S1 = sessionIdOf("s1");
const ALLOWED = new Set(listResolvablePaletteNames());
const OPTS = {
  endcaps: "powerline" as const,
  colorCompatibility: "truecolor" as const,
  wrap: true,
  padding: 0,
  width: Number.POSITIVE_INFINITY,
};
const PAYLOAD = { session_id: "s1", workspace: { current_dir: "/tmp/proj" } };

const config = (actions: string, template: string): string => `{
  variables: {
    panel: { kind: 'state', key: 'panel', default: 'open' },
    focus: { kind: 'state', key: 'focus', default: 'off' },
  },
  actions: { ${actions} },
  segments: { bar: { template: '${template}', fg: 'foreground' } },
  root: 'bar',
}`;

const load = (src: string) =>
  parseAndValidate("<user>", src, ALLOWED, DEFAULT_DSL_CONFIG);

function draw(src: string): readonly Run[] {
  const cfg = load(src);
  const sessionState = new SessionState();
  const store = new VariableStore(systemTimekeeper);
  const registry = new SourceRegistry(store, "", sessionState);
  const compiled = registerDslConfig(cfg, registry, { cwd: "/tmp/proj" });
  recordRender(sessionState, S1);
  const { frame } = drawPayload(
    cfg,
    compiled,
    store,
    registry,
    PAYLOAD,
    instantOf(new Date()),
    OPTS,
  );
  return frame.rows.flatMap((row) => row.runs);
}

const BOUND = `
  open: { set: 'panel', to: 'open', on: { right: 'close', 'shift+ctrl+middle': 'blur' } },
  close: { set: 'panel', to: 'closed' },
  blur: { set: 'focus', to: 'off' },`;

describe("an action's other gestures", () => {
  test("a region carries its action's name and the effects each gesture runs", () => {
    const runs = draw(config(BOUND, '{{ action "open" "go" }}'));
    const link = runs.find((run) => run.text.includes("go"))?.link;
    if (typeof link === "string" || link?.kind !== "action")
      throw new Error("the region draws no action link");
    expect(link.region?.name).toBe("open");
    // The plain click stays the action's own effects.
    expect(effectsOf(hrefOfDrawnLink(link))).toEqual([
      { verb: "set-state", args: ["s1", "panel", "open"] },
    ]);
    expect(Object.keys(link.region?.gestures ?? {}).sort()).toEqual([
      "ctrl+shift+middle",
      "right",
    ]);
    expect(link.region?.gestures.right).toEqual([
      { verb: "set-state", args: ["s1", "panel", "closed"] },
    ]);
  });

  test("an action with no gestures draws a region of its own and no others", () => {
    const runs = draw(config(BOUND, '{{ action "close" "x" }}'));
    const link = runs.find((run) => run.text.includes("x"))?.link;
    if (typeof link === "string" || link?.kind !== "action")
      throw new Error("the region draws no action link");
    // Its hover binding is the write that makes it the hovered region.
    expect(link.region).toEqual({
      name: "close",
      gestures: {},
      hover: [{ verb: "set-state", args: ["s1", "candybar.hover", "close"] }],
    });
  });

  test.each([
    [
      "a gesture that is not one",
      "open: { set: 'panel', to: 'open', on: { hold: 'close' } }, close: { set: 'panel', to: 'closed' },",
      "ends in a button",
    ],
    [
      "the plain click",
      "open: { set: 'panel', to: 'open', on: { left: 'close' } }, close: { set: 'panel', to: 'closed' },",
      "is the plain click",
    ],
    [
      "one gesture spelled two ways",
      "open: { set: 'panel', to: 'open', on: { 'ctrl+alt+left': 'close', 'alt+ctrl+left': 'close' } }, close: { set: 'panel', to: 'closed' },",
      "bound twice",
    ],
    [
      "an action that is not declared",
      "open: { set: 'panel', to: 'open', on: { right: 'nowhere' } },",
      'unknown action "nowhere"',
    ],
    [
      "a target that takes its value from the template",
      "open: { set: 'panel', to: 'open', on: { right: 'pick' } }, pick: { set: 'panel', from: 'themes' },",
      "takes its value from the template",
    ],
  ])("refuses %s, saying why", (_label, actions, why) => {
    expect(() => load(config(actions, '{{ action "open" "go" }}'))).toThrow(
      ConfigError,
    );
    expect(() => load(config(actions, '{{ action "open" "go" }}'))).toThrow(
      why,
    );
  });
});
