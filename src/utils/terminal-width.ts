// [LAW:single-enforcer] Width's one source is the live client's shell context.
// stderr is the TTY fallback: stdout is the captured statusline pipe.

// @info Claude Code's statusline LEFT gutter — not a right-side overlay budget.
// Re-measure if that gutter changes.
const RESERVED_CHARS = 2;

// [LAW:single-enforcer] The canonical raw-cols → usable-cols transform.
export function applyClaudeCodeReserve(rawCols: number): number {
  return Math.max(1, rawCols - RESERVED_CHARS);
}

export function getTerminalWidth(termColsHint?: number): number | null {
  if (termColsHint && termColsHint > 0)
    return applyClaudeCodeReserve(termColsHint);

  const envColumns = process.env.COLUMNS;
  if (envColumns) {
    const parsed = parseInt(envColumns, 10);
    if (!isNaN(parsed) && parsed > 0) return applyClaudeCodeReserve(parsed);
  }

  if (process.stderr.columns && process.stderr.columns > 0) {
    return applyClaudeCodeReserve(process.stderr.columns);
  }

  return null;
}
