import type { RichText } from "@promptctl/rich-js";

// [LAW:single-enforcer] THE one place a horizontal cell stream is partitioned
// into vertical lines. Vertical composition lives on the CELL stream — resolved
// here, before any strip measures a cell — never inside a strip. A "\n" that
// reaches a horizontal strip is a zero-width lie: the strip measures a cell by
// its rendered cell-width, for which an embedded "\n" corrupts wrap math,
// powerline caps, and background fill. Splitting first means each emitted line
// is a clean newline-free cell run the strip can measure honestly.
//
// [LAW:one-source-of-truth] The line boundary is the literal "\n" carried in a
// cell's text — the SOLE vertical sentinel. Horizontal cell identity is already
// carried by segment boundaries and link spans, so only the vertical axis lacks
// a carrier and only it needs a sentinel.

/**
 * Partition a cell stream into per-line cell groups on the "\n" sentinel.
 *
 * A newline-free cell passes through BY REFERENCE — the common case is
 * byte-identical to handing the original stream straight to a strip. A cell
 * carrying "\n" is split via `RichText.split` (span- and OSC-8-preserving, and
 * it consumes the separator): the piece before the first "\n" closes the
 * current line, each interior piece is a whole line of its own, and the final
 * piece begins the next line. The "\n" is consumed as the partition point,
 * never emitted into a line and never measured.
 *
 * An empty input yields `[[]]` — one empty line group, not zero — so a visible
 * row whose segments all rendered nothing still produces exactly one (empty)
 * line, matching the pre-substrate behavior.
 */
export function splitCellsIntoLines(cells: readonly RichText[]): RichText[][] {
  const lines: RichText[][] = [];
  let current: RichText[] = [];
  for (const cell of cells) {
    // [LAW:dataflow-not-control-flow] The discriminator is whether the cell
    // carries the sentinel — a value, read once. The newline-free path keeps
    // the original reference so the dominant case allocates nothing new.
    if (!cell.contains("\n")) {
      current.push(cell);
      continue;
    }
    const pieces = cell.split("\n");
    current.push(pieces[0]!);
    for (let i = 1; i < pieces.length; i++) {
      lines.push(current);
      current = [pieces[i]!];
    }
  }
  lines.push(current);
  return lines;
}
