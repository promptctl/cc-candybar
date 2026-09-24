// brandon-theme-picker-bgw.fe0 — text keeps its contrast at 256 colours.
//
// [LAW:verifiable-goals] The floors (TEXT_MIN_CONTRAST, the quiet git floor)
// are chosen on truecolor values; the terminal draws what the 256 downgrade
// hands it. So every bundled theme's bar is rendered twice through `check`'s
// own pipeline — once truecolor, once at 256 — and each text character is
// measured on the colours the terminal will actually draw: 38;5;n decoded
// through the fixed xterm cube and grey ramp. A character may not land on
// ANSI 0–15 (its RGB is the terminal theme's, so no ratio exists) and may not
// read worse than it did in truecolor, up to the 4.5:1 AA floor.

import { listThemePalettes } from "@promptctl/rich-js";
import { prepareConfig, renderEffective } from "../src/check";
import { resolveEffectiveGlobals } from "../src/daemon/render-payload";
import type { ColorCompatibility } from "../src/themes/policy";

type Rgb = readonly [number, number, number];
type Drawn = Rgb | { readonly ansi: number };

const LEVELS = [0, 95, 135, 175, 215, 255];
const xterm = (n: number): Drawn => {
  if (n < 16) return { ansi: n };
  if (n >= 232) {
    const g = 8 + 10 * (n - 232);
    return [g, g, g];
  }
  const i = n - 16;
  return [LEVELS[Math.floor(i / 36)]!, LEVELS[Math.floor(i / 6) % 6]!, LEVELS[i % 6]!];
};

const luminance = ([r, g, b]: Rgb): number => {
  const ch = (v: number) => {
    const x = v / 255;
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
};
const ratio = (a: Rgb, b: Rgb): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};

// A solid joiner's fg is its neighbour's bg: a shape, not text.
const JOINERS = new Set(["", "", "", "", ">", "(", ")"]);

/** Every non-space, non-joiner character with the fg and bg it is drawn in. */
function drawnChars(rendered: string): { ch: string; fg?: Drawn; bg?: Drawn }[] {
  // eslint-disable-next-line no-control-regex
  const token = /\x1b\[([0-9;]*)m|\x1b\]8;[^\x1b]*\x1b\\/g;
  const out: { ch: string; fg?: Drawn; bg?: Drawn }[] = [];
  let fg: Drawn | undefined;
  let bg: Drawn | undefined;
  let pos = 0;
  const text = (t: string) => {
    for (const ch of t) if (ch.trim() !== "" && !JOINERS.has(ch)) out.push({ ch, fg, bg });
  };
  for (const m of rendered.matchAll(token)) {
    text(rendered.slice(pos, m.index));
    pos = m.index + m[0].length;
    if (m[1] === undefined) continue;
    const ps = m[1].split(";").map((p) => (p === "" ? 0 : Number(p)));
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i]!;
      if (p === 0) [fg, bg] = [undefined, undefined];
      else if (p === 39) fg = undefined;
      else if (p === 49) bg = undefined;
      else if ((p === 38 || p === 48) && ps[i + 1] === 2) {
        const c: Rgb = [ps[i + 2]!, ps[i + 3]!, ps[i + 4]!];
        if (p === 38) fg = c;
        else bg = c;
        i += 4;
      } else if ((p === 38 || p === 48) && ps[i + 1] === 5) {
        const c = xterm(ps[i + 2]!);
        if (p === 38) fg = c;
        else bg = c;
        i += 2;
      } else if ((p >= 30 && p <= 37) || (p >= 90 && p <= 97)) fg = { ansi: p };
      else if ((p >= 40 && p <= 47) || (p >= 100 && p <= 107)) bg = { ansi: p };
    }
  }
  text(rendered.slice(pos));
  return out;
}

const isRgb = (c: Drawn | undefined): c is Rgb => Array.isArray(c);

test("every bundled theme's text reads at 256 colours as it does in truecolor", async () => {
  const prepared = await prepareConfig(null, process.cwd(), []);
  try {
    const render = (theme: string, colorCompatibility: ColorCompatibility) =>
      drawnChars(
        renderEffective(
          prepared,
          {
            ...resolveEffectiveGlobals(
              prepared.config,
              (key) => (key === "theme" ? theme : null),
              () => false,
            ),
            colorCompatibility,
          },
          200,
        ).rendered,
      );
    const failures: string[] = [];
    let measured = 0;
    for (const theme of listThemePalettes()) {
      const truecolor = render(theme, "truecolor");
      const quantized = render(theme, "256");
      expect([theme, quantized.map((c) => c.ch).join("")]).toEqual([
        theme,
        truecolor.map((c) => c.ch).join(""),
      ]);
      truecolor.forEach(({ ch, fg, bg }, i) => {
        const q = quantized[i]!;
        if (!isRgb(fg) || !isRgb(bg)) return;
        measured++;
        if (!isRgb(q.fg) || !isRgb(q.bg)) {
          failures.push(`${theme} ${ch}: drawn in terminal-defined ANSI colours`);
          return;
        }
        const before = ratio(fg, bg);
        const after = ratio(q.fg, q.bg);
        if (after < Math.min(before, 4.5) - 0.01)
          failures.push(`${theme} ${ch}: ${before.toFixed(2)} -> ${after.toFixed(2)}`);
      });
    }
    // Non-vacuous: the whole bar, every theme.
    expect(measured).toBeGreaterThan(listThemePalettes().length * 50);
    expect(failures).toEqual([]);
  } finally {
    prepared.registry.dispose();
  }
});
