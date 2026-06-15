// [LAW:single-enforcer] Terminal width has exactly one authoritative source:
// the live client's shell context (env / ioctl), captured at the wire boundary
// and threaded through as request data. This module is a pure resolver from
// (caller-supplied hint, ambient env, stderr TTY) to "width with reserve
// applied, or null." Subprocess-based fallbacks belong at the wire boundary,
// not here. stderr (not stdout) is the TTY-side fallback: when this resolver
// runs in a hook context, stdout is the captured statusline pipe while stderr
// stays attached to the parent terminal.
//
// [LAW:dataflow-not-control-flow] The function always runs the same code path.
// Variability lives in the inputs (hint set or not, env set or not, stderr a
// TTY or not), never in whether work runs.

// @info Reserves columns for Claude Code's statusline left gutter. Claude Code
// prints each statusline row inset by a fixed left margin, so a row rendered at
// the full raw column count would be shifted right past the terminal edge and
// soft-wrap its trailing cells. The reserve is exactly that left margin — NOT a
// right-side overlay budget. The version/autoupdate/"Remote Control" hints render
// on their own right-aligned lines below the bar and never overlap a statusline
// row, so they cost zero usable width here. Verified empirically against a live
// Claude Code statusline (the older value of 45 was a guess for a right-side
// overlay that does not sit on the statusline row); re-measure if Claude Code's
// statusline gutter changes.
const RESERVED_CHARS = 2;

// [LAW:single-enforcer] The canonical raw-cols → usable-cols transform.
// Every consumer that needs to honor Claude Code's statusline gutter routes
// through here; there is no parallel `cols - N` math anywhere. Exposed so callers
// that already have a raw width (e.g. the daemon's wire-fallback path,
// the demo reading process.stdout.columns) can apply the reserve without
// re-entering the env/stderr resolution chain in getTerminalWidth.
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
