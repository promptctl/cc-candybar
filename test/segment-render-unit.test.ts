// [LAW:verifiable-goals] 2de.10 acceptance, driven through the REAL spine
// (registerDslConfig + renderDsl) and the REAL loader (parseAndValidate) — the
// same path the daemon renders through, never a parallel rig.
//
// The unit of rendering is the SEGMENT: one strip item. The
// powerline joiner caps BETWEEN units, never inside one, and a same-bg seam
// between two distinct units survives as a structural boundary. Both facts are
// observed here as powerline-glyph counts in the rendered output:
//
//   1. A unit with internal variation (multiple clickable regions) renders as
//      ONE strip item — no internal chevron, every clickable region preserved.
//   2. Two adjacent segments that resolve to the SAME bg still read as two
//      units — the structural chevron between them survives equal bg (it is no
//      longer suppressed by `bgcolor === bgcolor`).

import { TEST_SIGNER } from "./helpers/link-signer";
import { parseAndValidate } from "./helpers/parse-and-validate";
import { VariableStore } from "../src/var-system/store";
import { SourceRegistry } from "../src/var-system/sources";
import { registerDslConfig, renderDsl } from "../src/dsl/render";
import { SessionState } from "../src/daemon/session-state";
import { listResolvablePaletteNames } from "../src/themes/policy";
import { linkUrls, stripAnsi } from "./helpers/ansi";
import { SETTINGS_ANCHOR } from "../src/config/settings-menu";
import { POWERLINE } from "./helpers/powerline";
import { instantOf } from "../src/utils/instant";

const ALLOWED = new Set(listResolvablePaletteNames());

// The powerline arrow, drawn at the lead, between items and at the tail, and
// the divider drawn where two items share a ground.
const CHEVRON = POWERLINE.glyph;
const DIVIDER = POWERLINE.divider;

// Strip (not FlexStrip): an unbounded line, so the glyph count is exactly the
// joiner walk's output — no width-driven wrap to perturb it.
const OPTS = {
  endcaps: "powerline" as const,
  colorCompatibility: "truecolor" as const, wrap: true, padding: 0,
  width: Number.POSITIVE_INFINITY,
};


function chevronCount(rendered: string): number {
  return rendered.split(CHEVRON).length - 1;
}

function render(src: string, hookData: Record<string, unknown>): string {
  const config = parseAndValidate("<test>", src, ALLOWED);
  const sessionState = new SessionState();
  const store = new VariableStore();
  const registry = new SourceRegistry(store, "", sessionState);
  const compiled = registerDslConfig(config, registry, { signer: TEST_SIGNER, cwd: process.cwd() });
  return renderDsl(config, compiled, store, registry, hookData, instantOf(new Date()), OPTS);
}

describe("segment is the rendering unit (2de.10)", () => {
  test("a unit with internal clickable regions renders as ONE strip item — no internal chevron", () => {
    // A segment whose template emits three OSC-8 links. The segment collapses to
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
    const line = render(src, {}).split("\n")[1]!;

    // One unit ⇒ one item ⇒ only the lead and tail chevrons, none between the
    // regions.
    expect(chevronCount(line)).toBe(2);
    // All three clickable regions survive as their own OSC-8 spans inside the
    // single item.
    expect(linkUrls(line)).toHaveLength(3);
  });

  test("a segment that renders nothing contributes no strip item — no spurious cap", () => {
    // A visible segment whose template evaluates to empty: fragmentsToCells drops
    // the empty content, so the segment collapses to zero cells (not one empty
    // cell). An empty strip item would draw powerline caps around nothing; the
    // unit must instead contribute no item at all — the bar renders exactly as
    // it does without the segment (the settings door, present in every bar, is
    // all either renders).
    const bar = (root: string): string =>
      render(
        `{
          globals: { palette: 'textual-dark' },
          segments: { empty: { template: '', bg: 'surface', fg: 'foreground' } },
          root: ${root},
        }`,
        {},
      );

    expect(bar(`{ h: ['${SETTINGS_ANCHOR}', 'empty'] }`)).toBe(
      bar(`{ h: ['${SETTINGS_ANCHOR}'] }`),
    );
  });

  test("two adjacent same-bg segments read as TWO units — the structural chevron survives equal bg", () => {
    // `a` and `b` author the same bg spec against the same palette, so they
    // resolve to the SAME background. The mid-join between them must still be
    // painted: the boundary is structural, not bg-decided.
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

    // Two items ⇒ one mid-join + one end-cap. Pre-fix the equal bg suppressed
    // the mid-join. The a↔b join is now the DIVIDER — the arrow would be drawn
    // in the shared background and vanish (rich-js CellJoiner) — so the
    // arrows are the lead, the join to the global settings menu every bar
    // carries (candybar-settings-ui-aok.1) and the tail. The dividers are
    // a↔b and the one inside that menu's unit, between the door and the
    // frame rate beside it, which share its band.
    expect(chevronCount(out)).toBe(3);
    expect(out.split(DIVIDER).length - 1).toBe(2);
    expect(stripAnsi(out)).toMatch(new RegExp(`AAA\\s*${DIVIDER}\\s*BBB`));
    expect(out).toContain("AAA");
    expect(out).toContain("BBB");
  });
});
