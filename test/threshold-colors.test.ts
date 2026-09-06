// The bundled default's threshold colours, pinned as a CONTRACT over palette
// names — not opaque bytes. block/weekly heat as utilization passes 50 and
// the (user-overridable) warning threshold; burnrate heats as the projected
// minutes-to-cap fall under the warn/error minutes, with the -1 "cannot
// project" sentinel calm; context heats as the integer percentage left drops
// through 40 and 20. Each row says which palette NAME the cell wears, and the
// expectation reads the live palette, so the pin holds across themes.
//
// Written against the `if ge … else …` helper cascades BEFORE they became one
// `ramp` call each (brandon-custom-segments-g5z.2): the ramp is proven
// byte-equivalent by this file passing unchanged on both sides of that
// change. [LAW:behavior-not-structure] — the contract is the colour at each
// value, whichever spelling computes it.

import { getThemePalette, type Palette } from "@promptctl/rich-js";
import { RAW_DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import { parseAndValidate } from "./helpers/parse-and-validate";
import { narrowToSegment } from "./helpers/narrow-to-segment";
import { registerDslConfig, renderDsl } from "../src/dsl/render";
import { VariableStore } from "../src/var-system/store";
import { SourceRegistry } from "../src/var-system/sources";
import { SessionState } from "../src/daemon/session-state";

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
// against, and the palette names its cell must wear.
interface Row {
  readonly value: number;
  readonly bg: string;
  readonly fg: string;
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
        { value: 0, bg: "panel", fg: "foreground" },
        { value: 49, bg: "panel", fg: "foreground" },
        { value: 49.6, bg: "warning", fg: "button-color-foreground" },
        { value: 50, bg: "warning", fg: "button-color-foreground" },
        { value: 79, bg: "warning", fg: "button-color-foreground" },
        { value: 79.6, bg: "error", fg: "button-color-foreground" },
        { value: 80, bg: "error", fg: "button-color-foreground" },
        { value: 100, bg: "error", fg: "button-color-foreground" },
      ]
    : [
        // threshold 50: the warning band collapses — 50 is already error.
        { value: 0, bg: "panel", fg: "foreground" },
        { value: 49, bg: "panel", fg: "foreground" },
        { value: 50, bg: "error", fg: "button-color-foreground" },
        { value: 79, bg: "error", fg: "button-color-foreground" },
        { value: 100, bg: "error", fg: "button-color-foreground" },
      ];

// Nearer-is-hotter over minutes-to-cap; -1 is "cannot project" and calm.
const ETA_HEAT: readonly Row[] = [
  { value: -1, bg: "panel", fg: "foreground" },
  { value: 0, bg: "error", fg: "button-color-foreground" },
  { value: 29, bg: "error", fg: "button-color-foreground" },
  { value: 30, bg: "warning", fg: "button-color-foreground" },
  { value: 59, bg: "warning", fg: "button-color-foreground" },
  { value: 60, bg: "panel", fg: "foreground" },
  { value: 120, bg: "panel", fg: "foreground" },
];

// Less-left-is-hotter over an integer percentage (src/segments/context.ts
// rounds it), so 20/21 and 40/41 are the exact edges.
const CONTEXT_LEFT: readonly Row[] = [
  { value: 0, bg: "error", fg: "button-color-foreground" },
  { value: 20, bg: "error", fg: "button-color-foreground" },
  { value: 21, bg: "warning", fg: "button-color-foreground" },
  { value: 40, bg: "warning", fg: "button-color-foreground" },
  { value: 41, bg: "surface-active", fg: "foreground" },
  { value: 100, bg: "surface-active", fg: "foreground" },
];

// A lowered heat threshold moves BOTH the first warm colour and the text flip
// — one variable feeds the bg and the fg ramp, so they cannot disagree.
const HEAT_LOW: readonly Row[] = [
  { value: 19, bg: "panel", fg: "foreground" },
  { value: 20, bg: "warning", fg: "button-color-foreground" },
  { value: 79, bg: "warning", fg: "button-color-foreground" },
  { value: 80, bg: "error", fg: "button-color-foreground" },
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

function renderOne(
  c: Case,
  value: number,
  palette: Palette,
  onSegmentError?: (segName: string, message: string) => void,
): string {
  const parsed = parseAndValidate("<default>", SERIALIZED);
  const one = {
    ...narrowToSegment(parsed, c.segment),
    variables: {
      ...parsed.variables,
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
      palette,
      OPTS,
      { onSegmentError },
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

// What the renderer paints for a (fg name, bg name) pair: the bg verbatim,
// the fg composited over it — `button-color-foreground` carries alpha
// (`#ffffffdd`), and rich-js's render flattens alpha over the cell's own bg.
// `compositeOver` is identity at alpha 1, so every row goes through it.
function expected(palette: Palette, row: Row): { fg: string; bg: string } {
  const bg = palette.get(row.bg);
  const fg = palette.get(row.fg);
  expect(bg).toBeDefined();
  expect(fg).toBeDefined();
  return { fg: fg!.compositeOver(bg!).hex, bg: bg!.hex };
}

describe.each(PALETTES)("threshold colours under %s", (paletteName) => {
  const palette = getThemePalette(paletteName)!;
  for (const c of CASES) {
    const varLabel = Object.entries(c.vars)
      .map(([k, v]) => `${k}=${v}`)
      .join(" ");
    test.each(c.rows)(
      `${c.segment} ${varLabel} at $value wears bg=$bg fg=$fg`,
      (row) => {
        const rendered = renderOne(c, row.value, palette);
        expect(cellColors(rendered, c.glyph)).toEqual(expected(palette, row));
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
  test.each(["block", "weekly"] as const)(
    "%s warningThreshold 30 under heatThreshold 50 names both positions",
    (segment) => {
      const c = CASES.find((x) => x.segment === segment)!;
      const errors: string[] = [];
      const rendered = renderOne(
        { ...c, vars: { [`${segment}.budget.warningThreshold`]: 30 } },
        60,
        palette,
        (name, message) => errors.push(`${name}: ${message}`),
      );
      expect(rendered).toContain("⚠");
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatch(
        new RegExp(`^${segment}: .*ascending position order; stop 2 at 30 follows stop 1 at 50`),
      );
    },
  );
});
