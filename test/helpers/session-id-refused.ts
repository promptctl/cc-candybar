// Every session id a door refuses, and the problem the checkpoint names. One
// table for the checkpoint's own cases and for the daemon's doors, so a door
// cannot refuse a different set.

import { SESSION_ID_MAX_BYTES } from "../../src/daemon/session-id";

export const REFUSED: ReadonlyArray<readonly [string, string, RegExp]> = [
  ["empty", "", /is empty/],
  ["a slash", "a/b", /path separator/],
  ["a backslash", "a\\b", /path separator/],
  ["NUL", "a\0b", /NUL/],
  ["dot", ".", /names a folder/],
  ["dot-dot", "..", /names a folder/],
  ["too long", "x".repeat(SESSION_ID_MAX_BYTES + 1), /longer than 250 bytes/],
];
