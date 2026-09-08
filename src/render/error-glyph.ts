// [LAW:single-enforcer] One formatter per runtime; nothing else builds this string.
// [LAW:one-type-per-behavior] The Rust mirror must emit BYTE-IDENTICAL output.
// [LAW:one-source-of-truth] Style and control-char neutralization are shared leaves.

import type { PermanentOutcome } from "../daemon/client-transport";
import {
  ANSI_RESET,
  DIAGNOSTIC_ERROR_BG,
  DIAGNOSTIC_ERROR_FG,
} from "./diagnostic-style";
import { sanitizeAndTruncate } from "./diagnostic-text";

const OPEN = `${DIAGNOSTIC_ERROR_BG}${DIAGNOSTIC_ERROR_FG}`;
const PREFIX = "⚠ cc-candybar: ";

// The glyph must fit one statusline row beside its prefix.
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
