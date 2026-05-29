// [LAW:verifiable-goals] The architectural fix (brandon-daemon-memory-leak-5qh):
// the `today` aggregate is a fold over daemon-owned per-session records, NOT a
// per-render whole-tree scan. These tests pin that contract.
//
// WHY CUMULATIVE FS OPS, NOT PEAK
// -------------------------------
// gn4.2's gate bounds PEAK in-flight fs ops at a constant whether there is 1
// scan or 50 — so peak is structurally blind to "did we rescan." The signal
// that the per-render scan is GONE is the CUMULATIVE count of fs ops: the whole
// tree is read exactly ONCE (the lazy seed), and every render after that costs
// zero transcript fs work while the active session is unchanged. async_hooks
// counts FSREQPROMISE inits deterministically.
//
// (statMtimeMs on the hot path is fs.statSync — synchronous, so it inits no
// FSREQPROMISE. That is the point: the per-render freshness check is a sync
// single-file stat, not an async whole-tree sweep.)

import { createHook } from "node:async_hooks";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SessionUsageStore } from "../src/daemon/cache/session-usage-store";
import { clearParseCache } from "../src/utils/claude";
import type { ClaudeHookData } from "../src/utils/claude";

// Count cumulative FSREQPROMISE inits (libuv fs requests) over `body`.
async function countFsOps(body: () => Promise<unknown>): Promise<number> {
  let total = 0;
  const hook = createHook({
    init(_id, type) {
      if (type === "FSREQPROMISE") total++;
    },
  });
  hook.enable();
  try {
    await body();
  } finally {
    hook.disable();
  }
  return total;
}

// One JSONL line of usage for `day` with the given cost. Unique requestId/msgId
// so the dedup in the parser keeps every line.
function usageLine(tag: string, day: Date, cost: number): string {
  return (
    JSON.stringify({
      timestamp: day.toISOString(),
      requestId: `req-${tag}`,
      costUSD: cost,
      message: {
        id: `msg-${tag}`,
        model: "claude-opus-4-8",
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    }) + "\n"
  );
}

function hook(sessionId: string, transcriptPath: string): ClaudeHookData {
  return {
    session_id: sessionId,
    transcript_path: transcriptPath,
  } as ClaudeHookData;
}

// ─── Session projection: cache hit / miss / eviction / sweep ──────────────────

describe("SessionUsageStore — session projection", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cc-candybar-store-"));
    clearParseCache();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("hit when transcript mtime unchanged, miss when it advances", async () => {
    const t = join(dir, "A.jsonl");
    writeFileSync(t, usageLine("a", new Date(), 0.01));
    const store = new SessionUsageStore({ sweepIntervalMs: 0 });
    try {
      const hd = hook("A", t);
      await store.getUsageInfo("A", hd);
      expect(store.getStats()).toMatchObject({ misses: 1, hits: 0 });

      await store.getUsageInfo("A", hd);
      expect(store.getStats()).toMatchObject({ misses: 1, hits: 1 });

      const future = Math.floor(Date.now() / 1000) + 3600;
      utimesSync(t, future, future);
      await store.getUsageInfo("A", hd);
      expect(store.getStats()).toMatchObject({ misses: 2, hits: 1 });
    } finally {
      store.close();
    }
  });

  test("session cost projects the parsed transcript total", async () => {
    const t = join(dir, "A.jsonl");
    writeFileSync(
      t,
      usageLine("a1", new Date(), 0.01) + usageLine("a2", new Date(), 0.02),
    );
    const store = new SessionUsageStore({ sweepIntervalMs: 0 });
    try {
      const info = await store.getUsageInfo("A", hook("A", t));
      expect(info.session.cost).toBeCloseTo(0.03, 5);
    } finally {
      store.close();
    }
  });

  test("LRU eviction at the size cap", async () => {
    const store = new SessionUsageStore({ maxEntries: 2, sweepIntervalMs: 0 });
    try {
      for (const sid of ["a", "b", "c"]) {
        const t = join(dir, `${sid}.jsonl`);
        writeFileSync(t, usageLine(sid, new Date(), 0.01));
        await store.getUsageInfo(sid, hook(sid, t));
      }
      // Cap is 2; oldest (`a`) was evicted → asking again must miss+recompute.
      const before = store.getStats().misses;
      await store.getUsageInfo("a", hook("a", join(dir, "a.jsonl")));
      expect(store.getStats().misses).toBe(before + 1);
    } finally {
      store.close();
    }
  });

  test("empty sessionId does no work and is not cached", async () => {
    const store = new SessionUsageStore({ sweepIntervalMs: 0 });
    try {
      const info = await store.getUsageInfo("", undefined);
      expect(info.session.cost).toBeNull();
      expect(store.getStats()).toMatchObject({ size: 0, misses: 0, hits: 0 });
    } finally {
      store.close();
    }
  });

  test("sweepStale drops entries older than staleAgeMs", async () => {
    const t = join(dir, "A.jsonl");
    writeFileSync(t, usageLine("a", new Date(), 0.01));
    const store = new SessionUsageStore({ sweepIntervalMs: 0, staleAgeMs: 1 });
    try {
      await store.getUsageInfo("A", hook("A", t));
      await new Promise((r) => setTimeout(r, 10));
      expect(store.sweepStale()).toBe(1);
      expect(store.getStats().sweeps).toBe(1);
    } finally {
      store.close();
    }
  });

  test("K concurrent reads of one (session, mtime) parse once", async () => {
    const t = join(dir, "A.jsonl");
    writeFileSync(t, usageLine("a", new Date(), 0.01));
    const store = new SessionUsageStore({ sweepIntervalMs: 0 });
    try {
      const hd = hook("A", t);
      clearParseCache();
      const oneParse = await countFsOps(() => store.getUsageInfo("A", hd));

      // Fresh store + cold parse cache: K concurrent first-reads coalesce onto
      // one flight, so cumulative fs ops stay near a single parse, not K×.
      const store2 = new SessionUsageStore({ sweepIntervalMs: 0 });
      clearParseCache();
      const kConcurrent = await countFsOps(() =>
        Promise.all(
          Array.from({ length: 8 }, () => store2.getUsageInfo("A", hd)),
        ),
      );
      store2.close();
      expect(oneParse).toBeGreaterThan(0);
      expect(kConcurrent).toBeLessThan(oneParse * 2);
    } finally {
      store.close();
    }
  });
});

// ─── Today projection: seed once, then fold (no per-render scan) ──────────────

describe("SessionUsageStore — today projection (off the hot path)", () => {
  const PROJECTS = 12;
  const FILES_PER_PROJECT = 6;
  const COST_PER_FILE = 0.01;
  let root: string;
  let activePath: string;
  const savedConfig = process.env.CLAUDE_CONFIG_DIR;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "cc-candybar-store-today-"));
    const projectsDir = join(root, "projects");
    const today = new Date();
    for (let p = 0; p < PROJECTS; p++) {
      const pdir = join(projectsDir, `proj-${p}`);
      mkdirSync(pdir, { recursive: true });
      for (let f = 0; f < FILES_PER_PROJECT; f++) {
        // Globally-unique sessionId per file (real session UUIDs never collide
        // across projects); cost present so the today path skips pricing I/O.
        const sid = `sess-${p}-${f}`;
        writeFileSync(join(pdir, `${sid}.jsonl`), usageLine(sid, today, COST_PER_FILE));
      }
    }
    activePath = join(projectsDir, "proj-0", "sess-0-0.jsonl");
    process.env.CLAUDE_CONFIG_DIR = root;
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
    if (savedConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = savedConfig;
  });

  test("seed aggregates today cost across every session", async () => {
    clearParseCache();
    const store = new SessionUsageStore({ sweepIntervalMs: 0 });
    try {
      const info = await store.getTodayInfo(hook("sess-0-0", activePath));
      expect(info.cost).toBeCloseTo(
        PROJECTS * FILES_PER_PROJECT * COST_PER_FILE,
        5,
      );
      expect(store.getStats().seeds).toBe(1);
    } finally {
      store.close();
    }
  });

  test("after the seed, N renders with an unchanged session do ZERO transcript fs work", async () => {
    clearParseCache();
    const store = new SessionUsageStore({ sweepIntervalMs: 0 });
    try {
      const hd = hook("sess-0-0", activePath);
      const seedOps = await countFsOps(() => store.getTodayInfo(hd));
      expect(seedOps).toBeGreaterThan(0); // the one whole-tree scan

      // 20 further renders: seed is memoized, active mtime unchanged → the only
      // freshness check is a sync statSync. No async fs ops at all.
      const steadyOps = await countFsOps(async () => {
        for (let i = 0; i < 20; i++) await store.getTodayInfo(hd);
      });
      expect(steadyOps).toBe(0);
      expect(store.getStats().seeds).toBe(1); // never re-seeded
    } finally {
      store.close();
    }
  });

  test("a changed session re-parses only itself, not the tree", async () => {
    clearParseCache();
    const store = new SessionUsageStore({ sweepIntervalMs: 0 });
    try {
      const hd = hook("sess-0-0", activePath);
      const seedOps = await countFsOps(() => store.getTodayInfo(hd));

      // Advance only the active session's mtime, then render once.
      const future = Math.floor(Date.now() / 1000) + 3600;
      utimesSync(activePath, future, future);
      clearParseCache();
      const reparseOps = await countFsOps(() => store.getTodayInfo(hd));

      // One session's re-parse is a tiny fraction of a whole-tree scan, and the
      // seed never runs again.
      expect(reparseOps).toBeGreaterThan(0);
      expect(reparseOps).toBeLessThan(seedOps / 2);
      expect(store.getStats().seeds).toBe(1);
    } finally {
      store.close();
    }
  });
});
