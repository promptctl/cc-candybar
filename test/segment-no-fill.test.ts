// A segment's `bg: "none"` is the one background that is no colour: the cell
// draws its text on the terminal's own ground. [LAW:behavior-not-structure]
// The contract, as the render walk delivers it:
//   - the cell's Style carries NO background, where an unauthored neighbour
//     wears its tint;
//   - `{{ bgOf }}` still answers — with the theme's background, the ground the
//     text lands on — so a contrast floor measures against something real;
//   - with no `fg:` the cell carries no text colour either: the terminal's own
//     text on its own ground, the one pair known to read there.

import { drawPayload } from "./helpers/draw-payload";
import { unscriptedRuns } from "./helpers/fake-launcher";
import { getThemePalette, resolveColorRef } from "@promptctl/rich-js";
import { parseAndValidate } from "./helpers/parse-and-validate";
import { VariableStore } from "../src/var-system/store";
import { SourceRegistry } from "../src/var-system/sources";
import { registerDslConfig } from "../src/dsl/render";
import { SessionState } from "../src/renderer/session-state";
import { resolvedStyle } from "../src/render/rich-theme.js";
import { NO_FILL } from "../src/template-engine/colors";
import { instantOf } from "../src/utils/instant";
import { systemTimekeeper } from "../src/time";

const THEME = "textual-dark";

const SRC = `{
  globals: { palette: '${THEME}' },
  segments: {
    filled: { template: 'F' },
    bare: { template: 'B', bg: '${NO_FILL}' },
    echo: { template: 'E', bg: '${NO_FILL}', fg: '{{ bgOf }}' },
  },
  root: { v: [{ h: ['filled', 'bare', 'echo'] }] },
}`;

function render() {
  const config = parseAndValidate(
    "<test>",
    SRC,
  );
  const store = new VariableStore(systemTimekeeper);
  const registry = new SourceRegistry(store, "", new SessionState());
  const compiled = registerDslConfig(config, registry, { cwd: process.cwd() });
  const drawn = drawPayload(
    config,
    compiled,
    store,
    registry,
    { session_id: "s1" },
    instantOf(new Date()),
    {
      endcaps: "powerline",
      colorCompatibility: "truecolor",
      wrap: true,
      padding: 0,
      width: Number.POSITIVE_INFINITY,
    },
    undefined,
  );
  const out = drawn.frame;
  const style = (name: string) => resolvedStyle(drawn.segments.get(name)![0]!.style);
  return { out, style, dispose: () => registry.dispose() };
}

describe(`bg: "${NO_FILL}"`, () => {
  const r = render();
  afterAll(() => r.dispose());

  test("draws the cell with no background while an unauthored neighbour keeps its tint", () => {
    expect(r.style("filled").bgcolor?.value?.hex).toMatch(/^#[0-9a-f]{6}$/i);
    expect(r.style("bare").bgcolor).toBeUndefined();
  });

  test("{{ bgOf }} reads the theme's background, the ground the text is drawn on", () => {
    const ground = resolveColorRef(getThemePalette(THEME), "background").hex;
    expect(r.style("echo").color?.value?.hex).toBe(ground);
  });

  test("a fill-less cell with no fg leaves the text colour to the terminal", () => {
    expect(r.style("bare").color).toBeUndefined();
    expect(r.style("filled").color?.value?.hex).toMatch(/^#[0-9a-f]{6}$/i);
  });
});
