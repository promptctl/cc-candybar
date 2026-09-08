// [LAW:verifiable-goals] The global settings door's colour, measured over the
// WHOLE palette registry rather than argued for in a comment.
//
// The door is the one cell of the settings menu that authors a background
// (src/config/settings-menu.ts, DOOR_COLORS). It states identity — "this is the
// control every bar carries" — and identity is only stated if the cell is
// visibly not one of the decorated cells beside it. So the claim under test is
// a floor, on every theme a user can pick:
//
//   1. the door stands off EVERY entry of the decorative vocabulary — the 18
//      colours any address can deal a neighbouring cell — by at least the .10
//      ΔE the region model already reads as "visibly stands off" (the
//      trigger/plane floor of test/decor.test.ts);
//   2. its text clears 4.5 : 1 on the background it resolved to, which a fixed
//      pole would not: `accent` is a light cell on some themes and a dark one
//      on others.
//
// [LAW:behavior-not-structure] Both numbers are read off a RENDERED cell (the
// per-segment sink the walk publishes), never off the authored spec, so any
// resolution path that delivers the same colours passes — and the alternative
// this measurement rejected (`lighten (color "accent") 3`, which lands 0.02–0.03
// from the tints of the five light themes) fails it by the same reading.

import {
  contrastRatio,
  getThemePalette,
  listThemePalettes,
  Oklch,
} from "@promptctl/rich-js";
import type { ColorRgba, Palette, RichText } from "@promptctl/rich-js";
import { parseAndValidate } from "./helpers/parse-and-validate";
import { VariableStore } from "../src/var-system/store";
import { SourceRegistry } from "../src/var-system/sources";
import { registerDslConfig, renderDsl } from "../src/dsl/render";
import { SessionState } from "../src/daemon/session-state";
import { listResolvablePaletteNames } from "../src/themes/policy";
import { DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import { SETTINGS_ANCHOR } from "../src/config/settings-menu";
import { DECOR_VOCABULARY, decorEntryColour } from "../src/themes/decor";

const ALLOWED = new Set(listResolvablePaletteNames());

// The same floor test/decor.test.ts holds a trigger to against its own plane:
// below it two cells read as one colour with a gradient between them.
const DOOR_FLOOR = 0.1;
const TEXT_RATIO = 4.5;

const OPTS = {
  style: "powerline" as const,
  colorCompatibility: "truecolor" as const,
  wrap: true,
  padding: 0,
  charset: "unicode" as const,
  width: Number.POSITIVE_INFINITY,
};

// ΔE in OKLab — a contrast ratio cannot see two hues at one lightness, which is
// exactly the collision this floor exists to catch. Same measure as decor.test.
function deltaE(a: ColorRgba, b: ColorRgba): number {
  const lab = (c: ColorRgba): [number, number, number] => {
    const o = Oklch.fromRgba(c);
    const rad = (o.h * Math.PI) / 180;
    return [o.l, o.c * Math.cos(rad), o.c * Math.sin(rad)];
  };
  const [l1, a1, b1] = lab(a);
  const [l2, a2, b2] = lab(b);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}

// [LAW:parse-dont-validate] The name came from `listThemePalettes()`, so the
// registry has it by construction — a `Palette`, never the `null` the string
// overload admits. Resolved once here, and passed as a value from then on.
const paletteOf = (name: string): Palette => {
  const palette = getThemePalette(name);
  if (palette === null) throw new Error(`the registry disowned "${name}"`);
  return palette;
};

/** The door's rendered cell — background and text — under `themeName`. */
function doorCell(themeName: string): { bg: ColorRgba; fg: ColorRgba } {
  const config = parseAndValidate(
    "<door>",
    `{ globals: { palette: '${themeName}' } }`,
    ALLOWED,
    DEFAULT_DSL_CONFIG,
  );
  const store = new VariableStore();
  const registry = new SourceRegistry(store, "", undefined, new SessionState());
  const compiled = registerDslConfig(config, registry);
  const sink = new Map<string, readonly RichText[]>();
  renderDsl(
    config,
    compiled,
    store,
    registry,
    {
      session_id: "s1",
      workspace: { current_dir: "/w/p", project_dir: "/w/p" },
      model: { display_name: "Opus" },
    },
    paletteOf(themeName),
    OPTS,
    { perSegmentSink: sink },
  );
  const cell = sink.get(SETTINGS_ANCHOR)?.[0];
  if (cell === undefined) throw new Error(`the door did not render on ${themeName}`);
  const { bgcolor, color } = cell.style ?? {};
  if (bgcolor?.value === undefined || color?.value === undefined)
    throw new Error(`the door rendered without a resolved colour on ${themeName}`);
  return { bg: bgcolor.value as ColorRgba, fg: color.value as ColorRgba };
}

describe("the global settings door is visibly not a decorated cell", () => {
  test.each(listThemePalettes())(
    "%s: the door stands off every vocabulary entry, and its text is readable",
    (themeName) => {
      const palette = paletteOf(themeName);
      const { bg, fg } = doorCell(themeName);
      const nearest = Math.min(
        ...DECOR_VOCABULARY.map((entry) =>
          deltaE(bg, decorEntryColour(palette, entry)),
        ),
      );
      expect([themeName, nearest > DOOR_FLOOR]).toEqual([themeName, true]);
      expect([themeName, contrastRatio(bg, fg) >= TEXT_RATIO]).toEqual([
        themeName,
        true,
      ]);
    },
  );
});
