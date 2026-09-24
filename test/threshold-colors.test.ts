// The bundled default's threshold colours, pinned as a CONTRACT over palette
// names — not opaque bytes. block/weekly heat as utilization passes 50 and
// the (user-overridable) warning threshold; burnrate heats as the projected
// minutes-to-cap fall under the warn/error minutes, with the -1 "cannot
// project" sentinel calm; context heats as the integer percentage left drops
// through 40 and 20. Each row says which palette NAME the cell's background
// wears, and the expectation reads the live palette, so the pin holds across
// themes. The text is not a palette name: it is chosen for the background the
// ramp resolves to, so its contract is legibility — it clears the renderer's
// text floor on that background at every stop (brandon-theme-picker-bgw.b2g,
// which removed the hand-paired `button-color-foreground` that measured
// 1.79:1 on textual-dark's warning).
//
// Written against the `if ge … else …` helper cascades BEFORE they became one
// `ramp` call each (brandon-custom-segments-g5z.2): the ramp is proven
// byte-equivalent by this file passing unchanged on both sides of that
// change. [LAW:behavior-not-structure] — the contract is the colour at each
// value, whichever spelling computes it.

import {
  contrastRatio,
  getThemePalette,
  parseRgbHex,
  type Palette,
} from "@promptctl/rich-js";
import { TEXT_MIN_CONTRAST } from "../src/themes/decor";
import { RAW_DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import { parseAndValidate } from "./helpers/parse-and-validate";
import { narrowToSegment } from "./helpers/narrow-to-segment";
import { registerDslConfig, renderDsl } from "../src/dsl/render";
import { VariableStore } from "../src/var-system/store";
import { SourceRegistry } from "../src/var-system/sources";
import { SessionState } from "../src/daemon/session-state";
import { resolveThemeSelection } from "../src/themes/palette-resolvers";

const SERIALIZED = JSON.stringify(RAW_DEFAULT_DSL_CONFIG);
const PALETTES = ["textual-dark", "textual-light"] as const;
const RESETS_AT = 4_102_444_800; // 2100-01-01 — `when: gt .resetsAt 0` fires

const OPTS = {
  style: "powerline" as const,
  colorCompatibility: "truecolor" as const,
  wrap: true,
  padding: 1,
  charset: "unicode" as const,
  width: Number.POSITIVE_INFINITY,
};

// One row: the payload a segment reads, the literal vars it thresholds
// against, and the palette name its cell's background must wear.
interface Row {
  readonly value: number;
  readonly bg: string;
}
interface Case {
  readonly segment: string;
  readonly glyph: string;
  readonly vars: Readonly<Record<string, number>>;
  readonly payload: (value: number) => Record<string, unknown>;
  readonly rows: readonly Row[];
}

// Fuller-is-hotter over the displayed (rounded) percentage: the fractional
// rows pin that the colour agrees with the integer the cell prints.
const BLOCK_LIKE = (threshold: number): readonly Row[] =>
  threshold === 80
    ? [
        { value: 0, bg: "panel" },
        { value: 49, bg: "panel" },
        { value: 49.6, bg: "warning" },
        { value: 50, bg: "warning" },
        { value: 79, bg: "warning" },
        { value: 79.6, bg: "error" },
        { value: 80, bg: "error" },
        { value: 100, bg: "error" },
      ]
    : [
        // threshold 50: the warning band collapses — 50 is already error.
        { value: 0, bg: "panel" },
        { value: 49, bg: "panel" },
        { value: 50, bg: "error" },
        { value: 79, bg: "error" },
        { value: 100, bg: "error" },
      ];

// Nearer-is-hotter over minutes-to-cap; -1 is "cannot project" and calm.
const ETA_HEAT: readonly Row[] = [
  { value: -1, bg: "panel" },
  { value: 0, bg: "error" },
  { value: 29, bg: "error" },
  { value: 30, bg: "warning" },
  { value: 59, bg: "warning" },
  { value: 60, bg: "panel" },
  { value: 120, bg: "panel" },
];

// Less-left-is-hotter over an integer percentage (src/segments/context.ts
// rounds it), so 20/21 and 40/41 are the exact edges.
const CONTEXT_LEFT: readonly Row[] = [
  { value: 0, bg: "error" },
  { value: 20, bg: "error" },
  { value: 21, bg: "warning" },
  { value: 40, bg: "warning" },
  { value: 41, bg: "surface-active" },
  { value: 100, bg: "surface-active" },
];

// A lowered heat threshold moves the first warm colour, and the text follows
// the background it lands on.
const HEAT_LOW: readonly Row[] = [
  { value: 19, bg: "panel" },
  { value: 20, bg: "warning" },
  { value: 79, bg: "warning" },
  { value: 80, bg: "error" },
];

const CASES: readonly Case[] = [
  ...(["block", "weekly"] as const).map((segment) => ({
    segment,
    glyph: segment === "block" ? "◱" : "◑",
    vars: { [`${segment}.budget.heatThreshold`]: 20 },
    payload: (v: number) =>
      segment === "block"
        ? { block: { nativeUtilization: v, resetsAt: RESETS_AT } }
        : { weekly: { percentage: v, resetsAt: RESETS_AT } },
    rows: HEAT_LOW,
  })),
  ...([80, 50] as const).map((threshold) => ({
    segment: "block",
    glyph: "◱",
    vars: { "block.budget.warningThreshold": threshold },
    payload: (v: number) => ({
      block: { nativeUtilization: v, resetsAt: RESETS_AT },
    }),
    rows: BLOCK_LIKE(threshold),
  })),
  ...([80, 50] as const).map((threshold) => ({
    segment: "weekly",
    glyph: "◑",
    vars: { "weekly.budget.warningThreshold": threshold },
    payload: (v: number) => ({
      weekly: { percentage: v, resetsAt: RESETS_AT },
    }),
    rows: BLOCK_LIKE(threshold),
  })),
  {
    segment: "burnrate",
    glyph: "⚡",
    vars: { "burn.eta.warnMinutes": 60, "burn.eta.errorMinutes": 30 },
    payload: (v: number) => ({
      burn: { costPerHour: 1 },
      block: { etaMinutes: v, resetsAt: RESETS_AT },
    }),
    rows: ETA_HEAT,
  },
  {
    segment: "context",
    glyph: "◔",
    vars: {},
    payload: (v: number) => ({
      context: { totalTokens: 1000, contextLeft: v },
    }),
    rows: CONTEXT_LEFT,
  },
];

const HOOK = {
  hook_event_name: "Status",
  session_id: "x",
  cwd: "/tmp",
  model: { id: "x", display_name: "x" },
  workspace: { current_dir: "/tmp", project_dir: "/tmp", added_dirs: [] },
};

// The theme is named rather than handed over as a Palette: renderDsl resolves it
// from the SELECTION now (brandon-themes-dzl), so a name is the whole input and
// the palette the expectations read is built from that same name.
function renderOne(
  c: Case,
  value: number,
  themeName: string,
  onSegmentError?: (segName: string, message: string) => void,
): string {
  const narrowed = narrowToSegment(
    parseAndValidate("<default>", SERIALIZED),
    c.segment,
  );
  const one = {
    ...narrowed,
    variables: {
      ...narrowed.variables,
      ...Object.fromEntries(
        Object.entries(c.vars).map(([name, v]) => [
          name,
          { kind: "literal" as const, value: v },
        ]),
      ),
    },
  };
  const store = new VariableStore();
  const registry = new SourceRegistry(store, "", undefined, new SessionState());
  try {
    const compiled = registerDslConfig(one, registry, { cwd: process.cwd() });
    return renderDsl(
      one,
      compiled,
      store,
      registry,
      { ...HOOK, ...c.payload(value) },
      OPTS,
      { onSegmentError },
      { theme: resolveThemeSelection(undefined, null, themeName) },
    );
  } finally {
    registry.dispose();
  }
}

// The fg/bg pair of the SGR run that paints the cell's glyph — the one
// `38;2;r;g;b;48;2;r;g;b` sequence immediately before the glyph's text.
function cellColors(
  rendered: string,
  glyph: string,
): { fg: string; bg: string } {
  const m = rendered.match(new RegExp(`\\x1b\\[([\\d;]+)m[^\\x1b]*${glyph}`));
  expect(m).not.toBeNull();
  const params = m![1]!.split(";").map(Number);
  const out: { fg?: string; bg?: string } = {};
  for (let i = 0; i < params.length; i++) {
    if ((params[i] === 38 || params[i] === 48) && params[i + 1] === 2) {
      const hex = params
        .slice(i + 2, i + 5)
        .map((n) => n.toString(16).padStart(2, "0"))
        .join("");
      out[params[i] === 38 ? "fg" : "bg"] = `#${hex}`;
      i += 4;
    }
  }
  expect(out.fg).toBeDefined();
  expect(out.bg).toBeDefined();
  return { fg: out.fg!, bg: out.bg! };
}

function expectedBg(palette: Palette, row: Row): string {
  const bg = palette.get(row.bg);
  expect(bg).toBeDefined();
  return bg!.hex;
}

describe.each(PALETTES)("threshold colours under %s", (paletteName) => {
  const palette = getThemePalette(paletteName)!;
  for (const c of CASES) {
    const varLabel = Object.entries(c.vars)
      .map(([k, v]) => `${k}=${v}`)
      .join(" ");
    test.each(c.rows)(
      `${c.segment} ${varLabel} at $value wears bg=$bg, text legible on it`,
      (row) => {
        const { fg, bg } = cellColors(renderOne(c, row.value, paletteName), c.glyph);
        expect(bg).toBe(expectedBg(palette, row));
        expect(
          contrastRatio(parseRgbHex(fg.slice(1)), parseRgbHex(bg.slice(1))),
        ).toBeGreaterThanOrEqual(TEXT_MIN_CONTRAST);
      },
    );
  }
});

// [LAW:no-silent-failure] A warning threshold set below the heat threshold is
// a descending pair. The old `if ge …` cascade rendered it by silently
// dropping the warning band; the ramp refuses to sort and names both
// positions, so the user can see which two knobs to move together.
describe("a threshold below its neighbour is a loud render error", () => {
  const palette = getThemePalette("textual-dark")!;
  const INVERTED: readonly {
    segment: string;
    vars: Readonly<Record<string, number>>;
    pair: string;
  }[] = [
    {
      segment: "block",
      vars: { "block.budget.warningThreshold": 30 },
      pair: "stop 2 at 30 follows stop 1 at 50",
    },
    {
      segment: "weekly",
      vars: { "weekly.budget.warningThreshold": 30 },
      pair: "stop 2 at 30 follows stop 1 at 50",
    },
    {
      segment: "burnrate",
      vars: { "burn.eta.warnMinutes": 60, "burn.eta.errorMinutes": 90 },
      pair: "stop 3 at 60 follows stop 2 at 90",
    },
  ];
  test.each(INVERTED)(
    "$segment $vars names both positions",
    ({ segment, vars, pair }) => {
      // The found case lends its payload and glyph; `vars` are this row's own,
      // over the bundled defaults, so the pair inverts exactly as stated.
      const c = CASES.find((x) => x.segment === segment)!;
      const errors: string[] = [];
      const rendered = renderOne(
        { ...c, vars },
        60,
        "textual-dark",
        (name, message) => errors.push(`${name}: ${message}`),
      );
      expect(rendered).toContain("⚠");
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatch(
        new RegExp(`^${segment}: .*ascending position order; ${pair}`),
      );
    },
  );
});
