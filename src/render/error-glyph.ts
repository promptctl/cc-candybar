// One-line styled diagnostic glyph emitted on permanent daemon failures.
//
// [LAW:single-enforcer] One formatter per runtime. The Node entry in
// src/index.ts calls formatPermanentGlyph; nothing else builds this string.
//
// [LAW:one-type-per-behavior] The Rust mirror at rust-client/src/error_glyph.rs
// must produce byte-identical output for the same logical cause — both
// runtimes show the same diagnostic so the user's experience does not depend
// on which client is on the hot path. The mirrored constants are diffed by
// scripts/check-protocol.mjs; the sanitize/collapse/truncate behavior is
// pinned by paired fixture tests on both sides.
//
// [LAW:one-source-of-truth] Both shared primitives live in leaf modules under
// ./: the style constants in ./diagnostic-style (shared with the daemon's
// composeWithDiagnostics so the diagnostic visual language cannot drift) and
// the sanitize-and-truncate primitive in ./diagnostic-text (shared with
// src/daemon/server.ts so the security-critical control-char neutralization
// (C0 + DEL + C1/8-bit-CSI) cannot drift between the two callers).

import type { PermanentOutcome } from "../daemon/client";
import {
  ANSI_RESET,
  DIAGNOSTIC_ERROR_BG,
  DIAGNOSTIC_ERROR_FG,
} from "./diagnostic-style";
import { sanitizeAndTruncate } from "./diagnostic-text";

const OPEN = `${DIAGNOSTIC_ERROR_BG}${DIAGNOSTIC_ERROR_FG}`;
const PREFIX = "⚠ cc-candybar: ";

// Long messages from the daemon (parse errors, internal exception strings)
// can be arbitrarily long. The glyph must fit on a single statusline row, so
// truncate to a budget that leaves room for the prefix at typical widths.
const MAX_MESSAGE_LEN = 60;

export function formatPermanentGlyph(outcome: PermanentOutcome): string {
  return `${OPEN}${PREFIX}${describe(outcome)}${ANSI_RESET}\n`;
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
