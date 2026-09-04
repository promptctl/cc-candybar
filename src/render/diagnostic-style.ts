// The cc-candybar diagnostic visual identity: the ANSI style constants for
// every error/warning surface we draw (the client's permanent-failure glyph
// and the daemon's per-render diagnostic strip).
//
// [LAW:one-source-of-truth] This leaf module is the single TS definition of
// the diagnostic style. Recoloring diagnostics is an edit here, nowhere else
// — a partial restyle that ships an inconsistent error language is no longer
// expressible within the Node runtime.
//
// [LAW:one-way-deps] A leaf: imports nothing, so both the daemon
// (src/daemon/server.ts) and the client render path
// (src/render/error-glyph.ts) can import it without daemon↔client coupling —
// the same direction already used for ./diagnostic-text.
//
// The Rust client (rust-client/src/error_glyph.rs) cannot import a TS module,
// so it mirrors the error trio as literal consts; scripts/check-protocol.mjs
// diffs that mirror against this file and fails prepublishOnly on drift.

export const DIAGNOSTIC_ERROR_FG = "\x1b[38;2;255;255;255m";
export const DIAGNOSTIC_ERROR_BG = "\x1b[48;2;200;40;40m";
export const DIAGNOSTIC_WARNING_FG = "\x1b[38;2;0;0;0m";
export const DIAGNOSTIC_WARNING_BG = "\x1b[48;2;220;160;40m";
export const ANSI_RESET = "\x1b[0m";

// [LAW:one-source-of-truth] The SGR literals above are the canonical (and
// Rust-mirrored) statement of each color; the hex pairs the rich-js render
// path needs (src/render/diagnostic-strip.ts builds `Style`s) are DERIVED
// from them here, so a recolor is still one edit and the two spellings
// cannot drift. The parser is total over the 24-bit SGR shape the literals
// use; a literal that stops matching it fails at module load, loudly.
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
