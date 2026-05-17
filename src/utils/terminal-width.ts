// [LAW:single-enforcer] Terminal width has exactly one authoritative source:
// the live client's shell context (env / ioctl), captured at the wire boundary
// and threaded through as request data. This module is a pure resolver from
// (caller-supplied hint, ambient env, stdout TTY) to "width with reserve
// applied, or null." Subprocess-based fallbacks belong at the wire boundary,
// not here.
//
// [LAW:dataflow-not-control-flow] The function always runs the same code path.
// Variability lives in the inputs (hint set or not, env set or not, stdout a
// TTY or not), never in whether work runs.

// @info Reserves characters for Claude Code's right-side UI messages
// (e.g., "Current: 2.1.78 · latest: 2.1.78", "Thinking off")
const RESERVED_CHARS = 45;

function applyReserve(w: number): number {
  return Math.max(1, w - RESERVED_CHARS);
}

export function getTerminalWidth(termColsHint?: number): number | null {
  if (termColsHint && termColsHint > 0) return applyReserve(termColsHint);

  const envColumns = process.env.COLUMNS;
  if (envColumns) {
    const parsed = parseInt(envColumns, 10);
    if (!isNaN(parsed) && parsed > 0) return applyReserve(parsed);
  }

  if (process.stdout.columns && process.stdout.columns > 0) {
    return applyReserve(process.stdout.columns);
  }

  return null;
}
