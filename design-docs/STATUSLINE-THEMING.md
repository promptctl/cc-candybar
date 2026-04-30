# Statusline Theming Redesign

**Status**: ON HOLD. Pending the rich-js architectural primitives below. Resume design when the Strip+Joiner, FlexStrip, renderToString, and markup-tag-plugin tickets land.

## Why we're rewriting

Today's `ColorTheme` model in `src/themes.ts` is a flat `{ segmentName: { fg, bg } }` map per theme. Every theme is hand-curated. There are 5 themes (`dark`, `light`, `nord`, `tokyo-night`, `rose-pine`) plus a `custom` escape hatch.

This doesn't scale or compose:

- **Each new theme** requires hand-picking an fg+bg pair for every segment. Adding the 13 themes from `cc-dump/docs/THEME_VARIABLE_COMPARISON.md` (atom-one-dark/light, catppuccin-latte/mocha, dracula, flexoki, gruvbox, monokai, rose-pine-{dawn,moon}, solarized-{dark,light}, textual-{ansi,dark,light}) means 13 new × ~10 segments = 130 hand-picked color pairs.
- **No semantic structure**: there's no concept of "primary," "accent," "error," "muted." Each segment color is opaque. If you want to add a "the active segment uses the theme's accent color" rule, there's nowhere to express it.
- **No composition**: you can't say "use the gruvbox palette for segments, but the panel border should pull from solarized." Themes are atomic.
- **Monotone risk**: a theme that's well-curated for one segment can look flat across a row of segments because there's no policy for "make segments visually distinguishable from each other."

The Textual ecosystem (Python) solved this with a richer model: each theme is a **palette** of ~150 named semantic variables (`primary`, `accent`, `error`, `panel`, `surface`, `background`, `foreground`, plus modifiers like `accent-darken-3` and `auto 33%` for contrast). The 18 themes in the cc-dump file are exactly this shape.

We want to adopt it.

## Three-layer model

The redesign separates three concerns that today's monolithic `ColorTheme` conflates:

```
┌──────────────────────────────────────────────────────────────────────┐
│  1. PALETTE (data — lives in rich-js)                                │
│  Textual-style hex map: 150 named variables → hex                    │
│  Stable, sharable, 1:1 with upstream Textual themes                  │
│  e.g., gruvbox: { background: "#282828", primary: "#85A598", ... }   │
└──────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────────────┐
│  2. PALETTE MAPPING (policy — lives in claude-powerline)             │
│  Per-segment rule: which palette variable each segment uses          │
│  e.g., directory.bg = "primary-background"                           │
│       git.bg       = "success-muted"                                 │
│       model.bg     = "accent"                                        │
│  This layer is what prevents monotone output: the mapping picks      │
│  *different* variables for different segments, so even a single      │
│  palette already produces a varied bar.                              │
└──────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────────────┐
│  3. CASCADE (override — lives in user config)                        │
│  User config can override per-segment mappings, or point a           │
│  segment at a *different palette* entirely.                          │
│  e.g., `git.bg = "warning"` (replaces default)                       │
│  e.g., `panel.palette = "monokai"` (different theme for one slot)    │
└──────────────────────────────────────────────────────────────────────┘
```

**"Per-segment theming"** = layer 2 (the PaletteMapping itself).
**"Composing multiple themes"** = layer 3 cascade, where individual segments can pick a different palette.
**"Not monotone"** = layer 2 picks varied palette variables across segments.

## Concrete API sketches

### Layer 1 — Palette (rich-js)

```typescript
interface Palette {
  readonly name: string;            // "gruvbox" | "tokyo-night" | ...
  readonly dark: boolean;           // hint for terminal ref color
  readonly vars: ReadonlyMap<string, string>;  // var name → hex (with optional alpha)
}

class PaletteResolver {
  constructor(readonly palette: Palette);

  // Resolves "primary" | "primary-darken-3" | "primary 50%" | "auto 33%"
  // Returns hex string; null if the variable doesn't exist and isn't derivable.
  resolve(spec: string, ctx?: { against?: string }): string | null;
}

// Built-in palettes loaded from JSON resources:
function getPalette(name: string): Palette | null;
function listPalettes(): readonly string[];
```

### Layer 2 — PaletteMapping (claude-powerline)

```typescript
interface SegmentColors {
  bg: string;  // palette variable spec — "primary-background", "accent", "warning 80%", etc.
  fg: string;
}

type PaletteMapping = Record<string /* segment name */, SegmentColors>;

const defaultMapping: PaletteMapping = {
  directory:   { bg: "primary-background",  fg: "foreground" },
  git:         { bg: "success-muted",       fg: "foreground" },
  gitTaculous: { bg: "success-muted",       fg: "foreground" },
  model:       { bg: "accent",              fg: "button-color-foreground" },
  session:     { bg: "panel",               fg: "footer-foreground" },
  context:     { bg: "boost",               fg: "foreground" },
  block:       { bg: "warning-muted",       fg: "foreground" },
  today:       { bg: "secondary",           fg: "footer-foreground" },
  // ...
};
```

### Layer 3 — Cascade (config loader)

User config can override at three granularities:

```jsonc
{
  "theme": {
    "palette": "gruvbox",                           // base palette for everything
    "mapping": {
      "git": { "bg": "warning" },                   // override single property
      "block": { "bg": "error", "fg": "foreground" }, // override both
      "panel": {                                    // pull from a different palette
        "palette": "monokai",
        "bg": "primary",
        "fg": "foreground"
      }
    }
  }
}
```

The config loader merges: **default palette → default mapping → user palette → user mapping**, in cascade order. Per-segment palette override is a special case in the merge (the segment's resolver uses a different `Palette` instance).

## Open questions (unresolved — answer at design-resume time)

### 1. Variable spec language

How rich is the spec string?

| Form | Example | Required? |
|---|---|---|
| Bare var name | `"primary"` | Yes |
| Modifiers | `"primary-darken-3"`, `"accent-lighten-2"` | Probably yes — Textual data uses these |
| Alpha | `"primary 50%"` | Probably yes — Textual data uses these |
| Auto-contrast | `"auto 33%"` | ⚠️ adds context-dependence (see Q2) |

Recommendation: support what Textual's data already encodes, no more. So all four. Implementing `auto N%` requires resolver context.

### 2. Auto-contrast resolution context

Textual themes use `auto NN%` to mean "contrast color against the active background, with NN% alpha." Implementing this means the resolver needs to know what background the result is being painted on top of.

API options:
- **Pass context per-resolve**: `resolver.resolve("auto 33%", { against: "#282828" })`. Caller must know the current bg.
- **Stateful resolver**: `resolver.withBackground(bg).resolve("auto 33%")`. Returns a per-bg sub-resolver. Cleaner for batch.
- **Pre-compute auto-contrast at palette-load time**: every palette stores an `auto-against-background` precomputed value. Loses generality but covers the common case.

Recommendation: per-resolve context (option 1). Most explicit, no hidden state, no precompute traps.

### 3. Light vs dark — separate palettes or a flag?

Today: `theme: "dark" | "light"` is a top-level switch.

Textual: each named theme has a `dark: boolean`. Some themes ship pairs (`solarized-dark` / `solarized-light`); others are single-mode.

Options:
- **Flag**: a single `Palette` has a `dark` boolean; renderer uses it to pick `auto`-contrast direction.
- **Pairs**: each theme name is either a single palette or a `{light, dark}` pair; user selects mode.
- **Just-pick-one**: don't model light/dark; user names the specific palette they want (`gruvbox`, `solarized-dark`, `solarized-light`).

Recommendation: option 3. The Textual data already separates them by name where meaningful. We don't need a higher-level light/dark abstraction.

### 4. Override granularity

Current cascade design: per-property override (`git.bg = "warning"` replaces only the bg, fg stays from default mapping).

Alternative: whole-segment replacement (overriding `git` requires specifying both bg and fg).

Recommendation: per-property. Less verbose for common case (just change the bg of one segment).

### 5. Composition — per-segment palette pull

Should a segment be able to declare its own palette source?

Use case: "I want gruvbox for segments but my panel border is from a different palette I like better." A user could say `panel.palette = "monokai"` and the panel pulls its colors from the monokai palette while everything else stays gruvbox.

Recommendation: yes — small change, useful for power users, doesn't complicate the common case (the field is optional).

### 6. Variant states (status: clean/dirty/conflicts)

Today, the git segment hard-codes color-tinting based on status (clean = green-ish, dirty = yellow-ish, conflicts = red-ish). Under the new model, where does this live?

Options:
- **In the segment**: segment renderer gets a Palette and picks `success`/`warning`/`error` itself based on internal state.
- **In the mapping**: `git: { bg: { default: "success-muted", dirty: "warning-muted", conflicts: "error-muted" } }`. Adds complexity to the mapping schema but lets users theme variants.
- **In the renderer**: a "stateful color picker" hook that segments declare.

Recommendation: option 1 for now (in the segment). Variant theming via mapping is a nice-to-have, not a must.

## Hard constraints the design must satisfy

- **Color compatibility**: must continue to support `colorCompatibility: "auto" | "truecolor" | "256" | "ansi" | "none"`. The Palette resolves to a hex; the renderer downgrades. (rich-js's `Color.downgrade(ColorSystem)` handles this.)
- **Custom themes**: user can still define their own palette inline (via config) without authoring an external file. Current `theme: "custom"` escape hatch needs an analogue.
- **No regression** on existing theme names: `dark`, `light`, `nord`, `tokyo-night`, `rose-pine` must continue to work, even if their implementation changes from "static color map" to "named palette + default mapping." Visually equivalent.
- **TUI mode parity**: the TUI panel layout must theme correctly under the new model. Likely uses the same palette + a `tui.*` section of the mapping (panel border, header bg, content fg).
- **Composes with Strip + Joiner**: the renderer assigns each segment a single `Style` (one bg, one fg) computed from the resolved palette colors. That style flows into the strip-and-joiner pipeline unchanged.

## Out of scope (explicit deferrals)

- **Animated themes** / time-of-day shifts. Not modeled.
- **Per-machine palette overrides**. Config covers it; no special API.
- **Programmatic palette construction at runtime**. Palettes are loaded from data; if you want a procedural palette, you write a JSON.
- **Cross-project palette sharing as a first-class feature**. Today the palettes live in rich-js; if a third project wants them, they import rich-js. No npm-level palette package needed yet.

## Dependencies

This work is **on hold pending**:

- `rich-strip-joiner-duc` — Strip + Joiner abstraction (rich-js)
- `rich-strip-joiner-duc.1` — core implementation (rich-js)
- `rich-flex-strip-a0l` — FlexStrip wrap-to-width (rich-js)
- `rich-render-to-string-dag` — renderToString stateless emission (rich-js)
- `rich-markup-tag-plugins-cqf` — markup tag plugins (rich-js)

Once those land in rich-js, claude-powerline's renderer can be rebuilt on top of them. At that point, the theming redesign becomes the natural next step — the new renderer will need to assign per-segment styles, and a Palette-driven mapping is how it does that.

## Reference

- `cc-dump/docs/THEME_VARIABLE_COMPARISON.md` — the 18 Textual themes × 151 variables in tabular form. The data source for layer 1.
- Textual upstream theme system: https://textual.textualize.io/guide/design/ (for spec language semantics if we adopt them).
- Existing `src/themes.ts` — the model being replaced.
