// Contract tests for the prompt-cache warmth provider. The provider answers
// one question — the epoch-seconds instant the prompt cache expires — by
// tail-reading the transcript for the last cache-bearing entry and projecting
// it forward by the 1h TTL. These assert the BEHAVIOR (which timestamp wins,
// when the outcome is absent), not the tail-read mechanics.

import { chmodSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { cacheExpiresAt } from "../src/segments/cache";
import { ABSENT, ok } from "../src/utils/outcome";

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

  it("projects the LAST cache-bearing entry forward by the TTL", async () => {
    const last = "2026-05-30T12:00:00.000Z";
    const path = writeTranscript([
      entry({ ts: "2026-05-30T11:00:00.000Z", cacheRead: 100 }),
      entry({ ts: "2026-05-30T11:30:00.000Z", cacheCreation: 200 }),
      entry({ ts: last, cacheRead: 50 }),
    ]);
    const expected = Math.floor(Date.parse(last) / 1000) + TTL_SEC;
    expect(await cacheExpiresAt(path)).toEqual(ok(expected));
  });

  it("ignores entries with zero cache tokens", async () => {
    const cacheHit = "2026-05-30T11:00:00.000Z";
    const path = writeTranscript([
      entry({ ts: cacheHit, cacheRead: 100 }),
      // Later in the file but NO cache activity — must not win.
      entry({ ts: "2026-05-30T12:00:00.000Z", cacheRead: 0, cacheCreation: 0 }),
    ]);
    const expected = Math.floor(Date.parse(cacheHit) / 1000) + TTL_SEC;
    expect(await cacheExpiresAt(path)).toEqual(ok(expected));
  });

  it("returns absent when no entry ever touched the cache", async () => {
    const path = writeTranscript([
      entry({ ts: "2026-05-30T11:00:00.000Z" }),
      entry({ ts: "2026-05-30T12:00:00.000Z" }),
    ]);
    expect(await cacheExpiresAt(path)).toEqual(ABSENT);
  });

  it("returns absent for a missing transcript", async () => {
    expect(await cacheExpiresAt("/no/such/transcript.jsonl")).toEqual(ABSENT);
  });

  it("returns failed for an unreadable transcript", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-cache-"));
    createdDirs.push(dir);
    const path = join(dir, "transcript.jsonl");
    writeFileSync(path, entry({ ts: "2026-05-30T11:00:00.000Z" }) + "\n");
    chmodSync(path, 0o000);
    // A transcript that EXISTS but can't be read is a real failure, not the
    // everyday "no transcript yet" — it must not silently hide the segment.
    expect(await cacheExpiresAt(path)).toMatchObject({ kind: "failed" });
    chmodSync(path, 0o644);
  });

  it("finds a cache hit beyond the first 64KB tail chunk", async () => {
    const cacheHit = "2026-05-30T10:00:00.000Z";
    const filler = Array.from({ length: 2000 }, (_, i) =>
      entry({ ts: `2026-05-30T11:${String(i % 60).padStart(2, "0")}:00.000Z` }),
    );
    // One cache-bearing entry, then >64KB of zero-cache filler after it.
    const path = writeTranscript([entry({ ts: cacheHit, cacheRead: 1 }), ...filler]);
    const expected = Math.floor(Date.parse(cacheHit) / 1000) + TTL_SEC;
    expect(await cacheExpiresAt(path)).toEqual(ok(expected));
  });

  it("ignores a cache-token string that appears in message CONTENT, not usage", async () => {
    // The regex is only a candidate filter — authority is `message.usage`. A
    // later line whose CONTENT quotes the token string (zero actual usage) must
    // NOT win over an earlier real cache hit.
    const realHit = "2026-05-30T10:00:00.000Z";
    const decoy = JSON.stringify({
      timestamp: "2026-05-30T12:00:00.000Z", // later, but content-only
      message: {
        content: 'pasted "cache_read_input_tokens":999 from a log',
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      },
    });
    const path = writeTranscript([entry({ ts: realHit, cacheRead: 100 }), decoy]);
    const expected = Math.floor(Date.parse(realHit) / 1000) + TTL_SEC;
    expect(await cacheExpiresAt(path)).toEqual(ok(expected));
  });
});
