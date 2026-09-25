// brandon-theme-picker-bgw.fe0 — text keeps its contrast at 256 colours.
// brandon-theme-picker-bgw.ddk — so does every seam, and at ansi nothing is
// drawn on its own ground's index.
//
// [LAW:verifiable-goals] The floors (TEXT_MIN_CONTRAST, the quiet git floor)
// are chosen on truecolor values; the terminal draws what the 256 downgrade
// hands it. So every bundled theme's bar is rendered twice through `check`'s
// own pipeline — once truecolor, once at 256 — and each text character is
// measured on the colours the terminal will actually draw: 38;5;n decoded
// through the fixed xterm cube and grey ramp. A character may not land on
// ANSI 0–15 (its RGB is the terminal theme's, so no ratio exists), must keep
// the highest floor it cleared in truecolor, and an arrow must stay the
// colour of the cell it continues and stand visibly off the cell it enters.
// At ansi no ratio exists, and the one floor that does is measured instead:
// nothing is drawn on its own ground's index.

import {
  listThemePalettes,
  Oklch,
  ColorRgba,
  SEAM_MIN_DELTA_E,
} from "@promptctl/rich-js";
import { prepareConfig, renderEffective } from "../src/check";
import { resolveEffectiveGlobals } from "../src/daemon/render-payload";
import {
  listResolvablePaletteNames,
  type ColorCompatibility,
} from "../src/themes/policy";
import { TEXT_MIN_CONTRAST } from "../src/themes/decor";
import {
  DEFAULT_DSL_CONFIG,
  GIT_QUIET_MIN_CONTRAST,
} from "../src/config/default-dsl-config";
import { SETTINGS_ANCHOR } from "../src/config/settings-menu";
import { DISCLOSURE_CLOSED } from "../src/config/disclosure";
import { VERB_SET_STATE } from "../src/click/wire";
import { SessionState } from "../src/daemon/session-state";
import { VariableStore } from "../src/var-system/store";
import { SourceRegistry } from "../src/var-system/sources";
import { registerDslConfig, renderDsl } from "../src/dsl/render";
import {
  deriveActionValidators,
  registerStateValidator,
} from "../src/daemon/verbs/state-validators";
import { parseAndValidate } from "./helpers/parse-and-validate";
import { clickUrl, effectsOf, testVerbContext } from "./helpers/click";
import { INVISIBLE, linkUrls } from "./helpers/ansi";

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
const deltaE = (a: Rgb, b: Rgb): number =>
  Oklch.fromRgba(new ColorRgba(...a)).deltaE(Oklch.fromRgba(new ColorRgba(...b)));

// The unicode charset's joiners — every render here uses it, so the ascii
// glyphs (`>`, `(`, `)`) are text and are measured like any other. The thin
// dividers (U+E0B1, U+E0B3) are not joiners here: rich-js draws a divider in
// the left cell's text colour on the left cell's own ground, so it IS that
// cell's text and is measured as text. Whether a seam is an arrow or a
// divider is decided on the drawn colours, so a seam is compared as one
// position, whichever glyph each depth drew there.
const ARROWS = new Set(["", ""]);
const JOINERS = new Set([...ARROWS, "", ""]);
const DIVIDERS: Readonly<Record<string, string>> = { "": "", "": "" };
const seamAsOne = (ch: string): string => DIVIDERS[ch] ?? ch;

/**
 * Every non-space character with the fg and bg it is drawn in. Solid joiners
 * are kept (`joiner: true`): their fg is a neighbour's bg, a shape to keep
 * seamless, not text to keep legible.
 */
function drawnChars(rendered: string): { ch: string; fg?: Drawn; bg?: Drawn; joiner: boolean }[] {
  const out: { ch: string; fg?: Drawn; bg?: Drawn; joiner: boolean }[] = [];
  let fg: Drawn | undefined;
  let bg: Drawn | undefined;
  let pos = 0;
  const text = (t: string) => {
    for (const ch of t) if (ch.trim() !== "") out.push({ ch, fg, bg, joiner: JOINERS.has(ch) });
  };
  // Every zero-width escape, read by the renderer's own pattern (rich-js's
  // OSC 8 grammar); only SGR carries colour.
  for (const m of rendered.matchAll(INVISIBLE)) {
    text(rendered.slice(pos, m.index));
    pos = m.index + m[0].length;
    const sgr = /^\x1b\[([0-9;]*)m$/.exec(m[0]);
    if (sgr === null) continue;
    const ps = sgr[1]!.split(";").map((p) => (p === "" ? 0 : Number(p)));
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
      } else if (p >= 30 && p <= 37) fg = { ansi: p - 30 };
      else if (p >= 90 && p <= 97) fg = { ansi: p - 90 + 8 };
      else if (p >= 40 && p <= 47) bg = { ansi: p - 40 };
      else if (p >= 100 && p <= 107) bg = { ansi: p - 100 + 8 };
    }
  }
  text(rendered.slice(pos));
  return out;
}

const isRgb = (c: Drawn | undefined): c is Rgb => Array.isArray(c);

// The floors the bar's text is chosen by, highest first: body text at AA, and
// the quiet git structure at 3:1. A character keeps the highest floor it
// cleared in truecolor, and a divider — its cell's text — is a character like
// any other. Where 256 draws a divider in a seam truecolor drew as an arrow,
// there was no truecolor text there to keep a floor from, so that divider is
// held to the lowest of them.
const FLOORS = [TEXT_MIN_CONTRAST, GIT_QUIET_MIN_CONTRAST];
const DIVIDER_FLOOR = Math.min(...FLOORS);

type Chars = ReturnType<typeof drawnChars>;

/**
 * Every way `quantized` (the 256 render) fails `truecolor` (the same bar, same
 * state): an arrow no longer continuing its cell or no longer standing off
 * the cell it enters, any divider under the lowest text floor, a character
 * drawn in ANSI 0–15, or a character below the highest floor it cleared in
 * truecolor. Returns how many characters were measured, so a caller can
 * refuse a vacuous pass.
 */
function compare(label: string, truecolor: Chars, quantized: Chars, failures: string[]): number {
  expect([label, quantized.map((c) => seamAsOne(c.ch)).join("")]).toEqual([
    label,
    truecolor.map((c) => seamAsOne(c.ch)).join(""),
  ]);
  quantized.forEach(({ ch, fg, bg, joiner }, i) => {
    // An arrow continues the cell before it: wherever truecolor draws it in
    // that cell's background, 256 does too, so the seam stays one shape.
    const left = quantized[i - 1];
    const continues = (c: Chars, k: number) =>
      JSON.stringify(c[k]!.fg) === JSON.stringify(c[k - 1]!.bg);
    if (joiner && left !== undefined && truecolor[i]!.joiner && continues(truecolor, i) && !continues(quantized, i))
      failures.push(`${label} ${ch}: arrow ${JSON.stringify(fg)} after a cell on ${JSON.stringify(left.bg)}`);
    // A seam glyph is measured on colours only while 256 draws them from its
    // own table: one in ANSI 0–15 is whatever the terminal's theme makes it.
    if ((ARROWS.has(ch) || ch in DIVIDERS) && fg !== undefined && bg !== undefined && (!isRgb(fg) || !isRgb(bg)))
      failures.push(`${label} ${ch}: seam drawn in terminal-defined ANSI colours`);
    // An arrow drawn in the colour of the cell it enters is no seam at all.
    if (ARROWS.has(ch) && isRgb(fg) && isRgb(bg) && deltaE(fg, bg) < SEAM_MIN_DELTA_E)
      failures.push(`${label} ${ch}: arrow ${JSON.stringify(fg)} vanishes into ${JSON.stringify(bg)}`);
    if (ch in DIVIDERS && isRgb(fg) && isRgb(bg) && ratio(fg, bg) < DIVIDER_FLOOR)
      failures.push(`${label} ${ch}: divider ${ratio(fg, bg).toFixed(2)} (floor ${DIVIDER_FLOOR})`);
  });
  let measured = 0;
  truecolor.forEach(({ ch, fg, bg, joiner }, i) => {
    const q = quantized[i]!;
    // A seam that is an arrow at either depth is a shape, held above.
    if (joiner || q.joiner || !isRgb(fg) || !isRgb(bg)) return;
    measured++;
    if (!isRgb(q.fg) || !isRgb(q.bg)) {
      failures.push(`${label} ${ch}: drawn in terminal-defined ANSI colours`);
      return;
    }
    const before = ratio(fg, bg);
    const after = ratio(q.fg, q.bg);
    const floor = FLOORS.find((f) => before >= f) ?? 0;
    if (after < floor)
      failures.push(`${label} ${ch}: ${before.toFixed(2)} -> ${after.toFixed(2)} (floor ${floor})`);
  });
  return measured;
}

/**
 * Every character at ansi drawn on its own ground's index: text, divider or
 * arrow, it is the ground's colour in every terminal theme. Returns how many
 * were measured.
 */
function sameIndex(label: string, ansi: Chars, failures: string[]): number {
  let measured = 0;
  for (const { ch, fg, bg } of ansi) {
    if (fg === undefined || bg === undefined) continue;
    measured++;
    // At ansi every colour is an index; an RGB one is a writer that ignored the depth.
    if (isRgb(fg) || isRgb(bg)) {
      failures.push(`${label} '${ch}': RGB drawn at ansi`);
      continue;
    }
    if (fg.ansi === bg.ansi) failures.push(`${label} '${ch}': index ${fg.ansi} on ${bg.ansi}`);
  }
  return measured;
}

// The closed bar, as `check` renders it, for a theme at a depth.
async function closedBars(): Promise<{
  render: (theme: string, colorCompatibility: ColorCompatibility) => Chars;
  dispose: () => void;
}> {
  const prepared = await prepareConfig(null, process.cwd(), []);
  return {
    render: (theme, colorCompatibility) =>
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
      ),
    dispose: () => prepared.registry.dispose(),
  };
}

// The open states, reached by the clicks a user makes: the 🍫 door (its tray
// and the preset picker's band items), ⚙ config (its controls), and the theme
// picker, whose options wear the palette each would apply. Each stage is
// handed a render of the bar in that state at any depth.
const STAGE_NAMES = ["closed", "door", "preset picker", "config", "theme picker"] as const;
function forEachStage(
  theme: string,
  measure: (stage: string, render: (colorCompatibility: ColorCompatibility) => Chars) => void,
): void {
  const OPTS = {
    style: "powerline" as const,
    wrap: true,
    padding: 1,
    charset: "unicode" as const,
    width: 200,
  };
  const PAYLOAD = {
    session_id: "s1",
    cwd: "/tmp/proj",
    workspace: { current_dir: "/tmp/proj", project_dir: "/tmp/proj", added_dirs: [] },
    model: { id: "claude-opus-4-7", display_name: "Opus" },
  };
  // Open the disclosure `key` names: the click on the bar that writes it a
  // member other than closed — loud when the bar renders none.
  const opener = (rendered: string, key: string, member: (v: string) => boolean): string => {
    const url = linkUrls(rendered).find((u) =>
      effectsOf(u).some(
        (e) =>
          e.verb === VERB_SET_STATE &&
          e.args[1] === key &&
          e.args[2] !== DISCLOSURE_CLOSED &&
          member(e.args[2] ?? ""),
      ),
    );
    if (url === undefined) throw new Error(`nothing on the bar opens ${key}`);
    return url;
  };
  const STAGES: Record<(typeof STAGE_NAMES)[number], (rendered: string) => string | null> = {
    closed: () => null,
    door: (r) => opener(r, SETTINGS_ANCHOR, () => true),
    "preset picker": (r) => opener(r, "menus.settings_pickers", (v) => v.endsWith("preset")),
    config: (r) => opener(r, "settings.config", () => true),
    "theme picker": (r) => opener(r, "menus.settings_pickers", (v) => v.endsWith("theme")),
  };
  const config = parseAndValidate(
    "<test>",
    `{ globals: { palette: '${theme}' } }`,
    new Set(listResolvablePaletteNames()),
    DEFAULT_DSL_CONFIG,
  );
  const sessionState = new SessionState();
  const store = new VariableStore();
  const registry = new SourceRegistry(store, "", undefined, sessionState);
  const disposers = deriveActionValidators(config).map(({ key, spec }) =>
    registerStateValidator(key, spec),
  );
  try {
    const compiled = registerDslConfig(config, registry, { cwd: "/tmp/proj" });
    const ctx = testVerbContext(sessionState);
    const render = (colorCompatibility: ColorCompatibility) =>
      renderDsl(config, compiled, store, registry, PAYLOAD, { ...OPTS, colorCompatibility });
    for (const stage of STAGE_NAMES) {
      const url = STAGES[stage](render("truecolor"));
      if (url !== null) clickUrl(url, ctx);
      measure(stage, (colorCompatibility) => drawnChars(render(colorCompatibility)));
    }
  } finally {
    disposers.forEach((d) => d());
    registry.dispose();
  }
}

test("every bundled theme's text reads at 256 colours as it does in truecolor", async () => {
  const bars = await closedBars();
  try {
    const failures: string[] = [];
    let measured = 0;
    for (const theme of listThemePalettes()) {
      measured += compare(theme, bars.render(theme, "truecolor"), bars.render(theme, "256"), failures);
    }
    // Non-vacuous: the whole bar, every theme.
    expect(measured).toBeGreaterThan(listThemePalettes().length * 50);
    expect(failures).toEqual([]);
  } finally {
    bars.dispose();
  }
});

// Every text colour chosen in an open state — a trigger's state cell, a band
// plane, a band item, an applied option — is floored at the drawn depth, so
// each stage is measured as the closed bar is.
test("every open settings band and picker reads at 256 colours as it does in truecolor", () => {
  const failures: string[] = [];
  let measured = 0;
  for (const theme of listThemePalettes()) {
    forEachStage(theme, (stage, render) => {
      measured += compare(`${theme} [${stage}]`, render("truecolor"), render("256"), failures);
    });
  }
  expect(measured).toBeGreaterThan(listThemePalettes().length * STAGE_NAMES.length * 50);
  expect(failures).toEqual([]);
});

test("at ansi nothing — text, divider or arrow — is drawn on its own ground's index", async () => {
  const bars = await closedBars();
  try {
    const failures: string[] = [];
    let measured = 0;
    for (const theme of listThemePalettes()) {
      measured += sameIndex(theme, bars.render(theme, "ansi"), failures);
      forEachStage(theme, (stage, render) => {
        measured += sameIndex(`${theme} [${stage}]`, render("ansi"), failures);
      });
    }
    expect(measured).toBeGreaterThan(listThemePalettes().length * (1 + STAGE_NAMES.length) * 50);
    expect(failures).toEqual([]);
  } finally {
    bars.dispose();
  }
});
