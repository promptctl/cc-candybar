// [LAW:one-source-of-truth] The single TS definition of the diagnostic style. [LAW:one-way-deps] A leaf, so daemon and client can both import it.
// rust-client/src/error_glyph.rs mirrors the error trio; check-protocol.mjs fails on drift.

export const DIAGNOSTIC_ERROR_FG = "\x1b[38;2;255;255;255m";
export const DIAGNOSTIC_ERROR_BG = "\x1b[48;2;200;40;40m";
export const DIAGNOSTIC_WARNING_FG = "\x1b[38;2;0;0;0m";
export const DIAGNOSTIC_WARNING_BG = "\x1b[48;2;220;160;40m";
export const ANSI_RESET = "\x1b[0m";

// [LAW:one-source-of-truth] The hex pairs are DERIVED from the SGR literals above,
// so a recolor stays one edit; a literal that stops being 24-bit SGR throws at load.
export interface DiagnosticColors {
  readonly fg: string;
  readonly bg: string;
}

function hexOfSgr(sgr: string): string {
  const m = /;2;(\d+);(\d+);(\d+)m$/.exec(sgr);
  if (m === null) throw new Error(`diagnostic-style: not a 24-bit SGR: ${sgr}`);
  return (
    "#" +
    m
      .slice(1, 4)
      .map((n) => Number(n).toString(16).padStart(2, "0"))
      .join("")
  );
}

export const DIAGNOSTIC_ERROR_COLORS: DiagnosticColors = {
  fg: hexOfSgr(DIAGNOSTIC_ERROR_FG),
  bg: hexOfSgr(DIAGNOSTIC_ERROR_BG),
};
export const DIAGNOSTIC_WARNING_COLORS: DiagnosticColors = {
  fg: hexOfSgr(DIAGNOSTIC_WARNING_FG),
  bg: hexOfSgr(DIAGNOSTIC_WARNING_BG),
};
