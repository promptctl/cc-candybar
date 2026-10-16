// The effort gauge, compared: the model cell at every effort level, under
// each candidate colour scheme, in a few themes.
//
//   pnpm effort-demo                   # mocha, tokyo-night, gruvbox, latte
//   pnpm effort-demo dracula nord      # any bundled themes, by name
//
// [LAW:one-source-of-truth] A scheme is a config fragment — exactly what a
// user file or the bundled default would carry — loaded by `check`'s own
// pipeline (prepareConfig: the daemon's merge and validation) and drawn by
// renderDsl over `check`'s payload fixture plus one `effort` field, with the
// theme picked the way a click picks it. So a cell here is the cell shipping
// that scheme would draw. The first row is the bundled default as it stands.
//
// Every row but the first changes only what it names, over one shared base:
// low quiet, medium through xhigh in full accent. Max is the variable.
//
// Why the cell looks the way it does: its place in the bundled layout deals
// the model cell the theme's `accent` hue as its tint, in every bundled
// theme. So an accent glyph on it is tone-on-tone, and a solid accent fill is
// a one-cell lightness jump inside its own hue.
//
// [LAW:no-silent-failure] A scheme whose template fails draws its ⚠ cell and
// says why on stderr.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import { cellLen } from "@promptctl/rich-js";

import { checkPayload, prepareConfig, type PreparedConfig } from "../check.js";
import { QUIET_TEXT } from "../config/quiet-text.js";
import {
  renderOptionsOf,
  renderSelectionOf,
  resolveEffectiveGlobals,
} from "../daemon/render-payload.js";
import { renderDsl } from "../dsl/render.js";
import { INVISIBLE } from "../render/ansi.js";
import { TEXT_MIN_CONTRAST } from "../themes/decor.js";
import { listResolvablePaletteNames } from "../themes/policy.js";

const LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
const DEFAULT_THEMES = [
  "catppuccin-mocha",
  "tokyo-night",
  "gruvbox",
  "catppuccin-latte",
] as const;
const MODEL = { id: "claude-opus-5-5", display_name: "Opus 5.5" };
// Wide enough that no row soft-wraps: each line is one row of the bar.
const WIDE = 1000;

// ─── The schemes ─────────────────────────────────────────────────────────────

// The bundled helper's fold: unknown 0, low 1 … max 5.
const ORDINAL =
  '{{ $ord := default 0 (get (dict "low" 1 "medium" 2 "high" 3 "xhigh" 4 "max" 5) .effort.level) }}';
const GLYPH = '(index (splitList " " .effort.glyphs) $ord)';
const BRAIN_LADDER = "? \u{F0143} \u{F0143} \u{F013F} \u{F0DBC} \u{F09D1}";
const legible = (colour: string, on: string): string =>
  `readableOn ${colour} ${on} ${TEXT_MIN_CONTRAST}`;

// The shared base: low quiet, medium through xhigh full accent (floored
// legible, a no-op on dark cells), max the colour each scheme names.
const flat = (max: string): string =>
  `ramp $ord "step" 0 (${QUIET_TEXT}) 2 (${legible('(color "accent")', "(bgOf)")}) 5 (${max})`;

const plainGauge = (max: string): string =>
  `${ORDINAL}{{ fg (${flat(max)}) ${GLYPH} }}`;

// A rounded chip under the glyph at max, `pct` of the way from the cell's
// background to accent. The fill is the cell's own background below max and
// the caps are empty strings there, so every level runs the same operations
// and only max shows a chip. The glyph is accent floored legible on the chip,
// which on a light chip is accent's own dark tone.
const chipGauge = (pct: number): string =>
  ORDINAL +
  `{{ $chip := ramp $ord "step" 0 (bgOf) 5 (mix (bgOf) (color "accent") ${pct}) }}` +
  '{{ $left := index (list "" "" "" "" "" "\u{E0B6}") $ord }}' +
  '{{ $right := index (list "" "" "" "" "" "\u{E0B4}") $ord }}' +
  "{{ fg $chip $left }}" +
  `{{ bg $chip (fg (${flat(legible('(color "accent")', "$chip"))}) ${GLYPH}) }}` +
  "{{ fg $chip $right }}";

interface Scheme {
  readonly name: string;
  readonly note: string;
  readonly config: Record<string, unknown>;
}

const SCHEMES: readonly Scheme[] = [
  {
    name: "current",
    note: "the bundled default today: a quiet→accent ramp, max on a solid accent fill",
    config: {},
  },
  {
    name: "primary",
    note: "max: the triple chevron in the theme's primary",
    config: {
      helpers: {
        effortGauge: plainGauge(legible('(color "primary")', "(bgOf)")),
      },
    },
  },
  {
    name: "brain",
    note: "max: a brain in the theme's primary",
    config: {
      variables: { "effort.glyphs": { kind: "literal", value: BRAIN_LADDER } },
      helpers: {
        effortGauge: plainGauge(legible('(color "primary")', "(bgOf)")),
      },
    },
  },
  {
    name: "chip",
    note: "max: the triple chevron on a soft rounded chip of the cell's own hue",
    config: { helpers: { effortGauge: chipGauge(40) } },
  },
  {
    name: "pill",
    note: "max: the triple chevron on a bright rounded pill, in the hue's dark tone",
    config: { helpers: { effortGauge: chipGauge(85) } },
  },
  {
    name: "glow",
    note: "max: the whole model cell lights up toward accent",
    config: {
      helpers: {
        effortGauge: plainGauge(legible('(color "accent")', "(bgOf)")),
      },
      segments: {
        model: {
          bg: `${ORDINAL}{{ ramp $ord "step" 0 (tint) 5 (mix (tint) (color "accent") 40) }}`,
        },
      },
    },
  },
];

// The bundled status row leads with the model cell. A row holding only that
// cell, or that cell and its first neighbours, keeps every tint: the default
// placement reads a cell's index, never its sibling count.
const statusRow = (...cells: string[]): Record<string, unknown> => ({
  root: { rows: { status: { h: ["model", ...cells] } } },
});
const ALONE = statusRow();
const IN_PLACE = statusRow("context", "cacheTimer");

// ─── Rendering ───────────────────────────────────────────────────────────────

const visible = (s: string): string => s.replace(INVISIBLE, "");

// [LAW:parse-dont-validate] argv becomes theme names the daemon can resolve,
// or the demo stops naming the ones it cannot.
type Themes = readonly [string, ...string[]];

function themesOf(argv: readonly string[]): Themes {
  const known = new Set(listResolvablePaletteNames());
  const [head, ...tail] = argv;
  const asked: Themes = head === undefined ? DEFAULT_THEMES : [head, ...tail];
  const unknown = asked.filter((t) => !known.has(t));
  if (unknown.length > 0) {
    throw new Error(
      `unknown theme${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")} (known: ${[...known].join(", ")})`,
    );
  }
  return asked;
}

// The rendered row that holds the model cell, every other row dropped.
function modelRow(
  prepared: PreparedConfig,
  theme: string,
  level: string,
  label: string,
): string {
  const effective = resolveEffectiveGlobals(
    prepared.config,
    (key) => (key === "theme" ? theme : null),
    () => false,
  );
  const report = (what: string, message: string): void =>
    void process.stderr.write(
      `${label} ${theme} ${level}: ${what}: ${message}\n`,
    );
  const rendered = renderDsl(
    prepared.config,
    prepared.compiled,
    prepared.store,
    prepared.registry,
    {
      ...checkPayload(effective, prepared.configPath),
      model: MODEL,
      effort: { level },
    },
    renderOptionsOf(effective, WIDE),
    {
      onSegmentError: (id: string, message: string) =>
        report(`segment "${id}"`, message),
      onRenderWarning: (message: string) => report("theme rule", message),
    },
    renderSelectionOf(effective),
  );
  const row = rendered
    .split("\n")
    .find((line) => visible(line).includes(MODEL.display_name));
  if (row === undefined) {
    throw new Error(
      `${label} ${theme} ${level}: no rendered row holds the model cell`,
    );
  }
  return row;
}

async function prepare(
  dir: string,
  name: string,
  config: Record<string, unknown>,
): Promise<PreparedConfig> {
  const file = join(dir, `${name.replace(/\W+/g, "-")}.json5`);
  writeFileSync(file, JSON.stringify(config, null, 2));
  const warnings: string[] = [];
  const result = await prepareConfig(file, process.cwd(), warnings);
  for (const w of warnings) process.stderr.write(`${name}: warning: ${w}\n`);
  return result;
}

const pad = (s: string, width: number): string =>
  s + " ".repeat(Math.max(0, width - cellLen(visible(s))));

// Each scheme loaded twice: once with the model cell alone in its row (the
// grid), once beside its bundled neighbours (the in-place check at max).
interface Loaded {
  readonly scheme: Scheme;
  readonly cell: PreparedConfig;
  readonly bar: PreparedConfig;
}

function report(loaded: readonly Loaded[], themes: Themes): string {
  const label = Math.max(...loaded.map(({ scheme }) => scheme.name.length)) + 3;
  const out: string[] = [
    "",
    "  Effort gauge schemes. Every row but the first shares low quiet, medium–xhigh accent.",
    "",
    ...loaded.map(({ scheme }) => `  ${pad(scheme.name, label)}${scheme.note}`),
  ];
  for (const theme of themes) {
    const rows = loaded.map(({ scheme, cell }) => ({
      name: scheme.name,
      cells: LEVELS.map((level) => modelRow(cell, theme, level, scheme.name)),
    }));
    const column =
      Math.max(
        ...rows.flatMap(({ cells }) => cells.map((c) => cellLen(visible(c)))),
      ) + 2;
    out.push(
      "",
      `  ${theme}`,
      `  ${pad("", label)}${LEVELS.map((l) => pad(l, column)).join("")}`,
      ...rows.map(
        ({ name, cells }) =>
          `  ${pad(name, label)}${cells.map((c) => pad(c, column)).join("")}`,
      ),
    );
  }
  const [first] = themes;
  out.push(
    "",
    `  max, beside its neighbours — ${first}`,
    ...loaded.map(
      ({ scheme, bar }) =>
        `  ${pad(scheme.name, label)}${modelRow(bar, first, "max", scheme.name)}`,
    ),
    "",
  );
  return out.join("\n") + "\n";
}

async function main(): Promise<void> {
  const themes = themesOf(process.argv.slice(2));
  const dir = mkdtempSync(join(tmpdir(), "cc-candybar-effort-demo-"));
  const loaded: Loaded[] = [];
  try {
    for (const scheme of SCHEMES) {
      loaded.push({
        scheme,
        cell: await prepare(dir, `${scheme.name}-cell`, {
          ...scheme.config,
          ...ALONE,
        }),
        bar: await prepare(dir, `${scheme.name}-bar`, {
          ...scheme.config,
          ...IN_PLACE,
        }),
      });
    }
    process.stdout.write(report(loaded, themes));
  } finally {
    for (const { cell, bar } of loaded) {
      cell.registry.dispose();
      bar.registry.dispose();
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

await main();
