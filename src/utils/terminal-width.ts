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

// @info Reserves characters for Claude Code's right-side UI messages
// (e.g., "Current: 2.1.78 · latest: 2.1.78", "Thinking off")
const RESERVED_CHARS = 45;

// [LAW:single-enforcer] The canonical raw-cols → usable-cols transform.
// Every consumer that needs to honor Claude Code's overlay routes through
// here; there is no parallel `cols - 45` math anywhere. Exposed so callers
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
