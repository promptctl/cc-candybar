// [LAW:verifiable-goals] Driven through the real spine and loader, never a parallel
// rig. The joiner caps BETWEEN segments, never inside one, and survives equal bg.

import { getThemePalette } from "@promptctl/rich-js";
import { parseAndValidate } from "./helpers/parse-and-validate";
import { VariableStore } from "../src/var-system/store";
import { SourceRegistry } from "../src/var-system/sources";
import { registerDslConfig, renderDsl } from "../src/dsl/render";
import { SessionState } from "../src/daemon/session-state";
import { listResolvablePaletteNames } from "../src/themes/policy";

const ALLOWED = new Set(listResolvablePaletteNames());

// U+E0B0 — the powerline right-arrow painted between items.
const CHEVRON = "\uE0B0";

// Unbounded width, so the glyph count is exactly the joiner walk's output.
const OPTS = {
  style: "powerline" as const,
  colorCompatibility: "truecolor" as const, wrap: true, padding: 0, charset: "unicode" as const,
  width: Number.POSITIVE_INFINITY,
};

function linkUrls(rendered: string): string[] {
  // The non-empty capture skips OSC-8 closes, so every match is a link OPEN.
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
  const compiled = registerDslConfig(config, registry);
  const basePalette = getThemePalette("textual-dark"!);
  return renderDsl(config, compiled, store, registry, hookData, basePalette, OPTS);
}

describe("segment is the rendering unit (2de.10)", () => {
  test("a unit with internal clickable regions renders as ONE strip item — no internal chevron", () => {
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

    expect(chevronCount(out)).toBe(1);
    expect(linkUrls(out)).toHaveLength(3);
  });

  test("a segment that renders nothing contributes no strip item — no spurious cap", () => {
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

    // The third chevron is the join to the global settings menu every bar carries.
    expect(chevronCount(out)).toBe(3);
    expect(out).toContain("AAA");
    expect(out).toContain("BBB");
  });
});
