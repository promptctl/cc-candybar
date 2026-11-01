// The cc-candybar diagnostic visual identity: the colours of every error and
// warning surface we draw (the client's permanent-failure glyph and the
// daemon's diagnostics indicator and viewer).
//
// [LAW:one-source-of-truth] This leaf module is the single TS definition of
// the diagnostic style. Recoloring diagnostics is an edit here, nowhere else
// — a partial restyle that ships an inconsistent error language is no longer
// expressible within the Node runtime.
//
// [LAW:one-way-deps] A leaf: imports nothing, so both the daemon
// (src/daemon/draw-bar.ts) and the client render path
// (src/render/error-glyph.ts) can import it without daemon↔client coupling —
// the same direction already used for ./diagnostic-text.
//
// The Rust client (rust-client/src/error_glyph.rs) cannot import a TS module,
// so it mirrors the error trio as literal consts; scripts/check-protocol.mjs
// diffs that mirror against this file and fails prepublishOnly on drift.

export interface DiagnosticColors {
  readonly fg: string;
  readonly bg: string;
}

export const DIAGNOSTIC_ERROR_COLORS: DiagnosticColors = {
  fg: "#ffffff",
  bg: "#c82828",
};
export const DIAGNOSTIC_WARNING_COLORS: DiagnosticColors = {
  fg: "#000000",
  bg: "#dca028",
};
export const ANSI_RESET = "\x1b[0m";

// [LAW:one-source-of-truth] The escapes a terminal client writes on its own,
// with no draw behind them (src/render/error-glyph.ts), derive from the hex
// above, so a recolor is one edit. Spelled here rather than asked of rich-js:
// this leaf is on the client's path, which never loads it.
function sgrOf(layer: 38 | 48, hex: string): string {
  const channels = [1, 3, 5].map((at) =>
    Number.parseInt(hex.slice(at, at + 2), 16),
  );
  return `\x1b[${layer};2;${channels.join(";")}m`;
}

export const DIAGNOSTIC_ERROR_FG = sgrOf(38, DIAGNOSTIC_ERROR_COLORS.fg);
export const DIAGNOSTIC_ERROR_BG = sgrOf(48, DIAGNOSTIC_ERROR_COLORS.bg);
