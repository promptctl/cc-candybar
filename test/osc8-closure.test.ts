// [LAW:verifiable-goals] The OSC-8 closure invariant, machine-checked through
// the REAL render spine (registerDslConfig + renderDsl + the real loader) — the
// same path the daemon renders through.
//
// THE INVARIANT (render-bugs-pdu.1): every clickable region is exactly one
// self-contained OSC-8 hyperlink — opened with `ESC]8;;URL ST` and closed with
// the empty `ESC]8;;ST` around its own text — so no text before or after a link
// is hyperlinked. An UNTERMINATED open is the "link bleed" defect: the terminal
// keeps every subsequent cell (inside AND outside the statusline) hyperlinked,
// because an SGR reset does NOT close a hyperlink — only the empty OSC-8 close
// does. [LAW:no-silent-failure] a malformed escape is a representation that lies
// to the terminal; this test makes that lie unrepresentable-by-test.
//
// [FRAMING:representation] The sibling test segment-render-unit.test.ts asserts
// link spans SURVIVE (counts opens); this asserts they are CLOSED (the open/
// close walk returns to "not linked" and never ends mid-link). Presence and
// closure are two different theorems — the bleed defect satisfied the first and
// broke the second, so closure needs its own guard.

import { getThemePalette } from "@promptctl/rich-js";
import { parseAndValidate } from "./helpers/parse-and-validate";
import { VariableStore } from "../src/var-system/store";
import { SourceRegistry } from "../src/var-system/sources";
import { registerDslConfig, renderDsl } from "../src/dsl/render";
import { SessionState } from "../src/daemon/session-state";
import { listResolvablePaletteNames } from "../src/themes/policy";
import type { BuildLineOptions } from "../src/render/strip";

const ALLOWED = new Set(listResolvablePaletteNames());

// OSC-8 grammar: open = ESC ] 8 ; <params> ; <URI> ST, close = ESC ] 8 ; ; ST.
// The close has an EMPTY URI; an open has a non-empty one. ST here is `ESC \`
// (the form rich-js emits). One regex matches both; the captured URI tells them
// apart — empty ⇒ close.
// eslint-disable-next-line no-control-regex
const OSC8 = /\x1b\]8;;([^\x1b]*)\x1b\\/g;

/**
 * Walk the rendered bytes in order, tracking the terminal's single OSC-8
 * "currently-linked" mode: an open (non-empty URI) sets it, a close (empty
 * URI) clears it. Returns the per-link tally plus whether the string ENDS while
 * still linked — the exact byte-level condition under which the link bleeds
 * onto everything the terminal prints after the statusline.
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

// A multi-link toolbar with PLAIN text trailing the final link — the shape that
// exposes a dropped close, since the trailing text would be swallowed into an
// unterminated hyperlink. Mixes the `{{ link }}` style fn (the config-author
// path) and a plain tail.
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
  // Across the widths that drive each serializer branch: unbounded (Strip) and
  // finite values that force FlexStrip's width-wrap — a wrap must re-close and
  // re-open a split link region, never leave a visual line ending mid-link.
  for (const width of [Number.POSITIVE_INFINITY, 80, 40, 20, 12]) {
    test(`every link is closed and output never ends mid-link (width=${width})`, () => {
      const out = render(TOOLBAR, {
        style: "powerline",
        colorCompatibility: "truecolor", wrap: true, padding: 0, charset: "unicode" as const,
        width,
      });
      const { opens, closes, endsLinked } = osc8Walk(out);
      // Three authored links → at least three open/close pairs (a width-wrap may
      // add more as it splits-and-re-wraps a region across visual lines).
      expect(opens).toBeGreaterThanOrEqual(3);
      // Every open is matched by a close — the balance invariant.
      expect(closes).toBe(opens);
      // The bleed condition: the bytes must not end while a hyperlink is open.
      expect(endsLinked).toBe(false);
      // And every individual visual line is independently balanced, so no single
      // wrapped row leaks its link onto the next.
      for (const line of out.split("\n")) {
        const w = osc8Walk(line);
        expect(w.closes).toBe(w.opens);
        expect(w.endsLinked).toBe(false);
      }
    });
  }

  test("adjacent links (close immediately followed by open) each terminate", () => {
    // No separator between regions: the close of one abuts the open of the next.
    // A dropped close here would fuse two clickable regions into one bleeding
    // span — the group-toggle row's exact shape.
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
