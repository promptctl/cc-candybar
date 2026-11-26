// The closing sweep of candybar-joiners-e5r4, over a scope: each look it is
// given (a variation, a position of the shade dial and a style), in each view
// of the bar, on each payload, under every bundled theme at each depth. No seam
// joins two grounds drawn as one colour, and no join is a divider: Brandon's
// rule, "don't put the same color on two adjascent segments", read off the
// colours the frame draws. Alike means one colour after the writer rounds it,
// compared for identity, as the policy decides it: where a theme names two
// neighbouring shades so near that the joiner lifts the arrow between them,
// they are still two colours, and the lifted arrow is that theme's look. No
// distance between two grounds is measured.
//
// Three kinds of seam are not the policy's to hold, each read off the cells it
// joins, never off the colour they share, so a seam of two other cells that
// happen to meet on that colour is still held. Each is computed on the palette
// the bar wears: the theme's own, transposed by the look's style.
// - A seam beside a cell whose background the bundled config authors (an
//   alert), where the payload puts that cell on alert. The policy colours by
//   address and cannot see an authored neighbour; reading one would make a
//   cell's colour depend on its neighbours. Those cells are listed below, by
//   name, with the line that authors each. Which of them are on alert is the
//   payload's word, never read off the colour a cell wears, since some themes
//   name a decorative shade alike with an alert. A cell the payload calms wears
//   its tint: it is the policy's own cell, and held.
// - A seam between two cells of a role whose whole ladder the depth draws as
//   one colour. That role has no second rung to give (its muted form is the
//   pressed button's), so its cells meet on one (textual-ansi names every rung
//   of every role alike, under every style).
// - A seam beside a cell in a pressed shade whose role's ladder the depth
//   draws only in colours that stand beside the press. The same rule read for
//   the pressed state: at sixteen colours a ladder of three slots, two of them
//   on the band's items and one on the press a depth up, has nothing left.
//   Computed below from what the design stands beside a press, never listed.
// A cell is known by its visible text and the colour it is drawn in, and what
// it wears by the shade the render dealt it before the writer rounded it (the
// per-segment record). A seam is exempt only where every cell that could be
// the one it joins wears an exempt shade, so two cells of one text (every ✕,
// every blank lead) never lend each other an exemption.
//
// [LAW:one-source-of-truth] The one sweep: audits/seam-sweep.audit.ts holds it
// under every look a user can pick, with one rule and one reader.

import {
  ColorDepth,
  drawnColour,
  getThemePalette,
  listThemePalettes,
  transposePalette,
  type ColorRgba,
  type Palette,
  type RichText,
} from "@promptctl/rich-js";
import { DEFAULT_DSL_CONFIG } from "../../src/config/default-dsl-config";
import { unauthored } from "../../src/config/dsl-loader";
import { TABS } from "../../src/config/menu-places";
import { sharedMenuStateKey } from "../../src/config/menu-keys";
import { SETTINGS_ANCHOR, SETTINGS_OPEN } from "../../src/config/settings-menu";
import { SETTINGS_NS } from "../../src/config/reserved-names";
import { resolvedStyle } from "../../src/render/rich-theme";
import {
  DECOR_HUES,
  SHADES,
  VARIATIONS,
  bandFor,
  hueOf,
  shadeRole,
  type Decor,
  type DecorHue,
  type Disclosure,
  type RoleShade,
  type ShadeName,
  type VariationName,
} from "../../src/themes/decor";
import { instantOf } from "../../src/utils/instant";
import { LADDER, besidePress } from "./decor-vocabulary";
import {
  DIVIDER,
  cellAfter,
  cellBefore,
  drawnChars,
  seams,
  shown,
  visible,
} from "./seams";
import {
  sessionBar,
  type Payload,
  type SessionBar,
} from "../../scripts/lib/draw-fixtures/session-bar";
import { validateConfig } from "../../scripts/lib/draw-fixtures/parse-and-validate";

const THEMES = listThemePalettes();
const DEPTHS = {
  truecolor: ColorDepth.TRUECOLOR,
  "256": ColorDepth.EIGHT_BIT,
  ansi: ColorDepth.STANDARD,
} as const;
export type DepthName = keyof typeof DEPTHS;
export const DEPTH_NAMES = Object.keys(DEPTHS) as DepthName[];
const COLS = 200;
const AT = instantOf(new Date("2026-10-30T12:00:00Z"));

// Every shade of a role a cell can wear: the ladder and the muted form.
const ROLE_SHADES: readonly RoleShade[] = [...LADDER, "muted"];

// The bundled styles, by name: the ThemeKey a style pick transposes the
// palette by. Every rig draws the bundled default, so these are its styles.
const STYLES = validateConfig(
  unauthored(DEFAULT_DSL_CONFIG),
  "<bundled default>",
).styles;
export const STYLE_NAMES = Object.keys(STYLES);

/** What a user picks that decides which two colours meet. */
export interface Look {
  readonly variation: VariationName;
  readonly shade: ShadeName;
  readonly style: string;
}
const lookName = ({ variation, shade, style }: Look): string =>
  `${variation}/${shade}/${style}`;

// The cells of the bundled frame whose background the bundled config authors,
// by placement, with the line in src/config/default-dsl-config.ts that authors
// it.
const AUTHORED = {
  host: `bg: "warning"`,
  context: `bg: '{{ ramp .context.contextLeft "step" 0 "error" 21 "warning" 41 (tint) }}'`,
  block: `bg: '{{ ramp (round .block.nativeUtilization) "step" 0 (tint) .settings.warnAt "warning" .settings.errorAt "error" }}'`,
} as const;
type Authored = keyof typeof AUTHORED;
const AUTHORED_NAMES = Object.keys(AUTHORED) as Authored[];

/** A payload the sweep draws: the sample payload reshaped, and which listed cells it puts on alert. */
export interface Sample {
  readonly name: string;
  readonly reshape: (payload: Payload) => Payload;
  readonly alerts: readonly Authored[];
}
/** The sample payload as it is: every listed cell on alert. */
export const HOT: Sample = {
  name: "hot",
  reshape: (payload) => payload,
  alerts: AUTHORED_NAMES,
};
// Every rate-limit window and the context calm: the threshold cells wear
// their calm arm, the cell's own tint, side by side.
const CALM_FIELDS = {
  context: { totalTokens: 48487, contextLeft: 80 },
  block: { nativeUtilization: 5 },
  weekly: { percentage: 4 },
};
export const calmed = (payload: Payload): Payload =>
  Object.fromEntries(
    Object.entries(payload).map(([key, value]) => [
      key,
      key in CALM_FIELDS
        ? {
            ...(value as object),
            ...CALM_FIELDS[key as keyof typeof CALM_FIELDS],
          }
        : value,
    ]),
  );
/** The sample payload calmed: only host, whose `bg` is always an alert, stays on one. */
export const CALM: Sample = {
  name: "calm",
  reshape: calmed,
  alerts: ["host"],
};

/** A view of the bar: what it shows, set by every key it reads, so views compose in any order. */
export interface View {
  readonly name: string;
  readonly show: (bar: SessionBar) => void;
}
export const CLOSED: View = {
  name: "closed",
  show: (bar) => bar.pick(SETTINGS_ANCHOR, "closed"),
};
/** The views a user sees: the closed bar, and the settings menu open on each tab with the theme's ⚙ open in it. */
export const VIEWS: readonly View[] = [
  CLOSED,
  ...TABS.map(({ member: tab }) => ({
    name: `${tab} tab`,
    show: (bar: SessionBar) => {
      bar.pick(SETTINGS_ANCHOR, SETTINGS_OPEN);
      bar.pick(`${SETTINGS_NS}tab`, tab);
      bar.pick(sharedMenuStateKey("candybar.pickers"), "gear");
    },
  })),
];

/** What one sweep draws: every look × depth × theme × view × payload. */
export interface SweepScope {
  readonly looks: readonly Look[];
  readonly depths: readonly DepthName[];
  readonly views: readonly View[];
  readonly payloads: readonly Sample[];
}

// Every shade of a role of `palette`, as the palette names it, whose whole
// ladder `drawnAt` draws as one colour.
function flatShades(
  palette: Palette,
  drawnAt: ColorDepth,
): ReadonlySet<string> {
  const named = (hue: DecorHue, shade: RoleShade) =>
    palette.get(shadeRole(hue, shade));
  return new Set(
    DECOR_HUES.flatMap((hue) =>
      new Set(LADDER.map((rung) => drawnColour(named(hue, rung), drawnAt).hex))
        .size === 1
        ? ROLE_SHADES.map((shade) => named(hue, shade).hex)
        : [],
    ),
  );
}

// Whether the pressed shade of the band `depth` deep under `decor` has none to
// give: its role's ladder `drawnAt` draws only in colours the design stands
// beside the press (`besidePress`). The press exemption, read by every frame
// that holds a seam beside an open trigger.
function pressHasNoneToGive(
  palette: Palette,
  decor: Decor,
  depth: number,
  drawnAt: ColorDepth,
): boolean {
  const hue = hueOf({ decor, depth });
  const taken = besidePress(palette, decor, depth, drawnAt);
  return LADDER.every((rung) =>
    taken.has(drawnColour(palette.get(shadeRole(hue, rung)), drawnAt).hex),
  );
}

// Every pressed shade under `decor`, as the palette names it, that has none to
// give at its depth. The sweep knows a cell by its text and colour, not by the
// depth of the band it presses, so it reads every depth's at once.
function pressesWithNoneToGive(
  palette: Palette,
  decor: Decor,
  drawnAt: ColorDepth,
): ReadonlySet<string> {
  return new Set(
    [0, 1, 2, 3].flatMap((depth) => {
      const disclosure: Disclosure = { decor, depth };
      return pressHasNoneToGive(palette, decor, depth, drawnAt)
        ? [bandFor(palette, disclosure, drawnAt).state.hex]
        : [];
    }),
  );
}

// A cell's background as the render dealt it, before the writer rounds it.
const dealt = (cell: RichText): ColorRgba | undefined =>
  resolvedStyle(cell.style).bgcolor?.value;

/**
 * The bundled bar drawn at each depth, one rig per depth: parse and compile
 * of the bundled default is the cost a rig pays, and a look is a session pick
 * like the theme and the view, so every sweep shares them.
 */
export interface SweepRigs {
  readonly bars: Readonly<Record<DepthName, SessionBar>>;
  dispose(): void;
}

export function sweepRigs(): SweepRigs {
  const rig = (depth: DepthName): SessionBar =>
    sessionBar(`{ globals: { colorCompatibility: '${depth}' } }`, COLS);
  const bars = {
    truecolor: rig("truecolor"),
    "256": rig("256"),
    ansi: rig("ansi"),
  };
  return {
    bars,
    dispose: () => {
      for (const bar of Object.values(bars)) bar.dispose();
    },
  };
}

/** What a sweep found, each line naming where. */
export interface SweepReport {
  /** Every seam the rule holds whose two grounds draw as one colour. */
  readonly alike: readonly string[];
  readonly withoutSeams: readonly string[];
  readonly dividers: readonly string[];
  /** Every listed cell that wears other than its payload puts it in: an alert, or its tint. */
  readonly misworn: readonly string[];
  /** The listed cells the sweep drew, sorted. */
  readonly authoredSeen: readonly string[];
  readonly counts: {
    readonly renders: number;
    readonly seams: number;
    readonly authored: number;
    readonly flat: number;
    readonly pressed: number;
  };
}

/** Every seam the bundled bar draws across `scope`, read by Brandon's rule. */
export function sweepSeams(
  rigs: SweepRigs,
  { looks, depths, views, payloads }: SweepScope,
): SweepReport {
  const alike: string[] = [];
  const withoutSeams: string[] = [];
  const dividers: string[] = [];
  const misworn: string[] = [];
  const authoredSeen = new Set<string>();
  const counts = { renders: 0, seams: 0, authored: 0, flat: 0, pressed: 0 };
  for (const look of looks) {
    const decor: Decor = {
      variation: VARIATIONS[look.variation],
      shade: SHADES[look.shade],
    };
    for (const depth of depths) {
      const drawnAt = DEPTHS[depth];
      const bar = rigs.bars[depth];
      bar.pick("variation", look.variation);
      bar.pick("shade", look.shade);
      bar.pick("style", look.style);
      for (const theme of THEMES) {
        // Through rich-js, never the render's own transposition, so the
        // policy is not its own oracle.
        const palette = transposePalette(
          getThemePalette(theme)!,
          STYLES[look.style]!,
        );
        const flat = flatShades(palette, drawnAt);
        const noneToGive = pressesWithNoneToGive(palette, decor, drawnAt);
        const alerts = new Set(
          (["warning", "error"] as const).map((role) => palette.get(role).hex),
        );
        const tints = new Set(
          DECOR_HUES.flatMap((hue) =>
            ROLE_SHADES.map((shade) => palette.get(shadeRole(hue, shade)).hex),
          ),
        );
        bar.pick("theme", theme);
        for (const view of views) {
          view.show(bar);
          for (const payload of payloads) {
            const where = `${theme} ${lookName(look)} at ${depth}, ${view.name}, ${payload.name}`;
            const { frame: drawn, segments } = bar.render(AT, payload.reshape);
            counts.renders++;
            // A listed cell its payload puts on alert, as the frame draws it:
            // its visible text.
            const authored = new Set(
              AUTHORED_NAMES.flatMap((name) => {
                const cells = segments.get(name);
                if (cells === undefined) return [];
                authoredSeen.add(name);
                const onAlert = payload.alerts.includes(name);
                const wears = onAlert ? alerts : tints;
                if (!cells.every((cell) => wears.has(dealt(cell)?.hex ?? "")))
                  misworn.push(
                    `${where}: ${name} ${onAlert ? "on alert" : "calm"} wears ${cells.map((cell) => dealt(cell)?.hex).join()}`,
                  );
                return onAlert
                  ? [visible(cells.map((cell) => cell.plain).join(""))]
                  : [];
              }),
            );
            // What the cells of the frame wear, by visible text and drawn colour.
            const worn = new Map<string, Set<string>>();
            const known = (text: string, ground: string | undefined): string =>
              `${text}|${ground}`;
            for (const cell of [...segments.values()].flat()) {
              const bg = dealt(cell);
              if (bg === undefined) continue;
              const key = known(
                visible(cell.plain),
                drawnColour(bg, drawnAt).hex,
              );
              worn.set(key, new Set([...(worn.get(key) ?? []), bg.hex]));
            }
            const wearsOnly = (
              text: string,
              ground: string | undefined,
              shades: ReadonlySet<string>,
            ): boolean => {
              const bgs = worn.get(known(text, ground));
              return (
                bgs !== undefined && [...bgs].every((bg) => shades.has(bg))
              );
            };
            const chars = drawnChars(drawn);
            chars.forEach(({ ch }, at) => {
              if (ch === DIVIDER)
                dividers.push(`${where}: after "${cellBefore(chars, at)}"`);
            });
            const previousSeams = counts.seams;
            for (const { left, right, at } of seams(chars)) {
              // A tail enters the terminal's own ground: no neighbour.
              if (right === undefined) continue;
              counts.seams++;
              const [before, after] = [
                cellBefore(chars, at),
                cellAfter(chars, at),
              ];
              if (authored.has(before) || authored.has(after)) {
                counts.authored++;
                continue;
              }
              const ground = shown(left);
              if (ground !== shown(right)) continue;
              if (
                wearsOnly(before, ground, flat) &&
                wearsOnly(after, ground, flat)
              ) {
                counts.flat++;
                continue;
              }
              if (
                wearsOnly(before, ground, noneToGive) ||
                wearsOnly(after, ground, noneToGive)
              ) {
                counts.pressed++;
                continue;
              }
              alike.push(
                `${where}: "${before}" | "${after}" both on ${ground}`,
              );
            }
            if (counts.seams === previousSeams) withoutSeams.push(where);
          }
        }
      }
    }
  }
  return {
    alike,
    withoutSeams,
    dividers,
    misworn,
    authoredSeen: [...authoredSeen].sort(),
    counts,
  };
}

/**
 * Brandon's rule held across `scope`: no seam joins two grounds drawn as one
 * colour but the three kinds above, no join is a divider, and the authored
 * list names exactly the cells that wear what their payload puts them in.
 */
export function expectEverySeamHeld(rigs: SweepRigs, scope: SweepScope): void {
  const { alike, withoutSeams, dividers, misworn, authoredSeen, counts } =
    sweepSeams(rigs, scope);
  expect(alike).toEqual([]);
  expect(dividers).toEqual([]);
  // Every listed cell is drawn, so the list names nothing that is not there,
  // and wears what its payload puts it in wherever it is drawn, so no seam of
  // the policy's own hides behind the list.
  expect(authoredSeen).toEqual([...AUTHORED_NAMES].sort());
  expect(misworn).toEqual([]);
  // Non-vacuous: every view of every theme at every depth draws seams, and
  // the flat ladders the rule reads are textual-ansi's.
  expect(counts.renders).toBeGreaterThan(0);
  expect(withoutSeams).toEqual([]);
  expect(counts.flat).toBeGreaterThan(0);
}
