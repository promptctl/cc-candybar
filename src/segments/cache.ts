// Prompt-cache warmth provider.
//
// Anthropic's prompt cache has a fixed TTL (1h): each turn that reads or
// creates cache entries refreshes it, and after the TTL the next turn pays
// full cache-creation cost again. This provider answers one question — when
// does the current session's cache go cold? — by tail-reading the transcript
// for the most recent entry that touched the cache and projecting its
// timestamp forward by the TTL.
//
// [LAW:dataflow-not-control-flow] The datum is a single epoch instant, not a
// rendered string. Whether the timer shows "12m", "cold", or hides entirely,
// and what color it takes, are all functions of this one number evaluated in
// the DSL template — the same shape block/weekly use with `resetsAt`. The
// provider carries no display policy.
//
// [LAW:types-are-the-program] The return is `number | null`: a known expiry
// instant, or "no cache activity found" (no transcript, unreadable, or no
// cache-bearing entry). Null becomes an absent payload field, which the
// segment's `when` predicate reads as hidden — there is no "0 means hidden"
// ambiguity to defend against downstream.

import { openSync, readSync, closeSync, statSync } from "node:fs";

// Anthropic prompt cache TTL. A const, not a knob: it is a property of the
// upstream cache, not of this renderer. If a future cache tier ships a
// different TTL, that is a new arm here, not a user config field.
const CACHE_TTL_MS = 60 * 60 * 1000;
const TAIL_CHUNK = 64 * 1024;
const TAIL_MAX = 1 * 1024 * 1024;

// A transcript line counts as cache activity when its usage block records a
// non-zero cache read or cache creation. The `[1-9]` guard rejects the
// `":0` case without parsing JSON for every candidate line.
const CACHE_HIT_RE =
  /"(?:cache_read_input_tokens|cache_creation_input_tokens)":[1-9]/;
const TIMESTAMP_RE = /"timestamp":"([^"]+)"/;

/**
 * Epoch *seconds* at which the session's prompt cache expires, or null when
 * no cache-bearing transcript entry can be found. Seconds (not millis) to
 * match the unit of block/weekly `resetsAt`, so the DSL composes
 * `minutesUntilReset .cache.expiresAt` with no unit translation.
 */
export function cacheExpiresAt(transcriptPath: string): number | null {
  const lastCacheMs = findLastCacheActivityTs(transcriptPath);
  if (lastCacheMs == null) return null;
  return Math.floor((lastCacheMs + CACHE_TTL_MS) / 1000);
}

// Tail-read the JSONL transcript and return the millisecond timestamp of the
// last entry with cache activity. Grows the read window backward from EOF
// until a hit is found or the cap is reached — the relevant entry is almost
// always within the final few KB, so the common case reads one chunk.
function findLastCacheActivityTs(transcriptPath: string): number | null {
  let fd: number | null = null;
  try {
    fd = openSync(transcriptPath, "r");
    const size = statSync(transcriptPath).size;
    let tailStart = Math.max(0, size - TAIL_CHUNK);

    while (true) {
      const chunkLen = size - tailStart;
      const chunk = Buffer.alloc(chunkLen);
      readSync(fd, chunk, 0, chunkLen, tailStart);

      const ts = scanBufferForLastCacheTs(chunk, tailStart === 0);
      if (ts != null) return ts;
      if (tailStart === 0) return null;

      const grown = Math.min(chunk.length * 2, TAIL_MAX);
      const next = Math.max(0, size - grown);
      if (next === tailStart) return null;
      tailStart = next;
    }
  } catch {
    return null;
  } finally {
    if (fd != null)
      try {
        closeSync(fd);
      } catch {}
  }
}

function scanBufferForLastCacheTs(
  buf: Buffer,
  bufStartsAtFileBeginning: boolean,
): number | null {
  const text = buf.toString("utf8");
  const lines = text.split("\n");
  // When the window doesn't start at the file beginning, the first line is
  // likely a partial JSON object — skip it so we never mis-parse a fragment.
  const start = bufStartsAtFileBeginning ? 0 : 1;
  for (let i = lines.length - 1; i >= start; i--) {
    const line = lines[i];
    if (!line || !CACHE_HIT_RE.test(line)) continue;
    const m = TIMESTAMP_RE.exec(line);
    if (!m) continue;
    const ms = Date.parse(m[1]!);
    if (!Number.isNaN(ms)) return ms;
  }
  return null;
}
