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
// nothing is drawn on its own ground's index. At every depth an arrow's ink is
// the cell it leaves wherever that cell's ground stands off the next one's as
// drawn, and otherwise the colour rich-js's joiner lifts it to, with rich-js
// itself as the oracle.

import { TEST_SIGNER } from "./helpers/link-signer";
import {
  listThemePalettes,
  ColorRgba,
  JOINERS as RICH_JOINERS,
  RichText,
  SEAM_MIN_DELTA_E,
  Strip,
  Style,
  render as richRender,
  resolveDestination,
  segmentsToString,
} from "@promptctl/rich-js";
import { deltaE as deltaERgba } from "../src/themes/decor";
import { POWERLINE } from "./helpers/powerline";
import { NO_REPO, prepareConfig, renderEffective } from "../src/check";
import { resolveEffectiveGlobals } from "../src/config/effective-globals";
import {
  listResolvablePaletteNames,
  type ColorCompatibility,
} from "../src/themes/policy";
import { TEXT_MIN_CONTRAST } from "../src/themes/decor";
import { DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import { QUIET_MIN_CONTRAST } from "../src/config/quiet-text";
import { SETTINGS_ANCHOR } from "../src/config/settings-menu";
import { DISCLOSURE_CLOSED } from "../src/config/disclosure";
import { VERB_SET_STATE } from "../src/click/wire";
import { SessionState } from "../src/daemon/session-state";
import { VariableStore } from "../src/var-system/store";
import { SourceRegistry } from "../src/var-system/sources";
import { registerDslConfig, renderDsl } from "../src/dsl/render";
import { parseAndValidate } from "./helpers/parse-and-validate";
import {
  clickUrl,
  effectsOf,
  recordRender,
  testVerbContext,
} from "./helpers/click";
import { INVISIBLE, linkUrls } from "./helpers/ansi";
import { SWATCH_GLYPH } from "../src/render/swatch";
import { instantOf } from "../src/utils/instant";

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
const deltaE = (a: Rgb, b: Rgb): number => deltaERgba(new ColorRgba(...a), new ColorRgba(...b));

// The joiners' glyphs, and U+E0B1, the thin divider: no joiner draws it, so
// any divider on a row is a failure.
const { glyph, lead, tail } = POWERLINE;
const DIVIDER = "\u{E0B1}";
const ARROWS = new Set([glyph, lead, tail]);
const JOINERS = new Set([...ARROWS, "\uE0B4", "\uE0B6"]);

interface Char {
  readonly ch: string;
  readonly fg?: Drawn;
  readonly bg?: Drawn;
  readonly joiner: boolean;
  // Drawn in reverse video: a cap's notch, its ink the terminal's ground.
  readonly reverse: boolean;
  // The ground of the column drawn just before it on its line, spaces
  // included: for an arrow, the cell it leaves.
  readonly before?: Drawn;
}

/**
 * Every non-space character with the fg and bg it is drawn in. Solid joiners
 * are kept (`joiner: true`): their fg is a neighbour's bg, a shape to keep
 * seamless, not text to keep legible.
 */
function drawnChars(rendered: string): Char[] {
  const out: Char[] = [];
  let fg: Drawn | undefined;
  let bg: Drawn | undefined;
  let reverse = false;
  let before: Drawn | undefined;
  let pos = 0;
  const text = (t: string) => {
    for (const ch of t) {
      if (ch === "\n") {
        before = undefined;
        continue;
      }
      if (ch.trim() !== "") out.push({ ch, fg, bg, joiner: JOINERS.has(ch), reverse, before });
      before = reverse ? fg : bg;
    }
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
      if (p === 0) [fg, bg, reverse] = [undefined, undefined, false];
      else if (p === 7) reverse = true;
      else if (p === 27) reverse = false;
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
const same = (a: Drawn | undefined, b: Drawn | undefined): boolean => JSON.stringify(a) === JSON.stringify(b);
const hex = (c: Rgb): string => `#${c.map((v) => v.toString(16).padStart(2, "0")).join("")}`;

// Whether ink stands off its ground as a depth draws the two: by the seam
// floor between two fixed colours, by a different slot between two of the
// terminal's own, and always beside a colour nobody measures (the terminal's
// default, or a slot beside a fixed colour).
const standsOff = (ink: Drawn | undefined, ground: Drawn | undefined): boolean =>
  isRgb(ink) && isRgb(ground)
    ? deltaE(ink, ground) >= SEAM_MIN_DELTA_E
    : ink !== undefined && ground !== undefined && !isRgb(ink) && !isRgb(ground)
      ? ink.ansi !== ground.ansi
      : true;

// [LAW:verifiable-goals] The ink rich-js's own joiner draws an arrow in, at
// `depth`, between a cell on `left` and one on `right`, both as truecolor drew
// them: the oracle an arrow on the bar is held to, read back through the same
// decoding as the bar, so the function under test is not its own oracle.
const inks = new Map<string, Drawn | undefined>();
function joinerInk(left: Rgb, right: Rgb, depth: ColorCompatibility): Drawn | undefined {
  const key = JSON.stringify([left, right, depth]);
  if (inks.has(key)) return inks.get(key);
  const cell = (c: Rgb) => new RichText("x", { end: "", style: new Style({ bgcolor: hex(c) }) });
  const destination = resolveDestination(depth);
  const drawn = drawnChars(
    segmentsToString(
      [
        ...richRender(new Strip([cell(left), cell(right)], RICH_JOINERS.powerline), {
          maxWidth: 80,
          isTerminal: false,
          asciiOnly: false,
          colorSystem: destination.colorSystem,
        }),
      ],
      destination,
    ),
  );
  // The seam is the arrow between the two cells' text.
  const seam = drawn[drawn.findIndex((c) => c.ch === "x") + 1];
  if (seam === undefined || seam.ch !== glyph) throw new Error(`rich-js drew no seam between ${hex(left)} and ${hex(right)}`);
  inks.set(key, seam.fg);
  return seam.fg;
}

/**
 * Every arrow `drawn` (the bar at `depth`) leaves a cell in: its ink is that
 * cell's ground as drawn wherever the ground stands off the one it enters, and
 * otherwise the colour rich-js's joiner lifts it to from the two grounds
 * `truecolor` (the same bar, same state) drew. A tail enters no ground and
 * continues its cell; a lead is a notch drawn in reverse video and leaves no
 * cell. Returns how many seams were measured.
 */
function seamInks(label: string, truecolor: Chars, drawn: Chars, depth: ColorCompatibility, failures: string[]): number {
  expect([label, drawn.map((c) => c.ch).join("")]).toEqual([label, truecolor.map((c) => c.ch).join("")]);
  let seams = 0;
  drawn.forEach(({ ch, fg, bg, reverse, before }, i) => {
    if (!ARROWS.has(ch) || reverse || before === undefined) return;
    const at = `${label} ${depth} ${ch}`;
    if (bg === undefined) {
      if (!same(fg, before)) failures.push(`${at}: tail ${JSON.stringify(fg)} after a cell on ${JSON.stringify(before)}`);
      return;
    }
    seams++;
    const from = truecolor[i]!;
    if (standsOff(before, bg)) {
      if (!same(fg, before))
        failures.push(`${at}: arrow ${JSON.stringify(fg)} after a cell on ${JSON.stringify(before)}, which stands off ${JSON.stringify(bg)}`);
      return;
    }
    if (!isRgb(from.before) || !isRgb(from.bg)) {
      failures.push(`${at}: arrow between grounds truecolor drew in terminal-defined ANSI colours`);
      return;
    }
    const lifted = joinerInk(from.before, from.bg, depth);
    if (!same(fg, lifted))
      failures.push(`${at}: arrow ${JSON.stringify(fg)} between ${JSON.stringify(before)} and ${JSON.stringify(bg)}, where rich-js lifts it to ${JSON.stringify(lifted)}`);
  });
  return seams;
}

// The floors the bar's text is chosen by, highest first: body text at AA, and
// the quiet git structure at 3:1. A character keeps the highest floor it
// cleared in truecolor.
const FLOORS = [TEXT_MIN_CONTRAST, QUIET_MIN_CONTRAST];

type Chars = ReturnType<typeof drawnChars>;

/**
 * Every way `quantized` (the 256 render) fails `truecolor` (the same bar, same
 * state): an arrow whose ink is not the one `seamInks` holds it to at either
 * depth, an arrow not standing off the cell it enters, a cap of the bar's own
 * no longer continuing its cell, any divider at all, a character
 * drawn in ANSI 0–15, or a character below the highest floor it cleared in
 * truecolor. Returns how many characters were measured, so a caller can
 * refuse a vacuous pass.
 */
function compare(label: string, truecolor: Chars, quantized: Chars, failures: string[]): number {
  expect([label, quantized.map((c) => c.ch).join("")]).toEqual([
    label,
    truecolor.map((c) => c.ch).join(""),
  ]);
  // An arrow's ink is its cell's ground, or rich-js's lift of it, at each depth.
  if (seamInks(label, truecolor, truecolor, "truecolor", failures) === 0)
    failures.push(`${label}: no seam between two cells was measured`);
  seamInks(label, truecolor, quantized, "256", failures);
  quantized.forEach(({ ch, fg, bg, joiner }, i) => {
    // A cap the bar draws itself (max's bubble) continues the cell before it:
    // wherever truecolor draws it in that cell's background, 256 does too, so
    // the shape stays one. The joiner's arrows are held by `seamInks`.
    const left = quantized[i - 1];
    const continues = (c: Chars, k: number) => same(c[k]!.fg, c[k - 1]!.bg);
    if (joiner && !ARROWS.has(ch) && left !== undefined && truecolor[i]!.joiner && continues(truecolor, i) && !continues(quantized, i))
      failures.push(`${label} ${ch}: cap ${JSON.stringify(fg)} after a cell on ${JSON.stringify(left.bg)}`);
    // A seam glyph is measured on colours only while 256 draws them from its
    // own table: one in ANSI 0–15 is whatever the terminal's theme makes it.
    if (ch === DIVIDER) failures.push(`${label}: a divider joins two cells of one ground`);
    if (ARROWS.has(ch) && fg !== undefined && bg !== undefined && (!isRgb(fg) || !isRgb(bg)))
      failures.push(`${label} ${ch}: seam drawn in terminal-defined ANSI colours`);
    // An arrow drawn in the colour of the cell it enters is no seam at all.
    if (ARROWS.has(ch) && isRgb(fg) && isRgb(bg) && deltaE(fg, bg) < SEAM_MIN_DELTA_E)
      failures.push(`${label} ${ch}: arrow ${JSON.stringify(fg)} vanishes into ${JSON.stringify(bg)}`);
  });
  let measured = 0;
  truecolor.forEach(({ ch, fg, bg, joiner }, i) => {
    const q = quantized[i]!;
    // A seam that is an arrow at either depth is a shape, held above. A
    // swatch is no text either: it is a theme's colours side by side, and at
    // 256 it shows that theme's colours as the terminal draws them.
    if (joiner || q.joiner || ch === SWATCH_GLYPH || !isRgb(fg) || !isRgb(bg)) return;
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
 * Every character at ansi drawn on its own ground's index: text or arrow,
 * it is the ground's colour in every terminal theme. A divider is a failure
 * of its own. Returns how many were measured.
 */
function sameIndex(label: string, ansi: Chars, failures: string[]): number {
  let measured = 0;
  for (const { ch, fg, bg } of ansi) {
    if (ch === DIVIDER) failures.push(`${label}: a divider joins two cells of one ground`);
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
  render: (theme: string, colorCompatibility: ColorCompatibility) => Promise<Chars>;
  dispose: () => void;
}> {
  const prepared = await prepareConfig([], NO_REPO, process.cwd(), [], instantOf(new Date()));
  return {
    render: async (theme, colorCompatibility) =>
      drawnChars(
        (await renderEffective(
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
          instantOf(new Date()),
        )).rendered,
      ),
    dispose: () => prepared.registry.dispose(),
  };
}

// The open states, reached by the clicks a user makes: the 🍫 door (its tray
// and the preset picker's band items), each tab that holds controls (the 🎨 look
// tab, then 📐 layout and ⚙ config), and the theme picker on the door's first
// line, whose options wear the palette each would apply. Each stage is handed a render of the bar in
// that state at any depth.
const STAGE_NAMES = [
  "closed",
  "door",
  "preset picker",
  "look tab",
  "theme picker",
  "layout tab",
  "config tab",
] as const;
function forEachStage(
  theme: string,
  measure: (stage: string, render: (colorCompatibility: ColorCompatibility) => Chars) => void,
): void {
  const OPTS = {
    endcaps: "powerline" as const,
    wrap: true,
    padding: 1,
    width: 200,
  };
  const PAYLOAD = {
    session_id: "s1",
    cwd: "/tmp/proj",
    workspace: { current_dir: "/tmp/proj", project_dir: "/tmp/proj", added_dirs: [] },
    model: { id: "claude-opus-4-7", display_name: "Opus" },
    // The daemon always supplies the preset it resolved; the preset control
    // names it between its arrows, and that name is what opens its list.
    preset: { effective: "default" },
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
    "preset picker": (r) => opener(r, "menus.candybar_pickers", (v) => v.endsWith("preset")),
    "look tab": (r) => opener(r, "candybar.tab", (v) => v === "look"),
    "theme picker": (r) => opener(r, "menus.candybar_pickers", (v) => v.endsWith("theme")),
    "layout tab": (r) => opener(r, "candybar.tab", (v) => v === "layout"),
    "config tab": (r) => opener(r, "candybar.tab", (v) => v === "config"),
  };
  const config = parseAndValidate(
    "<test>",
    `{ globals: { palette: '${theme}' } }`,
    new Set(listResolvablePaletteNames()),
    DEFAULT_DSL_CONFIG,
  );
  const sessionState = new SessionState();
  const store = new VariableStore();
  const registry = new SourceRegistry(store, "", sessionState);
  recordRender(sessionState, "s1");
  try {
    const compiled = registerDslConfig(config, registry, { signer: TEST_SIGNER, cwd: "/tmp/proj" });
    const ctx = testVerbContext(sessionState, undefined, config);
    const render = (colorCompatibility: ColorCompatibility) =>
      renderDsl(config, compiled, store, registry, PAYLOAD, instantOf(new Date()), { ...OPTS, colorCompatibility });
    for (const stage of STAGE_NAMES) {
      const url = STAGES[stage](render("truecolor"));
      if (url !== null) clickUrl(url, ctx);
      measure(stage, (colorCompatibility) => drawnChars(render(colorCompatibility)));
    }
  } finally {
    registry.dispose();
  }
}

test("every bundled theme's text reads at 256 colours as it does in truecolor", async () => {
  const bars = await closedBars();
  try {
    const failures: string[] = [];
    let measured = 0;
    for (const theme of listThemePalettes()) {
      measured += compare(theme, await bars.render(theme, "truecolor"), await bars.render(theme, "256"), failures);
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

test("at ansi no divider is drawn, every arrow's ink is its cell's slot or rich-js's lift of it, and nothing — text or arrow — is drawn on its own ground's index", async () => {
  const bars = await closedBars();
  try {
    const failures: string[] = [];
    let measured = 0;
    let seams = 0;
    for (const theme of listThemePalettes()) {
      const ansi = await bars.render(theme, "ansi");
      measured += sameIndex(theme, ansi, failures);
      seams += seamInks(theme, await bars.render(theme, "truecolor"), ansi, "ansi", failures);
      forEachStage(theme, (stage, render) => {
        const staged = render("ansi");
        measured += sameIndex(`${theme} [${stage}]`, staged, failures);
        seams += seamInks(`${theme} [${stage}]`, render("truecolor"), staged, "ansi", failures);
      });
    }
    expect(measured).toBeGreaterThan(listThemePalettes().length * (1 + STAGE_NAMES.length) * 50);
    expect(seams).toBeGreaterThan(listThemePalettes().length * (1 + STAGE_NAMES.length) * 3);
    expect(failures).toEqual([]);
  } finally {
    bars.dispose();
  }
});
