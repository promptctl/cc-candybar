# claude-powerline's layout engine, against cc-candybar's

## The mechanism

claude-powerline renders a statusline by string concatenation, in one class: `PowerlineRenderer`
(`src/powerline.ts`). There is no layout tree, no cell type, and no measured composition — the unit
is `RenderedSegment`, a record of `{ type, text, bgColor, fgColor, bold }` where `bgColor`/`fgColor`
are already-built ANSI escape strings rather than colours.

**Composition.** The config declares `display.lines`, an array of line configs, each holding a
`segments` object keyed by segment type. `renderLine` filters that object to the entries with
`enabled: true`, renders each to a `RenderedSegment` (or `null`, which drops it), and
`buildLineFromSegments` concatenates them. `generateStatusline` renders every configured line
in parallel, discards the empty ones, and joins the rest with `\n`. Configured lines are the only
vertical structure; there is no nesting, and a line's segment order is the key order of a JSON
object.

**Separators and caps.** `formatSegment` is the whole joiner. For a powerline line it emits
`bg + fg + bold + padding + text + padding + reset`, then one glyph: painted in the *next*
segment's background with the *current* segment's background as its foreground, so the colour
bleeds rightward across the seam. The trailing glyph on the last segment is painted over the
terminal default instead. The "foreground version of a background" is
`extractBgToFg` (`src/utils/colors.ts`), which does it textually — it regex-matches `48;2;r;g;b`
out of the escape string and re-emits it as `38;2;r;g;b`, with fallbacks that map basic
`40–47`/`100–107` down by ten and, failing everything, `.replace("48", "38")`. Capsule style paints
both caps from the segment's own background and inserts a literal space between segments; minimal
style sets the separator glyph to `""`, so segments abut and only the background change marks the
boundary. There is no same-background disambiguation — no thin `U+E0B1` separator, no elision when
a segment has no background to bleed.

**Width fitting.** `display.autoWrap` (default true) routes rendering through
`generateAutoWrapStatusline`, a greedy pack: for each configured line, walk its rendered segments,
add `calculateSegmentWidth` to a running total, and when the next segment would cross the terminal
width, flush the accumulated segments as a finished line and start a new one with that segment.
Each flushed line goes through the same `buildLineFromSegments`, so caps re-fire at every break and
a wrapped line looks like a line. The budget is `visibleLength(text) + 1 + 2×padding` for powerline
and `+ 2 + 2×padding + (isFirst ? 0 : 1)` for capsule. A segment wider than the terminal is
emitted anyway, on a line of its own. With `autoWrap: false` no width fitting happens at all and
the terminal soft-wraps the line.

**Truncation and priority: not present in the statusline path.** Nothing in the powerline renderer
truncates, ellipsizes, or ranks segments. Grepping `src/` for `truncat|ellips|priority|overflow`
outside `src/tui/` finds exactly one hit, and it is a re-export of the TUI's own clip helper from the
browser entry point. Overflow is reflow, and only reflow. Truncation exists in the *other* renderer — `display.style: "tui"`, which draws a boxed
panel rather than a bar — as `truncateAnsi` (`src/tui/primitives.ts`), an ANSI-aware clip that
copies escape sequences through, counts only printable characters, and appends `…\x1b[0m` at the
cut. Right-side only, no marker choice, no left or middle mode.

**The one engine with a layout algorithm** is that TUI path's grid (`src/tui/grid.ts`), and it is a
small CSS Grid. A `TuiGridConfig` declares `breakpoints: TuiGridBreakpoint[]`, each
`{ minWidth, areas, columns, align }`, where `areas` is an array of strings naming a segment per
cell — `parseAreas` splits on whitespace and turns runs of the same name into a span, exactly like
`grid-template-areas`. `selectBreakpoint` picks the breakpoint with the largest `minWidth` that the
available width clears, falling back to the smallest. `cullMatrix` then removes what has no data:
cells whose segment resolved empty become `.`, spans are recomputed, all-empty rows are dropped,
and adjacent, leading and trailing `---` divider rows collapse. `calculateColumnWidths` sizes
columns from `columns` entries that are `auto` (widest content in that column), a fixed integer, or
`Nfr` (a share of whatever is left, with the integer remainder handed out one column at a time).
`solveFitContentLayout` is the same solver run backwards to derive a panel width from content.
Finally `renderGrid` takes a `lateResolve` callback and, once column widths are known, re-renders
the segments whose content depends on their own cell width — the context/block/weekly progress
bars, listed in `LATE_RESOLVE_SEGMENTS` — then re-culls, because a late-resolved segment can come
back empty. Rows are truncated and padded to the content width and wrapped in box characters.

**Theme to segment.** `getThemeColors` flattens the selected `ColorTheme` into `PowerlineColors`, a
flat record of hand-written `modeBg`/`modeFg`/`modeBold`/`gitBg`/… fields — three per segment type,
fifty-four in all — converting each hex through `convertHex`, whose arm is chosen by the resolved
colour support. Getting from a segment type back to its colours is then a hand-written `switch`:
`getSegmentBgColor` and `getSegmentBoldFlag` each have one `case` per segment type and a `default`
that returns the directory colour. Depth downsampling is partly *authored*: `getTheme(name,
colorSupport)` looks for a `${name}-ansi256` or `${name}-ansi` sibling in `BUILT_IN_THEMES` and
prefers it, so six themes ship eighteen hand-tuned tables. Where no variant exists, `hexTo256Ansi`
quantizes to the 6×6×6 cube and `hexToBasicAnsi` picks a basic colour by dominant channel — and
returns `""` for every background, so in `ansi` mode segments lose their fills and the powerline
glyph has no colour to carry.

Two incidental details in the TUI renderer are worth naming because they are about Claude Code
rather than about layout: the panel is wrapped in DEC private mode 2026 (synchronized output) to
stop multi-line renders tearing, and every line is prefixed with a no-op `\x1b[0m` because Claude
Code strips leading spaces from a statusline row but not leading escape sequences.

## Evidence

Paths are relative to the `claude-powerline` checkout root (`/tmp/peer3/claude-powerline-layout`, at
`package.json` version `1.30.3`).

| Fact | Path | Lines | Excerpt |
|---|---|---|---|
| The powerline separator is painted in the next segment's bg with the current segment's bg as fg; the last one bleeds over the terminal default | `src/powerline.ts` | 1062-1067 | `    if (nextBgColor) {`<br>`      const arrowFgColor = extractBgToFg(bgColor, isBasicMode);`<br>``      output += `${colors.reset}${nextBgColor}${arrowFgColor}${this.symbols.right}`;``<br>`    } else {`<br>``      output += `${colors.reset}${extractBgToFg(bgColor, isBasicMode)}${this.symbols.right}${colors.reset}`;``<br>`    }` |
| "Background as foreground" is a textual rewrite of the SGR parameters, not a colour operation | `src/utils/colors.ts` | 23-26 | `  const truecolorMatch = ansiCode.match(/48;2;(\d+);(\d+);(\d+)/);`<br>`  if (truecolorMatch) {`<br>``    return `\x1b[38;2;${truecolorMatch[1]};${truecolorMatch[2]};${truecolorMatch[3]}m`;``<br>`  }` |
| Capsule style paints both caps from the segment's own background | `src/powerline.ts` | 1045-1051 | `      const capFgColor = extractBgToFg(bgColor, isBasicMode);`<br>``      const leftCap = `${capFgColor}${this.symbols.left}${colors.reset}`;``<br>``      const content = `${bgColor}${fgColor}${boldOn}${padding}${text}${padding}${boldOff}${colors.reset}`;``<br>``      const rightCap = `${capFgColor}${this.symbols.right}${colors.reset}`;`` |
| Style selects the glyph vocabulary, and minimal means an empty separator | `src/powerline.ts` | 741-746 | `      right: isMinimalStyle`<br>`        ? ""`<br>`        : isCapsuleStyle`<br>`          ? symbolSet.right_rounded`<br>`          : symbolSet.right,`<br>`      left: isCapsuleStyle ? symbolSet.left_rounded : "",` |
| Width fitting is a greedy pack that breaks *before* an overflowing segment, never inside one | `src/powerline.ts` | 287-300 | `        if (`<br>`          currentLineSegments.length > 0 &&`<br>`          currentLineWidth + segmentWidth > terminalWidth`<br>`        ) {`<br>`          outputLines.push(`<br>`            this.buildLineFromSegments(currentLineSegments, colors),`<br>`          );`<br>`          currentLineSegments = [];`<br>`          currentLineWidth = 0;`<br>`        }`<br>`        currentLineSegments.push(segment);`<br>`        currentLineWidth += segmentWidth;` |
| The per-segment budget adds the joiner and padding overhead by style | `src/powerline.ts` | 401-412 | `    const isCapsuleStyle = this.config.display.style === "capsule";`<br>`    const textWidth = visibleLength(segment.text);`<br>`    const padding = this.config.display.padding ?? 1;`<br>`    const paddingWidth = padding * 2;`<br>`    if (isCapsuleStyle) {`<br>`      const capsuleOverhead = 2 + paddingWidth + (isFirst ? 0 : 1);`<br>`      return textWidth + capsuleOverhead;`<br>`    }`<br>`    const powerlineOverhead = 1 + paddingWidth;`<br>`    return textWidth + powerlineOverhead;` |
| Width is measured as UTF-16 code units of the ANSI-stripped string, not display cells | `src/utils/terminal.ts` | 9-11 | `export function visibleLength(str: string): number {`<br>`  return stripAnsi(str).length;`<br>`}` |
| Multi-line composition is the configured lines joined with `\n`; there is no nesting | `src/powerline.ts` | 201-216 | `    const lines = await Promise.all(`<br>`      this.config.display.lines.map((lineConfig) =>`<br>`        this.renderLine(` … `    return lines.filter((line) => line.length > 0).join("\n");` |
| 45 columns are reserved for Claude Code's right-side UI | `src/utils/terminal-width.ts` | 80-87 | `/**`<br>` * @info Reserves characters for Claude Code's right-side UI messages`<br>` * (e.g., "Current: 2.1.78 · latest: 2.1.78", "Thinking off")`<br>` */`<br>`const RESERVED_CHARS = 45;`<br>`export function getTerminalWidth(): number | null {`<br>`  const applyReserve = (w: number) => Math.max(1, w - RESERVED_CHARS);` |
| The only truncation in the codebase lives in the TUI primitives: right-side only, fixed `…` marker | `src/tui/primitives.ts` | 61-65 | `    for (const char of part) {`<br>`      if (width >= maxWidth - 1) {`<br>`        result += "…\x1b[0m";`<br>`        return result;`<br>`      }` |
| …and it is imported only by the TUI panel, never by the powerline path | `src/tui/grid.ts` | 9 | `import { truncateAnsi, padRight, padLeft, padCenter } from "./primitives";` |
| …and the only mention of it outside `src/tui/` is a re-export, under a "TUI components" heading | `src/browser.ts` | 147-156 | `// --- TUI components ---`<br>`export {`<br>`  contentRow,`<br>`  bottomBorder,`<br>`  divider,`<br>`  spreadEven,`<br>`  spreadTwo,`<br>`  colorize,`<br>`  truncateAnsi,` |
| The TUI grid selects a layout by width: largest `minWidth` that the available width clears | `src/tui/grid.ts` | 69-80 | `export function selectBreakpoint(`<br>`  breakpoints: TuiGridBreakpoint[],`<br>`  panelWidth: number,`<br>`): TuiGridBreakpoint {`<br>`  let best: TuiGridBreakpoint \| undefined;`<br>`  for (const bp of breakpoints) {`<br>`    if (panelWidth >= bp.minWidth) {`<br>`      if (!best \|\| bp.minWidth > best.minWidth) {`<br>`        best = bp;`<br>`      }`<br>`    }`<br>`  }` |
| Breakpoint selection runs against terminal width minus a configurable reserve | `src/tui/grid.ts` | 492-498 | `  // Breakpoint selection always uses available width (terminal - reserve)`<br>`  const widthReserve = gridConfig.widthReserve ?? 45;`<br>`  const availableWidth = Math.min(`<br>`    maxWidth,`<br>`    Math.max(minWidth, rawTerminalWidth - widthReserve),`<br>`  );`<br>`  const bp = selectBreakpoint(gridConfig.breakpoints, availableWidth);` |
| `Nfr` columns split the leftover width, remainder distributed one column at a time | `src/tui/grid.ts` | 295-316 | `  let totalFr = 0;`<br>`  for (const colDef of columns) totalFr += parseFr(colDef);`<br>`  if (totalFr > 0) {`<br>`    const perFr = remaining / totalFr;` … `    let leftover = remaining - allocatedFr;`<br>`    for (let k = 0; leftover > 0 && k < frCols.length; k++) {`<br>`      widths[frCols[k]!]! += 1;`<br>`      leftover--;`<br>`    }`<br>`  }` |
| Width-dependent segments are re-rendered after column widths are solved | `src/tui/grid.ts` | 668-676 | `        const cellWidth = spanCellWidth(colWidths, i, cell.spanSize, sepWidth);`<br>`        const innerPad = spanInnerPad(i, cell.spanSize);`<br>`        const content = lateResolve(cell.segment, cellWidth + innerPad);`<br>`        if (content !== undefined) {`<br>`          resolvedData[cell.segment] = content;`<br>`        }` |
| …and the progress bars are what consumes the resolved cell width | `src/tui/renderer.ts` | 116-121 | `      if (segment === "context") {`<br>`        return buildContextLine(data, cellWidth, sym, reset, colors) ?? "";`<br>`      }`<br>`      if (segment === "context.bar") {`<br>`        return buildContextBar(data, cellWidth, sym, reset, colors, pf);`<br>`      }` |
| A cell with no data becomes empty, and its row can then disappear entirely | `src/tui/grid.ts` | 148-153 | `      if (cell.segment === EMPTY_CELL \|\| cell.segment === DIVIDER) return cell;`<br>`      const data = resolvedData[cell.segment];`<br>`      if (!data) {`<br>`        return { segment: EMPTY_CELL, spanStart: true, spanSize: 1 };`<br>`      }` |
| Theme → segment colours is a hand-written switch per segment type, defaulting to the directory colour | `src/powerline.ts` | 944-949, 978-980 | `    switch (segmentType) {`<br>`      case "directory":`<br>`        return colors.modeBg;`<br>`      case "git":`<br>`        return colors.gitBg;` … `      default:`<br>`        return colors.modeBg;` |
| Colour depth is served by hand-authored per-depth theme variants | `src/themes/index.ts` | 130-138 | `  if (colorSupport === "none" \|\| colorSupport === "ansi") {`<br>``    const ansiVariant = BUILT_IN_THEMES[`${themeName}-ansi`];``<br>`    if (ansiVariant) return ansiVariant;`<br>`  }`<br>`  if (colorSupport === "ansi256") {`<br>``    const ansi256Variant = BUILT_IN_THEMES[`${themeName}-ansi256`];``<br>`    if (ansi256Variant) return ansi256Variant;`<br>`  }` |
| In `ansi` mode every background is dropped, so the separator has no colour to carry | `src/utils/colors.ts` | 88-90 | `  if (isBackground) {`<br>`    return "";`<br>`  }` |
| The TUI panel wraps itself in synchronized output and guards leading whitespace | `src/tui/renderer.ts` | 26-34 | `// Synchronized Output (DEC mode 2026): prevents tearing on multi-line renders.`<br>`// Terminals that don't support it silently ignore these sequences.`<br>`const SYNC_START = "\x1b[?2026h";`<br>`const SYNC_END = "\x1b[?2026l";`<br>`// No-op ANSI reset prepended to each line to prevent leading whitespace stripping.`<br>`// Claude Code's status line renderer strips leading spaces, but ANSI sequences at the`<br>`// start of a line protect subsequent whitespace from being trimmed.`<br>`const WS_GUARD = "\x1b[0m";` |
| Licence | `LICENSE` | 1-3 | `MIT License`<br><br>`Copyright (c) 2025 Owloops` |

## What cc-candybar does today

Every axis the mechanism covers — composition, separators, width fitting, truncation, theming — is
already implemented in cc-candybar, each of them once, behind a type rather than behind string
concatenation.

**Composition.** `renderDsl` (`src/dsl/render.ts:670`) walks a `LayoutNode` tree to
`RenderedLines` — a list of lines of `RichText` cells — and serializes at the root only, one pass:
`renderNode(root, true, BAR_ROOT).map((line) => renderStripCells(line, opts)).join("\n")`
(lines 834-836). `composeBlocks` (`src/dsl/node-registry.ts:233`) is the projection: `vertical`
concatenates child line-lists, `horizontal` zips row 0 across the seam and stacks every deeper line
as a full-width drop. Nesting is arbitrary, which is what makes a dropped menu body a layout fact
rather than a special case. `splitCellsIntoLines` (`src/render/split-lines.ts:31`) is the one place
a `\n` in cell text becomes a line boundary, and its header states why: a `\n` reaching a
horizontal strip is a zero-width lie that corrupts wrap math and background fill. claude-powerline's
`\n`-joined configured lines are cc-candybar's `direction: "vertical"` with one level of nesting and
no drops.

**Separators.** `pickJoiner` (`src/render/strip.ts:112`) picks the joiner *class* from
`globals.style` and indexes the glyph options by `globals.charset`, and the switch is total over
`StripStyle` with a `never` default, so adding a style is a compile error until it has a joiner. The
paint rule in rich-js's `PowerlineJoiner` is the same one claude-powerline implements — separator in
the left edge's bg over the right edge's bg — with one case claude-powerline lacks: a left edge with
no paintable background (absent, or the terminal default) returns `EMPTY` rather than an uncoloured
glyph. Colour never crosses the seam as an escape string; it is a `Style` carrying hex, so there is
no textual `48`→`38` rewrite to go wrong.

**Width.** `applyClaudeCodeReserve` (`src/utils/terminal-width.ts:32`) is the single raw-to-usable
transform, and its reserve is 2, with a comment recording that "the older value of 45 was a guess
for a right-side overlay that does not sit on the statusline row" — claude-powerline's 45 is the
number cc-candybar already measured and rejected. The usable width feeds two consumers from one
value: `FlexStrip`'s wrap limit and the `term.cols` input variable injected in
`renderDsl` (line 693), declared in the bundled default at `src/config/default-dsl-config.ts:409`.
`FlexStrip` (rich-js) is the same greedy pack claude-powerline's `autoWrap` loop is, with the
end-cap width included in the fit test and caps re-fired at every break; an item wider than the
width is emitted on its own line, the same graceful overflow. Measurement is `cellLength` — real
display cells — not a code-unit count.

**Truncation.** `applySegmentLayout` (`src/template-engine/layout.ts:103`) already does what
claude-powerline's TUI does and more: a segment's `width` is `"auto"` or a fixed integer, over-width
content truncates in one of three modes (`right`/`left`/`middle`) with a configurable marker, and
under-width content aligns `left`/`center`/`right`. Because the cell type is `RichText`, every cut
is span-preserving, so OSC-8 click regions survive truncation — the header notes that the older
"truncation drops per-part fg" bug cannot be expressed in this shape.

**Theme to segment.** There is no per-segment colour table and no switch. `decorationFor` over a
node's `Region` deals a segment its tint, its text colour and the disclosure band it opens from one
read (`src/dsl/render.ts:754`), the base palette is transposed by the session's look exactly once
per render (line 710), and an authored `bg:` is the discriminator between "this colour means
something" and "this cell is decorated". Depth downsampling is one `colorSystem` value threaded
into rich-js (`src/render/strip.ts:195`), not eighteen hand-tuned tables.

Where claude-powerline is ahead, it is ahead in two places only, and neither is the powerline strip.
Its per-depth theme variants are hand-tuned rather than algorithmically quantized, which can simply
look better at 256 colours and in 16 — at the cost of three tables per theme. And its grid has two
concepts cc-candybar has no equivalent for: width breakpoints that select a *different layout*, and
`fr` columns plus `lateResolve`, which let a cell be sized from the slack left over and its content
be rendered to that size.

## The change

**Do not lift the layout engine.** On composition, separators, wrap, truncation and theming,
cc-candybar's is the same mechanism expressed once at a higher level, and in three places
claude-powerline's version is measurably weaker: `visibleLength` counts UTF-16 code units so any
wide character mis-measures the wrap budget, the `48`→`38` string rewrite bottoms out in
`ansiCode.replace("48", "38")`, and the theme reaches a segment through three parallel
hand-written switches that a new segment type has to be added to in each. There is no priority or
truncation model to import, because the statusline path has neither. Lifting any of it would mean
replacing a typed, total, single-enforcer path with a string-concatenation one — a
`[LAW:one-source-of-truth]` and `[LAW:types-are-the-program]` regression in exchange for nothing
observable.

The breakpoint idea is also not worth a change, for a specific reason: cc-candybar can already
express it as data. `term.cols` is a declared input variable, so a width-conditional row is
`{ seg: "weekly", when: "{{ ge (int .term.cols) 100 }}" }` today, and a whole width-conditional
*arrangement* is a preset. A `breakpoints` block would be a second spelling of a `when` on a value
that already flows — the shape `[LAW:one-type-per-behavior]` exists to refuse.

**One idea is worth a ticket, and it is not from the powerline path.** cc-candybar has no way for a
segment to be sized from the row's leftover width. `SegmentLayoutOptions.width` is `"auto" | number`
(`src/template-engine/layout.ts:28`) — content-sized or authored, and neither value can see a
sibling — so a progress bar, a sparkline or a fill rule cannot stretch to the space actually left on
its row — the author has to hard-code a column count and accept it being wrong at
every other terminal width. claude-powerline's grid solves exactly this, with `fr` sizing plus a
`lateResolve` pass that re-renders the width-dependent cells once the widths are known
(`src/tui/grid.ts:668-676`).

Adapted into cc-candybar's terms, that is:

- `src/config/dsl-types.ts` — widen the segment's `readonly width?: "auto" | number` (line 685) to
  admit a third value. One new value in an existing field, not a new field, so it stays the same
  discriminator `[LAW:dataflow-not-control-flow]`.
- `src/config/loader/segments.ts` — `widthSpec()` (line 113) accepts it and its error text
  (`width must be "auto" or a positive integer`, line 124) names the new value, so a typo stays a
  load error rather than a silent `"auto"`.
- `src/template-engine/layout.ts` — `applySegmentLayout` grows an arm for it: a fill segment
  collapses and pads as today but defers sizing, returning its cell unsized with its intrinsic
  width known. The three-mode truncate and align code is untouched and is what does the final
  sizing.
- `src/dsl/node-registry.ts` — `composeBlocks`'s `horizontal` arm becomes the place row 0's slack
  is computed and handed to the fill cells: sum the non-fill cells' `cellLength`, subtract from the
  row budget, divide among the fill cells. This is the real cost — `composeBlocks` currently
  composes without measuring, and measuring means `stripChromeCols` and the joiner's mid-join
  widths enter the row-composition step, which today only `FlexStrip` knows about.
- `src/render/strip.ts` — `stripChromeCols` already declares the per-style cap cost; the row budget
  needs the mid-join cost too, which is the one genuinely new number.

The observable difference: a progress-bar segment declared `width: "fill"` occupies the rest of
its row at every terminal width, and shrinks rather than wraps when a sibling appears. Nothing
existing changes behaviour — `"auto"` and fixed widths keep their current code path.

If that lands, the bundled default's `context` segment is the obvious first consumer, which would
touch `src/config/default-dsl-config.ts`. That is a second ticket, not this one.

## Cost and risk

Lifting the layout engine costs nothing to decide against, and that is the recommendation.

The fill-width adaptation is the only proposal here, and its cost is concentrated in one place:
`composeBlocks` has to start measuring. Today row composition is width-blind and `FlexStrip` owns
every width question; giving `composeBlocks` a row budget puts a second width consumer inside the
walk, and the two must agree or a fill segment will size to a budget the strip then wraps.
The honest risk is that this is exactly the "two clocks" shape the codebase avoids elsewhere —
the mitigation is that `opts.width` and `stripChromeCols` are already single-enforcer values, so the
budget can be derived rather than re-measured, and a test that renders a fill row at several widths
and asserts no wrap pins the agreement.

What it makes harder later: a fill segment's width depends on its siblings, so the address-based
colour walk and the fill-sizing pass must stay in the order they are in — a segment can no longer
be rendered in isolation and be byte-identical to its slice of the row. `perSegmentSink` already
documents that per-segment serialization is not byte-identical to the joined line, so this is a
widening of an accepted limit rather than a new one. It also puts pressure on `width: "fill"`
appearing twice in a `horizontal` container with a drop, where "the row's leftover" needs a stated
answer (split evenly is the obvious one, and is what `fr` with equal shares does).

Doing nothing costs the status quo: authors hard-code bar widths and they are wrong off the
author's terminal.

## Licence verdict

The checkout's `LICENSE` names no SPDX identifier of its own; line 1 reads `MIT License` and the
body is the verbatim MIT text ("Permission is hereby granted, free of charge, to any person
obtaining a copy … subject to the following conditions"), with `package.json` line 39 stating
`"license": "MIT"`, so the SPDX identifier is **MIT**. Code may be copied with attribution, which
the maintainer's permissive-only rule allows — but nothing here is being copied: the recommendation
is against lifting the mechanism, and the one idea taken forward (slack-absorbing segment width) is
a concept, reimplemented against cc-candybar's own cell type.
