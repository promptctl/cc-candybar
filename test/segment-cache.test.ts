// Contract tests for the prompt-cache warmth provider. The provider answers
// one question — the epoch-seconds instant the prompt cache expires — by
// tail-reading the transcript for the last cache-bearing entry and projecting
// it forward by the 1h TTL. These assert the BEHAVIOR (which timestamp wins,
// when null is returned), not the tail-read mechanics.

import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { cacheExpiresAt } from "../src/segments/cache";

const TTL_SEC = 60 * 60;

function entry(opts: {
  ts: string;
  cacheRead?: number;
  cacheCreation?: number;
}): string {
  return JSON.stringify({
    timestamp: opts.ts,
    message: {
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: opts.cacheRead ?? 0,
        cache_creation_input_tokens: opts.cacheCreation ?? 0,
      },
    },
  });
}

// [LAW:one-source-of-truth] The temp dir is tracked at the moment it is created,
// so afterAll removes the exact directories that exist — not a file path's
// guessed-at parent. Every transcript this suite writes is cleaned up.
const createdDirs: string[] = [];

function writeTranscript(lines: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "cc-cache-"));
  createdDirs.push(dir);
  const path = join(dir, "transcript.jsonl");
  writeFileSync(path, lines.join("\n") + "\n");
  return path;
}

describe("cacheExpiresAt", () => {
  afterAll(() => {
    for (const dir of createdDirs) rmSync(dir, { recursive: true, force: true });
  });

  it("projects the LAST cache-bearing entry forward by the TTL", () => {
    const last = "2026-05-30T12:00:00.000Z";
    const path = writeTranscript([
      entry({ ts: "2026-05-30T11:00:00.000Z", cacheRead: 100 }),
      entry({ ts: "2026-05-30T11:30:00.000Z", cacheCreation: 200 }),
      entry({ ts: last, cacheRead: 50 }),
    ]);
    const expected = Math.floor(Date.parse(last) / 1000) + TTL_SEC;
    expect(cacheExpiresAt(path)).toBe(expected);
  });

  it("ignores entries with zero cache tokens", () => {
    const cacheHit = "2026-05-30T11:00:00.000Z";
    const path = writeTranscript([
      entry({ ts: cacheHit, cacheRead: 100 }),
      // Later in the file but NO cache activity — must not win.
      entry({ ts: "2026-05-30T12:00:00.000Z", cacheRead: 0, cacheCreation: 0 }),
    ]);
    const expected = Math.floor(Date.parse(cacheHit) / 1000) + TTL_SEC;
    expect(cacheExpiresAt(path)).toBe(expected);
  });

  it("returns null when no entry ever touched the cache", () => {
    const path = writeTranscript([
      entry({ ts: "2026-05-30T11:00:00.000Z" }),
      entry({ ts: "2026-05-30T12:00:00.000Z" }),
    ]);
    expect(cacheExpiresAt(path)).toBeNull();
  });

  it("returns null for a missing transcript", () => {
    expect(cacheExpiresAt("/no/such/transcript.jsonl")).toBeNull();
  });

  it("finds a cache hit beyond the first 64KB tail chunk", () => {
    const cacheHit = "2026-05-30T10:00:00.000Z";
    const filler = Array.from({ length: 2000 }, (_, i) =>
      entry({ ts: `2026-05-30T11:${String(i % 60).padStart(2, "0")}:00.000Z` }),
    );
    // One cache-bearing entry, then >64KB of zero-cache filler after it.
    const path = writeTranscript([entry({ ts: cacheHit, cacheRead: 1 }), ...filler]);
    const expected = Math.floor(Date.parse(cacheHit) / 1000) + TTL_SEC;
    expect(cacheExpiresAt(path)).toBe(expected);
  });
});
