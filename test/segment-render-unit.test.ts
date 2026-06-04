// [LAW:verifiable-goals] 2de.10 acceptance, driven through the REAL spine
// (registerDslConfig + renderDsl) and the REAL loader (parseAndValidate) — the
// same path the daemon renders through, never a parallel rig.
//
// The unit of rendering is the SEGMENT (or inline leaf): one strip item. The
// powerline joiner caps BETWEEN units, never inside one, and a same-bg seam
// between two distinct units survives as a structural boundary. Both facts are
// observed here as powerline-glyph counts in the rendered output:
//
//   1. A unit with internal variation (multiple clickable regions) renders as
//      ONE strip item — no internal chevron, every clickable region preserved.
//   2. Two adjacent segments that resolve to the SAME bg still read as two
//      units — the structural chevron between them survives equal bg (it is no
//      longer suppressed by `bgcolor === bgcolor`).

import { PaletteResolver, getThemePalette } from "@promptctl/rich-js";
import { parseAndValidate } from "./helpers/parse-and-validate";
import { VariableStore } from "../src/var-system/store";
import { SourceRegistry } from "../src/var-system/sources";
import { registerDslConfig, renderDsl } from "../src/dsl/render";
import { SessionState } from "../src/daemon/session-state";
import { listResolvablePaletteNames } from "../src/themes/policy";

const ALLOWED = new Set(listResolvablePaletteNames());

// U+E0B0 — the powerline right-arrow the PowerlineJoiner paints between items.
const CHEVRON = "\uE0B0";

// Strip (not FlexStrip): an unbounded line, so the glyph count is exactly the
// joiner walk's output — no width-driven wrap to perturb it.
const OPTS = {
  style: "powerline" as const,
  colorCompatibility: "truecolor" as const,
  width: Number.POSITIVE_INFINITY,
};

function linkUrls(rendered: string): string[] {
  // matchAll owns its own iterator — no shared, stateful `lastIndex` across
  // calls. The `+` capture requires a non-empty URL, so OSC-8 closes (empty
  // URL) never match: every capture is a link OPEN.
  // eslint-disable-next-line no-control-regex
  return [...rendered.matchAll(/\x1b\]8;;([^\x1b]+)\x1b\\/g)].map((m) => m[1]!);
}

function chevronCount(rendered: string): number {
  return rendered.split(CHEVRON).length - 1;
}

function render(src: string, hookData: Record<string, unknown>): string {
  const config = parseAndValidate("<test>", src, ALLOWED);
  const sessionState = new SessionState();
  const store = new VariableStore();
  const registry = new SourceRegistry(store, "", undefined, sessionState);
  const compiled = registerDslConfig(config, registry, { store });
  const basePalette = new PaletteResolver(getThemePalette("textual-dark")!);
  return renderDsl(config, compiled, store, registry, hookData, basePalette, OPTS);
}

describe("segment is the rendering unit (2de.10)", () => {
  test("a unit with internal clickable regions renders as ONE strip item — no internal chevron", () => {
    // An inline leaf with three onClick cells. Pre-collapse each was its own
    // strip cell; now the leaf collapses to one item, so the only chevron in
    // the whole line is the single end-cap — never one between X/Y/Z.
    const src = `{
      globals: { palette: 'textual-dark' },
      variables: {
        'session.id': { kind: 'input', path: 'session_id', default: '' },
      },
      segments: { unused: { template: ' ', bg: 'surface', fg: 'foreground' } },
      root: {
        kind: 'inline',
        bg: 'surface',
        fg: 'foreground',
        cells: [
          { text: 'X', onClick: { set: 'k', to: '1' } },
          { text: 'Y', onClick: { set: 'k', to: '2' } },
          { text: 'Z', onClick: { set: 'k', to: '3' } },
        ],
      },
    }`;
    const out = render(src, { session_id: "s1" });

    // One unit ⇒ one item ⇒ only the end-cap chevron, none between the cells.
    expect(chevronCount(out)).toBe(1);
    // All three clickable regions survive as their own OSC-8 spans inside the
    // single cell.
    expect(linkUrls(out)).toHaveLength(3);
  });

  test("a unit that renders nothing contributes no strip item — no spurious cap", () => {
    // An inline leaf whose only cell renders empty text: fragmentsToCells drops
    // the empty cell, so the leaf collapses to zero cells (not one empty cell).
    // An empty strip item would draw powerline caps around nothing; the unit
    // must instead contribute no item at all — zero glyphs in the output.
    const src = `{
      globals: { palette: 'textual-dark' },
      variables: {
        'session.id': { kind: 'input', path: 'session_id', default: '' },
      },
      segments: { unused: { template: ' ', bg: 'surface', fg: 'foreground' } },
      root: {
        kind: 'inline',
        bg: 'surface',
        fg: 'foreground',
        cells: [{ text: '' }],
      },
    }`;
    const out = render(src, { session_id: "s1" });

    expect(chevronCount(out)).toBe(0);
    expect(out).toBe("");
  });

  test("two adjacent same-bg segments read as TWO units — the structural chevron survives equal bg", () => {
    // hue.step = 0 freezes the per-segment hue rotation, so `a` and `b` — same
    // bg spec, same palette — resolve to the SAME background. The mid-join
    // between them must still be painted (it would be invisible, equal fg/bg,
    // but it is a real cell): the boundary is structural, not bg-decided.
    const src = `{
      globals: { palette: 'textual-dark' },
      variables: {
        'session.id': { kind: 'input', path: 'session_id', default: '' },
        'hue.step': { kind: 'literal', value: 0 },
      },
      segments: {
        a: { template: 'AAA', bg: 'surface', fg: 'foreground' },
        b: { template: 'BBB', bg: 'surface', fg: 'foreground' },
      },
      layout: [['a', 'b']],
    }`;
    const out = render(src, { session_id: "s1" });

    // Two items ⇒ one mid-join + one end-cap = two chevrons. Pre-fix the equal
    // bg suppressed the mid-join, collapsing the count to one.
    expect(chevronCount(out)).toBe(2);
    expect(out).toContain("AAA");
    expect(out).toContain("BBB");
  });
});
