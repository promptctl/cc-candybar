// [LAW:verifiable-goals] 2de.10 acceptance, driven through the REAL spine
// (registerDslConfig + drawDsl) and the REAL loader (parseAndValidate) — the
// same path the daemon renders through, never a parallel rig.
//
// The unit of rendering is the SEGMENT: one strip item. The
// powerline joiner caps BETWEEN units, never inside one, and two distinct
// units are always joined by a filled arrow. Both facts are
// observed here as powerline-glyph counts in the rendered output:
//
//   1. A unit with internal variation (multiple clickable regions) renders as
//      ONE strip item — no internal chevron, every clickable region preserved.
//   2. Two adjacent segments are always joined by a filled arrow, whatever
//      their grounds: no thin divider is drawn in its place.

import { drawPayload } from "./helpers/draw-payload";
import { textOf } from "../src/render/frame";
import type { Frame } from "../src/render/frame";
import { linkUrls } from "./helpers/frame";
import { processLauncher } from "../src/proc/launch";
import { TEST_SIGNER } from "./helpers/link-signer";
import { parseAndValidate } from "./helpers/parse-and-validate";
import { VariableStore } from "../src/var-system/store";
import { SourceRegistry } from "../src/var-system/sources";
import { registerDslConfig } from "../src/dsl/render";
import { SessionState } from "../src/daemon/session-state";
import { listResolvablePaletteNames } from "../src/themes/policy";
import { SETTINGS_ANCHOR } from "../src/config/settings-menu";
import { POWERLINE } from "./helpers/powerline";
import { instantOf } from "../src/utils/instant";

const ALLOWED = new Set(listResolvablePaletteNames());

// The powerline arrow, drawn at the lead, between items and at the tail, and
// U+E0B1, the thin divider, which no join draws.
const CHEVRON = POWERLINE.glyph;
const DIVIDER = "\u{E0B1}";

// Strip (not FlexStrip): an unbounded line, so the glyph count is exactly the
// joiner walk's output — no width-driven wrap to perturb it.
const OPTS = {
  endcaps: "powerline" as const,
  colorCompatibility: "truecolor" as const, wrap: true, padding: 0,
  width: Number.POSITIVE_INFINITY,
};


function chevronCount(rendered: Pick<Frame, "rows">): number {
  return textOf(rendered).split(CHEVRON).length - 1;
}

function render(src: string, hookData: Record<string, unknown>): Frame {
  const config = parseAndValidate("<test>", src, ALLOWED);
  const sessionState = new SessionState();
  const store = new VariableStore();
  const registry = new SourceRegistry(processLauncher, store, "", sessionState);
  const compiled = registerDslConfig(config, registry, { signer: TEST_SIGNER, cwd: process.cwd() });
  return drawPayload(config, compiled, store, registry, hookData, instantOf(new Date()), OPTS).frame;
}

describe("segment is the rendering unit (2de.10)", () => {
  test("a unit with internal clickable regions renders as ONE strip item — no internal chevron", () => {
    // A segment whose template draws three links. The segment collapses to
    // one strip item, so the only chevrons in its line are its lead and its
    // tail — never one between X/Y/Z — while all three link spans survive
    // inside it.
    // The settings door, present in every bar, is placed on its own row so the
    // unit's row holds the unit alone.
    const src = `{
      globals: { palette: 'textual-dark' },
      segments: {
        actions: {
          template: '{{ link "u1" "X" }}{{ link "u2" "Y" }}{{ link "u3" "Z" }}',
          bg: 'surface',
          fg: 'foreground',
        },
      },
      root: { v: ['${SETTINGS_ANCHOR}', 'actions'] },
    }`;
    const line = { rows: render(src, {}).rows.slice(1, 2) };

    // One unit ⇒ one item ⇒ only the lead and tail chevrons, none between the
    // regions.
    expect(chevronCount(line)).toBe(2);
    // All three clickable regions survive as their own links inside the single
    // item.
    expect(linkUrls(line)).toHaveLength(3);
  });

  test("a segment that renders nothing contributes no strip item — no spurious cap", () => {
    // A visible segment whose template evaluates to empty: fragmentsToCells drops
    // the empty content, so the segment collapses to zero cells (not one empty
    // cell). An empty strip item would draw powerline caps around nothing; the
    // unit must instead contribute no item at all — the bar renders exactly as
    // it does without the segment (the settings door, present in every bar, is
    // all either renders).
    const bar = (root: string): Frame =>
      render(
        `{
          globals: { palette: 'textual-dark' },
          segments: { empty: { template: '', bg: 'surface', fg: 'foreground' } },
          root: ${root},
        }`,
        {},
      );

    expect(bar(`{ h: ['${SETTINGS_ANCHOR}', 'empty'] }`).rows).toEqual(
      bar(`{ h: ['${SETTINGS_ANCHOR}'] }`).rows,
    );
  });

  test("two segments authoring one bg are joined by a filled arrow, and no divider is drawn anywhere", () => {
    // `a` and `b` author the same bg spec against the same palette, so they
    // share one ground. A join is an arrow whatever the two grounds are: on
    // one ground, the joiner lifts the arrow's ink off it.
    const src = `{
      globals: { palette: 'textual-dark' },
      variables: {
        'session.id': { kind: 'input', path: 'session_id', default: '' },
      },
      segments: {
        a: { template: 'AAA', bg: 'surface', fg: 'foreground' },
        b: { template: 'BBB', bg: 'surface', fg: 'foreground' },
      },
      root: { h: ['a', 'b'] },
    }`;
    const out = render(src, { session_id: "s1" });

    // The cells are the door, its frame rate, a and b: the lead, three joins
    // and the tail are all arrows.
    expect(textOf(out).split(DIVIDER).length - 1).toBe(0);
    expect(chevronCount(out)).toBe(5);
    expect(textOf(out)).toMatch(new RegExp(`AAA\\s*${CHEVRON}\\s*BBB`));
  });
});
