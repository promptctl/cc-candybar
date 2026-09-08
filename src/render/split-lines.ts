import type { RichText } from "@promptctl/rich-js";

// [LAW:single-enforcer] Splitting happens before any strip measures a cell: a "\n" that
// reaches a horizontal strip corrupts wrap math, powerline caps and background fill.
// [LAW:one-source-of-truth] The literal "\n" is the sole vertical sentinel.

/** Empty input yields `[[]]`: a row that rendered nothing is still one (empty) line. */
export function splitCellsIntoLines(cells: readonly RichText[]): RichText[][] {
  const lines: RichText[][] = [];
  let current: RichText[] = [];
  for (const cell of cells) {
    // [LAW:dataflow-not-control-flow] The newline-free path keeps the original reference.
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
