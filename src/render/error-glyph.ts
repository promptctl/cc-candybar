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
// daemon-side ⚠ glyph in src/daemon/server.ts (composeWithError) so the
// cc-candybar diagnostic visual language is consistent. The constants live
// here rather than imported from server.ts to avoid daemon→client coupling
// (different render contexts; the appearance is policy, not shared state).

import type { PermanentOutcome } from "../daemon/client";

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
      return `daemon rejected request: ${truncate(outcome.message)}`;
    case "render_failed":
      return `render failed: ${truncate(outcome.message)}`;
    case "malformed_response":
      return `malformed daemon response: ${truncate(outcome.message)}`;
  }
}

// [LAW:single-enforcer] One sanitize-and-truncate boundary. Daemon error
// strings come from arbitrary sources (parse-error text, .toString() output
// of unknown exceptions, daemon-side echoes of caller-supplied data like an
// unknown click verb). Any control character that can disrupt the glyph's
// single-line-styled-envelope shape must be neutralized here:
//   - LF/CR/FF/VT break the "single line" property.
//   - ESC and bare CSI introducers (any of the C0 controls really) can
//     hijack ANSI styling — a daemon message containing "\x1b[0m" would
//     end the glyph's red-background span early and let the rest of the
//     terminal session inherit unstyled text. With BAD_REQUEST messages
//     echoing user-supplied request fields, that's reachable from a
//     crafted input even without a malicious daemon.
// Replacing every C0 control (0x00..0x1F) and DEL (0x7F) with a space is
// the simplest predicate that closes both classes; visible characters and
// astral code points pass through unchanged.
//
// [LAW:one-type-per-behavior] Mirrors rust-client/src/error_glyph.rs's
// truncate(): same predicate (`char.is_ascii_control()` in Rust ≡
// `code < 0x20 || code === 0x7f` here), same single-pass sanitize-and-
// truncate shape, same ellipsis policy.
function truncate(s: string): string {
  let out = "";
  let count = 0;
  for (const ch of s) {
    if (count === MAX_MESSAGE_LEN) {
      // We already wrote MAX_MESSAGE_LEN code points and the input has at
      // least one more — replace the last code point with the ellipsis so
      // the visible length stays at MAX_MESSAGE_LEN. /.$/u with the
      // unicode flag matches a full code point, not a UTF-16 unit.
      return out.replace(/.$/u, "…");
    }
    const code = ch.codePointAt(0) ?? 0;
    out += code < 0x20 || code === 0x7f ? " " : ch;
    count++;
  }
  return out;
}
