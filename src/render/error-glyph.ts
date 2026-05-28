// One-line styled diagnostic glyph emitted on permanent daemon failures.
//
// [LAW:single-enforcer] One formatter per runtime. The Node entry in
// src/index.ts calls formatPermanentGlyph; nothing else builds this string.
//
// [LAW:one-type-per-behavior] The Rust mirror at rust-client/src/error_glyph.rs
// must produce byte-identical output for the same logical cause — both
// runtimes show the same diagnostic so the user's experience does not depend
// on which client is on the hot path.
//
// Style: red background, white foreground, ANSI reset at end. Mirrors the
// daemon-side ⚠ error glyph in src/daemon/server.ts (composeWithDiagnostics)
// so the cc-candybar diagnostic visual language is consistent. The constants
// live here rather than imported from server.ts to avoid daemon→client
// coupling (different render contexts; the appearance is policy, not shared
// state).
//
// [LAW:one-source-of-truth] The sanitize-and-truncate primitive lives in
// ./diagnostic-text — shared with src/daemon/server.ts so the
// security-critical control-char neutralization (C0 + DEL + C1/8-bit-CSI)
// cannot drift between the two callers.

import type { PermanentOutcome } from "../daemon/client";
import { sanitizeAndTruncate } from "./diagnostic-text";

const FG = "\x1b[38;2;255;255;255m";
const BG = "\x1b[48;2;200;40;40m";
const RESET = "\x1b[0m";
const OPEN = `${BG}${FG}`;
const PREFIX = "⚠ cc-candybar: ";

// Long messages from the daemon (parse errors, internal exception strings)
// can be arbitrarily long. The glyph must fit on a single statusline row, so
// truncate to a budget that leaves room for the prefix at typical widths.
const MAX_MESSAGE_LEN = 60;

export function formatPermanentGlyph(outcome: PermanentOutcome): string {
  return `${OPEN}${PREFIX}${describe(outcome)}${RESET}\n`;
}

function describe(outcome: PermanentOutcome): string {
  switch (outcome.cause) {
    case "version_mismatch": {
      const daemon = outcome.daemonV === 0 ? "unknown" : `v${outcome.daemonV}`;
      return `protocol mismatch (client v${outcome.clientV} ≠ daemon ${daemon})`;
    }
    case "bad_request":
      return `daemon rejected request: ${sanitizeAndTruncate(outcome.message, MAX_MESSAGE_LEN)}`;
    case "render_failed":
      return `render failed: ${sanitizeAndTruncate(outcome.message, MAX_MESSAGE_LEN)}`;
    case "malformed_response":
      return `malformed daemon response: ${sanitizeAndTruncate(outcome.message, MAX_MESSAGE_LEN)}`;
  }
}
