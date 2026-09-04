// The client's terminal-extent probe, one function for both axes.
//
// [LAW:one-type-per-behavior] Columns and rows are the same fact about two
// axes: the shell's env var (COLUMNS / LINES — Bash exports them on resize and
// Claude Code propagates them to hook commands) first, then the stderr TTY's
// own geometry (stdin is the hook JSON pipe and stdout is the captured
// statusline pipe, so stderr is the only stream still on the parent
// terminal; mirrors the Rust client's TIOCGWINSZ-on-STDERR_FILENO).
// `undefined` is the honest "could not determine", never a guessed size —
// the daemon falls back to its own pure lookup chain.
//
// [LAW:one-source-of-truth] The env value is accepted exactly when the Rust
// client's `str::parse::<u32>` accepts it — an optional `+`, then digits
// only, within u32 — so both runtimes read the same value from the same
// shell or neither does. Both suites pin the same table
// (test/term-extent.test.ts, rust-client/src/main.rs).
export function detectTermExtent(
  envValue: string | undefined,
  ttyExtent: number | undefined,
): number | undefined {
  if (envValue !== undefined && /^\+?\d+$/.test(envValue)) {
    const n = Number(envValue);
    if (n > 0 && n <= 0xffff_ffff) return n;
  }
  if (ttyExtent && ttyExtent > 0) return ttyExtent;
  return undefined;
}
