// [LAW:verifiable-goals] Every clickable region is one self-contained OSC-8 link;
// an SGR reset does NOT close one, so an open bleeds [LAW:no-silent-failure].

import { getThemePalette } from "@promptctl/rich-js";
import { parseAndValidate } from "./helpers/parse-and-validate";
import { VariableStore } from "../src/var-system/store";
import { SourceRegistry } from "../src/var-system/sources";
import { registerDslConfig, renderDsl } from "../src/dsl/render";
import { SessionState } from "../src/daemon/session-state";
import { listResolvablePaletteNames } from "../src/themes/policy";
import type { BuildLineOptions } from "../src/render/strip";

const ALLOWED = new Set(listResolvablePaletteNames());

// One regex matches open and close alike; an empty captured URI ⇒ close.
// eslint-disable-next-line no-control-regex
const OSC8 = /\x1b\]8;;([^\x1b]*)\x1b\\/g;

/**
 * Whether the string ENDS while still linked — the byte-level bleed condition.
 */
function osc8Walk(rendered: string): {
  opens: number;
  closes: number;
  endsLinked: boolean;
} {
  let opens = 0;
  let closes = 0;
  let linked = false;
  for (const m of rendered.matchAll(OSC8)) {
    if (m[1]!.length > 0) {
      opens += 1;
      linked = true;
    } else {
      closes += 1;
      linked = false;
    }
  }
  return { opens, closes, endsLinked: linked };
}

function render(src: string, opts: BuildLineOptions): string {
  const config = parseAndValidate("<test>", src, ALLOWED);
  const sessionState = new SessionState();
  const store = new VariableStore();
  const registry = new SourceRegistry(store, "", undefined, sessionState);
  const compiled = registerDslConfig(config, registry);
  const basePalette = getThemePalette("textual-dark"!);
  return renderDsl(config, compiled, store, registry, {}, basePalette, opts);
}

// PLAIN text trails the final link: a dropped close would swallow that tail.
const TOOLBAR = `{
  globals: { palette: 'textual-dark' },
  segments: {
    bar: {
      template: '{{ link "u1" "X" }} mid {{ link "u2" "Y" }} {{ link "u3" "Z" }} tail',
      bg: 'surface',
      fg: 'foreground',
    },
  },
  root: 'bar',
}`;

describe("OSC-8 closure (render-bugs-pdu.1)", () => {
  // A width-wrap must re-close and re-open a split region, never end mid-link.
  for (const width of [Number.POSITIVE_INFINITY, 80, 40, 20, 12]) {
    test(`every link is closed and output never ends mid-link (width=${width})`, () => {
      const out = render(TOOLBAR, {
        style: "powerline",
        colorCompatibility: "truecolor", wrap: true, padding: 0, charset: "unicode" as const,
        width,
      });
      const { opens, closes, endsLinked } = osc8Walk(out);
      expect(opens).toBeGreaterThanOrEqual(3);
      expect(closes).toBe(opens);
      expect(endsLinked).toBe(false);
      for (const line of out.split("\n")) {
        const w = osc8Walk(line);
        expect(w.closes).toBe(w.opens);
        expect(w.endsLinked).toBe(false);
      }
    });
  }

  test("adjacent links (close immediately followed by open) each terminate", () => {
    // No separator: a dropped close would fuse two regions into one bleeding span.
    const src = `{
      globals: { palette: 'textual-dark' },
      segments: {
        bar: { template: '{{ link "a" "AA" }}{{ link "b" "BB" }} after', bg: 'surface', fg: 'foreground' },
      },
      root: 'bar',
    }`;
    const out = render(src, {
      style: "powerline",
      colorCompatibility: "truecolor", wrap: true, padding: 0, charset: "unicode" as const,
      width: Number.POSITIVE_INFINITY,
    });
    const { opens, closes, endsLinked } = osc8Walk(out);
    expect(opens).toBe(2);
    expect(closes).toBe(2);
    expect(endsLinked).toBe(false);
  });
});
