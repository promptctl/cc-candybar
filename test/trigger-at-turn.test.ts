// [LAW:verifiable-goals] candybar-joiners-e5r4.34r: where a row turns hue, the
// turn rule can move a cell either side of the turn to a rung past its window,
// and the pressed shade keeps apart only from the tones the windows deal, so an
// open menu trigger standing at the turn could wear the very colour the cell
// across the turn wears. No bundled frame puts a trigger there; these authored
// rows do, under `alt` (a turn every three cells) and under a keystone tuning
// (a turn after each line's first cell), each drawn with its menu open under
// every bundled theme at 256 colours and ansi, and read off the colours the
// frame draws.

import { ColorDepth, getThemePalette, listThemePalettes } from "@promptctl/rich-js";
import { menuStateKey } from "../src/config/menu-keys";
import { resolvedStyle } from "../src/render/rich-theme";
import { DECOR_HUES, SHADES, VARIATIONS, bandFor, decorEntryColour, windowAt, type Decor, type DecorHue, type VariationName } from "../src/themes/decor";
import { instantOf } from "../src/utils/instant";
import { cellAfter, cellBefore, drawnChars, seams, shown, visible } from "./helpers/seams";
import { pressHasNoneToGive } from "./helpers/seam-sweep";
import { sessionBar } from "./helpers/session-bar";

const CELLS = 8;
const TRIGGER = "trigger";
const APPLY = "applySort";
const OPEN = menuStateKey(TRIGGER, APPLY, undefined);
const AT = instantOf(new Date("2026-10-30T12:00:00Z"));
const DEPTHS = [
  ["256", ColorDepth.EIGHT_BIT],
  ["ansi", ColorDepth.STANDARD],
] as const;

// A frame: a row of eight plain cells, the bar's second so the settings door
// leads the first, with a menu trigger at `trigger`, standing at a turn, and
// `across` the cell on the other side of it, which wears `hue`.
interface Frame {
  readonly variation: VariationName;
  readonly trigger: number;
  readonly across: number;
  readonly hue: DecorHue;
}
const FRAMES: readonly Frame[] = [
  // The second row starts on the accent: cells 0–2 accent, 3–5 secondary,
  // 6–7 accent. The trigger is the last secondary before the turn.
  { variation: "alt", trigger: 5, across: 6, hue: "accent" },
  // Each line's first cell is the keystone, in the accent, and the rest are
  // secondary. The trigger is the keystone, beside the cell after it, as the
  // settings door stands beside its frame-rate cell under the door tunings.
  { variation: "start-secondary", trigger: 0, across: 1, hue: "secondary" },
];

const name = (frame: Frame, i: number): string => (i === frame.trigger ? TRIGGER : `c${i}`);

function source(frame: Frame, compatibility: string): string {
  const cells = Array.from({ length: CELLS }, (_, i) => name(frame, i));
  const segments = cells
    .map((cell) => (cell === TRIGGER ? `${TRIGGER}: { template: '↕ {{ menu "${APPLY}" "▸" "▾" }}' }` : `${cell}: { template: '${cell}' }`))
    .join(", ");
  return `{
    globals: { colorCompatibility: '${compatibility}' },
    variables: { sortOrder: { kind: 'state', key: 'sort-order', default: 'asc' } },
    actions: { ${APPLY}: { set: 'sort-order', from: ['asc', 'desc'] } },
    segments: { label: { template: 'label' }, ${segments} },
    root: { v: [{ h: ['label'] }, { h: [${cells.map((cell) => `'${cell}'`).join(", ")}] }] },
  }`;
}

describe.each(FRAMES)("an open trigger standing at a hue turn", (frame) => {
  test(`under ${frame.variation}, the trigger at cell ${frame.trigger} draws apart from both its neighbours, cell ${frame.across} across the turn among them, under every bundled theme at 256 colours and ansi`, () => {
    const decor: Decor = { variation: VARIATIONS[frame.variation], shade: SHADES.middle };
    const alike: string[] = [];
    const seen = { seams: 0, across: 0, open: 0, pastWindow: 0 };
    for (const [compatibility, drawnAt] of DEPTHS) {
      const bar = sessionBar(source(frame, compatibility), 200);
      bar.pick("variation", frame.variation);
      bar.pick("shade", "middle");
      bar.pick(OPEN, APPLY);
      for (const theme of listThemePalettes()) {
        const palette = getThemePalette(theme)!;
        bar.pick("theme", theme);
        const { frame: drawn, segments } = bar.render(AT);
        // A cell on the bar is the first its segment draws: an open trigger's
        // body follows it, dropped below the row.
        const onBar = (cell: string) => segments.get(cell)![0]!;
        const worn = (cell: string): string | undefined => resolvedStyle(onBar(cell).style).bgcolor?.value?.hex;
        const across = name(frame, frame.across);
        if (worn(TRIGGER) === bandFor(palette, { decor, depth: 0 }, drawnAt).state.hex) seen.open++;
        // Where the turn rule reached past the window of the cell across it.
        const window = windowAt(palette, frame.hue, decor.shade, drawnAt).map((tone) => decorEntryColour(palette, { hue: frame.hue, shade: tone }).hex);
        if (!window.includes(worn(across) ?? "")) seen.pastWindow++;
        // The sweep's press exemption, for the band every bar trigger opens:
        // a press whose ladder the depth draws only in colours the design
        // stands beside it has none to give, so it meets one of them, a tone
        // a window deals. A cell beside it wearing anything else was put
        // there by the turn rule, and that seam is held.
        const noneToGive = pressHasNoneToGive(palette, decor, 0, drawnAt);
        const dealtTones = new Set(DECOR_HUES.flatMap((hue) => windowAt(palette, hue, decor.shade, drawnAt).map((tone) => decorEntryColour(palette, { hue, shade: tone }).hex)));
        const [trigger, other] = [visible(onBar(TRIGGER).plain), visible(onBar(across).plain)] as const;
        const chars = drawnChars(drawn);
        for (const { left, right, at } of seams(chars)) {
          const cells = [cellBefore(chars, at), cellAfter(chars, at)];
          if (!cells.includes(trigger)) continue;
          seen.seams++;
          if (cells.includes(other)) seen.across++;
          if (shown(left) !== shown(right)) continue;
          // A plain cell's text is its name.
          const met = cells.find((cell) => cell !== trigger)!;
          if (noneToGive && dealtTones.has(worn(met) ?? "")) continue;
          alike.push(`${theme} at ${compatibility}: ${cells.join(" | ")} both on ${shown(left)}`);
        }
      }
      bar.dispose();
    }
    expect(alike).toEqual([]);
    // Non-vacuous: every frame drew the trigger open beside the cell across
    // the turn, and somewhere that cell wore a rung past its window.
    const frames = DEPTHS.length * listThemePalettes().length;
    expect([seen.across, seen.open]).toEqual([frames, frames]);
    expect(seen.seams).toBe(frames * (frame.trigger === 0 ? 1 : 2));
    expect(seen.pastWindow).toBeGreaterThan(0);
  });
});
