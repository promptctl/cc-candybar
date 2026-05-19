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
// of unknown exceptions) and may contain `\n` or `\r`. Without normalization
// those leak into the statusline as multi-line glyphs that break the layout
// the surrounding cc-candybar code assumes. Sanitization happens here, in
// the same pass that enforces the code-point budget — no caller has to
// remember to scrub messages before passing them in.
//
// [LAW:one-type-per-behavior] Mirrors rust-client/src/error_glyph.rs's
// truncate(): iterate by code point (matching `chars()`, astral-safe),
// replace newline-class characters with single spaces, stop at the budget.
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
    out += ch === "\n" || ch === "\r" ? " " : ch;
    count++;
  }
  return out;
}
