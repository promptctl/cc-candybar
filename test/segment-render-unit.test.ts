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

import { parseAndValidate } from "./helpers/parse-and-validate";
import { VariableStore } from "../src/var-system/store";
import { SourceRegistry } from "../src/var-system/sources";
import { registerDslConfig, renderDsl } from "../src/dsl/render";
import { SessionState } from "../src/daemon/session-state";
import { listResolvablePaletteNames } from "../src/themes/policy";
import { linkUrls, stripAnsi } from "./helpers/ansi";

const ALLOWED = new Set(listResolvablePaletteNames());

// U+E0B0 — the powerline right-arrow the PowerlineJoiner paints between items.
const CHEVRON = "\uE0B0";
const DIVIDER = "\uE0B1";

// Strip (not FlexStrip): an unbounded line, so the glyph count is exactly the
// joiner walk's output — no width-driven wrap to perturb it.
const OPTS = {
  style: "powerline" as const,
  colorCompatibility: "truecolor" as const, wrap: true, padding: 0, charset: "unicode" as const,
  width: Number.POSITIVE_INFINITY,
};


function chevronCount(rendered: string): number {
  return rendered.split(CHEVRON).length - 1;
}

function render(src: string, hookData: Record<string, unknown>): string {
  const config = parseAndValidate("<test>", src, ALLOWED);
  const sessionState = new SessionState();
  const store = new VariableStore();
  const registry = new SourceRegistry(store, "", undefined, sessionState);
  const compiled = registerDslConfig(config, registry);
  return renderDsl(config, compiled, store, registry, hookData, OPTS);
}

describe("segment is the rendering unit (2de.10)", () => {
  test("a unit with internal clickable regions renders as ONE strip item — no internal chevron", () => {
    // A segment whose template emits three OSC-8 links. The segment collapses to
    // one strip item, so the only chevron in the whole line is the single end-cap
    // — never one between X/Y/Z — while all three link spans survive inside it.
    const src = `{
      globals: { palette: 'textual-dark' },
      segments: {
        actions: {
          template: '{{ link "u1" "X" }}{{ link "u2" "Y" }}{{ link "u3" "Z" }}',
          bg: 'surface',
          fg: 'foreground',
        },
      },
      root: 'actions',
    }`;
    const out = render(src, {});

    // One unit ⇒ one item ⇒ only the end-cap chevron, none between the regions.
    expect(chevronCount(out)).toBe(1);
    // All three clickable regions survive as their own OSC-8 spans inside the
    // single item.
    expect(linkUrls(out)).toHaveLength(3);
  });

  test("a segment that renders nothing contributes no strip item — no spurious cap", () => {
    // A visible segment whose template evaluates to empty: fragmentsToCells drops
    // the empty content, so the segment collapses to zero cells (not one empty
    // cell). An empty strip item would draw powerline caps around nothing; the
    // unit must instead contribute no item at all — zero glyphs in the output.
    const src = `{
      globals: { palette: 'textual-dark' },
      segments: { empty: { template: '', bg: 'surface', fg: 'foreground' } },
      root: 'empty',
    }`;
    const out = render(src, {});

    expect(chevronCount(out)).toBe(0);
    expect(out).toBe("");
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
    // in the shared background and vanish (rich-js PowerlineJoiner) — so the
    // arrows are the end cap and the join to the global settings menu every
    // bar carries (candybar-settings-ui-aok.1), and a↔b is the one divider.
    expect(chevronCount(out)).toBe(2);
    expect(out.split(DIVIDER).length - 1).toBe(1);
    expect(stripAnsi(out)).toMatch(new RegExp(`AAA\\s*${DIVIDER}\\s*BBB`));
    expect(out).toContain("AAA");
    expect(out).toContain("BBB");
  });
});
