// [LAW:dataflow-not-control-flow] The fragment walk is unconditional: every
// fragment is visited; style.link (a value on the fragment) decides whether
// it becomes a cell or joiner content. No control-flow branching on "are
// there any cells" — variability lives entirely in the data.
//
// Cell-splitting algorithm per rich-js spec/template-bindings.md:
//   1. Iterate RichText[] left-to-right.
//   2. fragment.style.link truthy → emit as StripCell.
//   3. Otherwise → accumulate as joiner (inter-cell styled text).
//   4. Leading joiner fragments before a link cell are prepended to that cell.
//   5. The trailing joiner run (or the entire output if no links) coalesces
//      into cells, split at background-color changes — see coalescePlainRun.

import { StripCell, Style } from "@promptctl/rich-js";
import type { Span, StripCellPart, RichText } from "@promptctl/rich-js";

// [LAW:single-enforcer] The only place that maps RichText[] → StripCell[].
// All callers go through here; no second conversion path exists.
export function fragmentsToStripCells(fragments: RichText[]): StripCell[] {
  const cells: StripCell[] = [];
  // [LAW:dataflow-not-control-flow] Accumulate full RichText (not just plain
  // text) so joiner styling survives — style is data on the fragment, not a
  // side-channel that can be re-attached from the text string alone.
  let joiners: RichText[] = [];

  for (const fragment of fragments) {
    if (fragment.style.link) {
      cells.push(mergeThenConvert(joiners, fragment));
      joiners = [];
    } else {
      joiners.push(fragment);
    }
  }

  // [LAW:one-type-per-behavior] Plain fragments continue the current cell;
  // only a background change (or a link) starts a new one. Earlier runs are
  // absorbed into the link they precede (mergeThenConvert); this is the
  // terminal run, which has no following link to absorb it.
  cells.push(...coalescePlainRun(joiners));

  return cells;
}

// Convert a run of adjacent non-link fragments into cells.
//
// [LAW:one-source-of-truth] A StripCell carries exactly one joiner-visible
// background (its cell-level style); parts may not carry bgcolor per the
// single-style invariant. So the background is what defines a cell: the run is
// split into one cell per maximal sub-run of equal bgcolor. Foreground and
// attributes vary freely within a cell (as parts); a background change is a
// cell boundary. Empty (no plain text) fragments contribute nothing.
function coalescePlainRun(run: RichText[]): StripCell[] {
  const cells: StripCell[] = [];
  let group: RichText[] = [];

  const flush = () => {
    const cell = groupToCell(group);
    if (cell) cells.push(cell);
    group = [];
  };

  for (const frag of run) {
    if (!frag.plain) continue;
    if (group.length && frag.style.bgcolor !== group[0]!.style.bgcolor) flush();
    group.push(frag);
  }
  flush();

  return cells;
}

// Convert one background-homogeneous fragment group into a single cell.
//
// A single fragment defines the cell's dominant style wholesale (fg + bg at
// cell level, so both survive the later layout merge). Multiple fragments share
// only their background: it lives at cell level (joiner-visible), while each
// fragment's fg/attrs become part-level overlays with bgcolor stripped.
function groupToCell(group: RichText[]): StripCell | null {
  if (!group.length) return null;
  if (group.length === 1) return richTextToCell(group[0]!);

  const bgcolor = group[0]!.style.bgcolor;
  const cellStyle = bgcolor !== undefined ? new Style({ bgcolor }) : undefined;

  const parts: StripCellPart[] = [];
  let text = "";
  let anyStyle = false;

  for (const frag of group) {
    text += frag.plain;
    const base = stripBgcolor(frag.style);
    const fragParts: StripCellPart[] = frag.spans.length
      ? spansToStripCellParts(frag.plain, frag.spans, 0)
      : [{ text: frag.plain }];

    for (const part of fragParts) {
      // Inner span style (if any) wins over the fragment's wrapping style.
      const merged = part.style ? base.add(part.style) : base;
      const style = merged.isNull ? undefined : merged;
      if (style) anyStyle = true;
      parts.push({ text: part.text, style });
    }
  }

  // No fg/attrs anywhere → a plain cell (byte-identical to the single-cell path,
  // carrying only the shared background).
  return anyStyle
    ? new StripCell(parts, cellStyle)
    : new StripCell(text, cellStyle);
}

// Merge accumulated joiner fragments + a link-bearing fragment into one cell.
// The link fragment's style governs the cell level (carries link, fg, bg, attrs).
// Joiner text is prepended to the link fragment's text, sharing the cell style.
function mergeThenConvert(
  joiners: RichText[],
  linkFragment: RichText,
): StripCell {
  if (!joiners.length) return richTextToCell(linkFragment);

  // Build a combined text: concatenate plain texts from joiners + link fragment.
  // Spans from the link fragment are offset by the joiner text length.
  const joinerText = joiners.map((j) => j.plain).join("");
  const offset = joinerText.length;
  const allParts = buildPartsFromPrependedJoiners(
    joinerText,
    linkFragment.plain,
    linkFragment.spans,
    offset,
  );

  if (!allParts.length || (allParts.length === 1 && !allParts[0]!.style)) {
    return new StripCell(joinerText + linkFragment.plain, linkFragment.style);
  }
  return new StripCell(allParts, linkFragment.style);
}

// Convert a single RichText (no link) to a StripCell.
function richTextToCell(fragment: RichText): StripCell {
  const cellStyle = fragment.style;
  const plain = fragment.plain;
  const spans = fragment.spans;

  if (!spans.length) {
    return new StripCell(plain, cellStyle);
  }

  const parts = spansToStripCellParts(plain, spans, 0);
  return new StripCell(parts, cellStyle);
}

// Build StripCellPart[] for a merged (joiner + link-fragment) cell.
// joinerText is plain and unstyled; link-fragment spans are shifted by `offset`.
function buildPartsFromPrependedJoiners(
  joinerText: string,
  linkPlain: string,
  linkSpans: readonly Span[],
  offset: number,
): StripCellPart[] {
  const combined = joinerText + linkPlain;
  if (!linkSpans.length) return [{ text: combined }];

  return spansToStripCellParts(combined, linkSpans, offset);
}

// Decompose text + spans (offset-adjusted) into StripCellPart[].
// Spans are half-open [start, end) character ranges with a style overlay.
// Any unstyled gap becomes a plain part (no style override).
// [LAW:single-enforcer] bgcolor is stripped from part styles here — once —
// because StripCell rejects parts with bgcolor (single-style invariant).
function spansToStripCellParts(
  text: string,
  spans: readonly Span[],
  spanOffset: number,
): StripCellPart[] {
  const parts: StripCellPart[] = [];
  let cursor = 0;

  for (const span of spans) {
    const start = span.start + spanOffset;
    const end = span.end + spanOffset;

    if (cursor < start) {
      parts.push({ text: text.slice(cursor, start) });
    }

    const spanText = text.slice(start, end);
    if (spanText) {
      const rawSpanStyle =
        typeof span.style === "string" ? Style.parse(span.style) : span.style;
      // Strip bgcolor so we don't violate the StripCell single-style
      // invariant. Cell-level style governs bg; parts only carry fg/attrs.
      const partStyle = stripBgcolor(rawSpanStyle);
      parts.push({
        text: spanText,
        style: partStyle.isNull ? undefined : partStyle,
      });
    }

    cursor = Math.max(cursor, end);
  }

  if (cursor < text.length) {
    parts.push({ text: text.slice(cursor) });
  }

  return parts.length ? parts : [{ text }];
}

// Build a Style that carries everything from `s` except bgcolor.
// [LAW:one-source-of-truth] bgcolor belongs on the cell, not on parts.
function stripBgcolor(s: Style): Style {
  if (s.bgcolor === undefined) return s;
  return new Style({
    color: s.color,
    bold: s.bold,
    dim: s.dim,
    italic: s.italic,
    underline: s.underline,
    blink: s.blink,
    blink2: s.blink2,
    reverse: s.reverse,
    conceal: s.conceal,
    strike: s.strike,
    underline2: s.underline2,
    frame: s.frame,
    encircle: s.encircle,
    overline: s.overline,
    link: s.link,
    meta: s.meta,
  });
}
