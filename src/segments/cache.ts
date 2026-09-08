// [LAW:dataflow-not-control-flow] The datum is one epoch instant; no display policy.
// [LAW:types-are-the-program] `absent` and `failed` stay distinct.

import { ABSENT, ok, type Outcome } from "../utils/outcome.js";
import { readTail } from "../utils/transcript-fs.js";

// A property of the upstream cache, not of this renderer, so not a user knob.
const CACHE_TTL_MS = 60 * 60 * 1000;
const TAIL_CHUNK = 64 * 1024;
const TAIL_MAX = 1 * 1024 * 1024;

// [LAW:types-are-the-program] A CANDIDATE filter: a line merely quoting these
// fields matches, so the parsed `message.usage` is the authority.
const CACHE_HIT_RE =
  /"(?:cache_read_input_tokens|cache_creation_input_tokens)":[1-9]/;

interface UsageLine {
  readonly timestamp?: string;
  readonly message?: {
    readonly usage?: {
      readonly cache_read_input_tokens?: number;
      readonly cache_creation_input_tokens?: number;
    };
  };
}

// Null for a content-only mention, so a false match never warms the timer.
function cacheActivityTs(line: string): number | null {
  let parsed: UsageLine;
  try {
    parsed = JSON.parse(line) as UsageLine;
  } catch {
    return null;
  }
  const usage = parsed.message?.usage;
  const positive =
    (usage?.cache_read_input_tokens ?? 0) > 0 ||
    (usage?.cache_creation_input_tokens ?? 0) > 0;
  if (!positive) return null;
  const ms = parsed.timestamp != null ? Date.parse(parsed.timestamp) : NaN;
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Epoch *seconds*, matching block/weekly `resetsAt` so the DSL needs no unit swap.
 */
export async function cacheExpiresAt(
  transcriptPath: string,
): Promise<Outcome<number>> {
  const lastCacheMs = await findLastCacheActivityTs(transcriptPath);
  if (lastCacheMs.kind !== "ok") return lastCacheMs;
  return ok(Math.floor((lastCacheMs.value + CACHE_TTL_MS) / 1000));
}

// [LAW:single-enforcer] Both reads go through the gated transcript-fs seam.
async function findLastCacheActivityTs(
  transcriptPath: string,
): Promise<Outcome<number>> {
  for (const maxBytes of [TAIL_CHUNK, TAIL_MAX]) {
    const tail = await readTail(transcriptPath, maxBytes);
    if (tail.kind !== "ok") return tail;
    const ts = scanBufferForLastCacheTs(tail.value.buf, tail.value.fromStart);
    if (ts != null) return ok(ts);
    // The window reached the file start, so growing would re-read the same bytes.
    if (tail.value.fromStart) return ABSENT;
  }
  return ABSENT;
}

function scanBufferForLastCacheTs(
  buf: Buffer,
  bufStartsAtFileBeginning: boolean,
): number | null {
  const text = buf.toString("utf8");
  const lines = text.split("\n");
  // A window that isn't at the file start opens on a partial JSON object.
  const start = bufStartsAtFileBeginning ? 0 : 1;
  for (let i = lines.length - 1; i >= start; i--) {
    const line = lines[i];
    if (!line || !CACHE_HIT_RE.test(line)) continue;
    const ts = cacheActivityTs(line);
    if (ts != null) return ts;
  }
  return null;
}
