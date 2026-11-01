// The bundled bar under the page's themes, closed and with its menus open, for
// every trial row of the colour model's tables and as the bar ships — drawn
// through the bar's own path (test/helpers/session-bar) under session picks of
// the variation and shade, exactly as a click would make them. Writes
// proto-looks/out/renders.json. Harness for brandon-menus-sjhy.4fi.
//
//   node --require ./scripts/version-stamp.cjs --import tsx proto-looks/render.ts
import fs from "node:fs";
import { sharedMenuStateKey } from "../src/config/menu-keys";
import { SETTINGS_ANCHOR, SETTINGS_OPEN } from "../src/config/settings-menu";
import { SETTINGS_NS } from "../src/config/loader/reserved-namespace";
import { TRIAL_SHADE_NAMES, TRIAL_VARIATION_NAMES, type ShadeName } from "../src/themes/decor";
import { paletteForThemeName } from "../src/themes/palette-resolvers";
import { instantOf } from "../src/utils/instant";
import { sessionBar, type Payload, type SessionRender } from "../test/helpers/session-bar";
import { THEMES } from "./axes.mjs";

const OUT = "proto-looks/out";
// [LAW:one-source-of-truth] The candidates are the tables' own trial rows, so
// no name here can miss a row: an unknown pick would quietly draw the default.
// `middle` is the jump the dial rests on today.
const SHADES: readonly ShadeName[] = ["middle", ...TRIAL_SHADE_NAMES];
const STATES = ["calm", "working", "hot"] as const;
type State = (typeof STATES)[number];

// What each payload shows over the decoration being judged. `hot` is check's
// own payload: every threshold and alert role painted over its cell. `calm`
// paints none. `working` is calm with the activity cell drawn — the last cell
// of the bundled status row, which a keystone on a line's end lands on.
const SHOWN: Record<State, (base: Payload) => Payload> = {
  hot: (base) => base,
  calm: (base) => ({
    ...base,
    context: { ...(base.context as object), contextLeft: 62 },
    block: { ...(base.block as object), nativeUtilization: 18 },
    host: { ...(base.host as object), ssh: false },
  }),
  working: (base) => ({
    ...SHOWN.calm(base),
    activity: { tool: { running: "Bash:2", done: "Read:5" } },
  }),
};

interface Rendered {
  readonly text: string;
}
interface Views {
  readonly closed: Rendered;
  readonly open: Rendered;
}

const bar = sessionBar(`{}`, 170);
const at = instantOf(new Date("2026-10-23T12:00:00Z"));

// No warning is a fact about the look; any warning is a fault in the harness.
const judged = ({ text, warnings }: SessionRender): Rendered => {
  if (warnings.length > 0) throw new Error(`render warned: ${warnings.map((w) => w.message).join("; ")}`);
  return { text };
};

// The menu the open view shows: the door open on ⚡ session, the theme's ⚙
// open, and the style list under it — bands at depths 0, 1 and 2. Held for the
// closed view too, so the two differ by the door alone.
bar.pick(`${SETTINGS_NS}tab`, "session");
bar.pick(sharedMenuStateKey("candybar.pickers"), "gear");
bar.pick(sharedMenuStateKey("candybar.gearPickers"), "candybar.apply.style");
const views = (state: State): Views => {
  bar.pick(SETTINGS_ANCHOR, "closed");
  const closed = judged(bar.render(at, SHOWN[state]));
  bar.pick(SETTINGS_ANCHOR, SETTINGS_OPEN);
  return { closed, open: judged(bar.render(at, SHOWN[state])) };
};

const renders: Record<string, Views> = {};
const today: Record<string, Views> = {};
const poles: Record<string, { background: string; foreground: string }> = {};
for (const theme of THEMES) {
  const palette = paletteForThemeName(theme);
  const hex = (role: string): string => {
    const colour = palette.get(role);
    if (colour === undefined) throw new Error(`${theme} names no ${role}`);
    return colour.hex;
  };
  poles[theme] = { background: hex("background"), foreground: hex("foreground") };
  bar.pick("theme", theme);
  // Today is the bar with no look picked: whatever the theme ships with.
  bar.unpick("variation");
  bar.unpick("shade");
  for (const state of STATES) today[`${state}|${theme}`] = views(state);
  for (const variation of TRIAL_VARIATION_NAMES) {
    bar.pick("variation", variation);
    for (const shade of SHADES) {
      bar.pick("shade", shade);
      for (const state of STATES) renders[`${variation}|${shade}|${state}|${theme}`] = views(state);
    }
  }
}
bar.dispose();
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(`${OUT}/renders.json`, JSON.stringify({ poles, renders, today }));
console.log(`${OUT}/renders.json: ${Object.keys(renders).length} renders, ${Object.keys(today).length} today`);
