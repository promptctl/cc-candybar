// brandon-theme-picker-bgw.fe0 — text keeps its contrast at 256 colours.
// brandon-theme-picker-bgw.ddk — so does every seam, and at ansi nothing is
// drawn on its own ground's index.
//
// [LAW:verifiable-goals] The floors (TEXT_MIN_CONTRAST, the quiet git floor)
// are chosen on truecolor values; the terminal draws what the 256 downgrade
// hands it. So every bundled theme's bar is rendered twice through `check`'s
// own pipeline — once truecolor, once at 256 — and each text character is
// measured on the colours the terminal will actually draw: a palette index read
// through the fixed xterm cube and grey ramp. A character may not land on
// ANSI 0–15 (its RGB is the terminal theme's, so no ratio exists), must keep
// the highest floor it cleared in truecolor, and an arrow must stay the
// colour of the cell it continues and stand visibly off the cell it enters.
// At ansi no ratio exists, and the one floor that does is measured instead:
// nothing is drawn on its own ground's index. At every depth an arrow's ink is
// the cell it leaves wherever that cell's ground stands off the next one's as
// drawn, and otherwise lifted off the cell it enters: in truecolor to the very
// colour rich-js's joiner lifts it to, with rich-js itself as the oracle.

import type { Frame } from "../src/render/frame";
import { linkUrls } from "./helpers/frame";
import { listThemePalettes } from "@promptctl/rich-js";
import { drawnChars, same, seams } from "./helpers/seams";
import { NO_REPO, prepareConfig, renderEffective } from "../src/check";
import { listResolvablePaletteNames, type ColorCompatibility } from "../src/themes/policy";
import { resolveEffectiveGlobals } from "../src/config/effective-globals";
import { DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import { SETTINGS_ANCHOR } from "../src/config/settings-menu";
import { DISCLOSURE_CLOSED } from "../src/config/disclosure";
import { VERB_SET_STATE } from "../src/click/wire";
import { effectsOf } from "./helpers/click";
import { buildRig } from "./helpers/rig";
import { WORLD } from "./helpers/host";
import { instantOf } from "../src/utils/instant";
import { compare, sameIndex, seamInks, type Chars } from "./helpers/colour-depth";

// The closed bar, as `check` renders it, for a theme at a depth. Every render
// is drawn at one instant, so two depths of one theme are the same bar in the
// same state, glyph for glyph, whatever the bar draws over time.
async function closedBars(): Promise<{
  render: (theme: string, colorCompatibility: ColorCompatibility) => Promise<Chars>;
  dispose: () => void;
}> {
  const at = instantOf(new Date());
  const prepared = await prepareConfig(WORLD, [], NO_REPO, process.cwd(), [], at);
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
          at,
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
async function forEachStage(
  theme: string,
  measure: (stage: string, render: (colorCompatibility: ColorCompatibility) => Chars) => void,
): Promise<void> {
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
  const opener = (rendered: Frame, key: string, member: (v: string) => boolean): string => {
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
  const STAGES: Record<(typeof STAGE_NAMES)[number], (rendered: Frame) => string | null> = {
    closed: () => null,
    door: (r) => opener(r, SETTINGS_ANCHOR, () => true),
    "preset picker": (r) => opener(r, "menus.candybar_pickers", (v) => v.endsWith("preset")),
    "look tab": (r) => opener(r, "candybar.tab", (v) => v === "look"),
    "theme picker": (r) => opener(r, "menus.candybar_pickers", (v) => v.endsWith("theme")),
    "layout tab": (r) => opener(r, "candybar.tab", (v) => v === "layout"),
    "config tab": (r) => opener(r, "candybar.tab", (v) => v === "config"),
  };
  const rig = buildRig({
    source: `{ globals: { palette: '${theme}' } }`,
    base: DEFAULT_DSL_CONFIG,
  });
  try {
    // One instant for every render, as `closedBars` draws.
    const at = instantOf(new Date());
    const render = (colorCompatibility: ColorCompatibility) =>
      rig.draw({ payload: PAYLOAD, at, opts: { ...OPTS, colorCompatibility } }).frame;
    for (const stage of STAGE_NAMES) {
      const url = STAGES[stage](render("truecolor"));
      if (url !== null) await rig.click(url);
      measure(stage, (colorCompatibility) => drawnChars(render(colorCompatibility)));
    }
  } finally {
    rig.dispose();
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
test("every open settings band and picker reads at 256 colours as it does in truecolor", async () => {
  const failures: string[] = [];
  let measured = 0;
  for (const theme of listThemePalettes()) {
    await forEachStage(theme, (stage, render) => {
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
      await forEachStage(theme, (stage, render) => {
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
