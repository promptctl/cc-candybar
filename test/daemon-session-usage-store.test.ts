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
// (statStamp on the hot path is fs.statSync — synchronous, so it inits no
// FSREQPROMISE. That is the point: the per-render freshness check is a sync
// single-file stat, not an async whole-tree sweep.)

import { createHook } from "node:async_hooks";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  utimesSync,
  appendFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SessionUsageStore } from "../src/daemon/cache/session-usage-store";
import { clearParseCache } from "../src/utils/claude";
import type { ClaudeHookData } from "../src/utils/claude";
import { instantOf } from "../src/utils/instant";

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

  test("session cost falls back to the priced transcript total when the hook omits cost", async () => {
    const t = join(dir, "A.jsonl");
    writeFileSync(
      t,
      usageLine("a1", new Date(), 0.01) + usageLine("a2", new Date(), 0.02),
    );
    const store = new SessionUsageStore({ sweepIntervalMs: 0 });
    try {
      // hook() carries no cost block → officialCost null → display the
      // transcript total.
      const info = await store.getUsageInfo("A", hook("A", t));
      expect(info.kind).toBe("ok");
      if (info.kind !== "ok") return;
      expect(info.value.session.cost).toBeCloseTo(0.03, 5);
      expect(info.value.session.officialCost).toBeNull();
      expect(info.value.session.calculatedCost).toBeCloseTo(0.03, 5);
    } finally {
      store.close();
    }
  });

  test("session cost prefers the native total_cost_usd over the priced transcript total", async () => {
    const t = join(dir, "A.jsonl");
    writeFileSync(
      t,
      usageLine("a1", new Date(), 0.01) + usageLine("a2", new Date(), 0.02),
    );
    const store = new SessionUsageStore({ sweepIntervalMs: 0 });
    try {
      const hd = hook("A", t);
      // Claude's authoritative figure differs from the rate-table sum (0.03).
      hd.cost = {
        total_cost_usd: 0.99,
        total_duration_ms: 0,
        total_api_duration_ms: 0,
        total_lines_added: 0,
        total_lines_removed: 0,
      };
      const info = await store.getUsageInfo("A", hd);
      expect(info.kind).toBe("ok");
      if (info.kind !== "ok") return;
      // Displayed cost is the native number; the priced sum is retained
      // separately (it still feeds the cross-session `today` total).
      expect(info.value.session.cost).toBeCloseTo(0.99, 5);
      expect(info.value.session.officialCost).toBeCloseTo(0.99, 5);
      expect(info.value.session.calculatedCost).toBeCloseTo(0.03, 5);
    } finally {
      store.close();
    }
  });

  test("empty sessionId does no work and is not cached", async () => {
    const store = new SessionUsageStore({ sweepIntervalMs: 0 });
    try {
      const info = await store.getUsageInfo("", undefined);
      expect(info.kind).toBe("ok");
      if (info.kind !== "ok") return;
      expect(info.value.session.cost).toBeNull();
      expect(store.getStats()).toMatchObject({ size: 0, misses: 0, hits: 0 });
    } finally {
      store.close();
    }
  });

  test("sweepStale drops entries older than staleAgeMs", async () => {
    const t = join(dir, "A.jsonl");
    const lastWeek = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    writeFileSync(t, usageLine("a", lastWeek, 0.01));
    const lines: string[] = [];
    const store = new SessionUsageStore({
      sweepIntervalMs: 0,
      staleAgeMs: 1,
      logger: (_level, msg) => lines.push(msg),
    });
    try {
      await store.getUsageInfo("A", hook("A", t));
      await new Promise((r) => setTimeout(r, 10));
      expect(store.sweepStale()).toBe(1);
      expect(store.getStats()).toMatchObject({ sweeps: 1, size: 0 });
      expect(lines).toContain("usageStore sweep dropped=1 held=0");
    } finally {
      store.close();
    }
  });

  // brandon-usage-store-x2e0: `today` sums every record, so a stale record
  // holding today's work stays until the day rolls over.
  test("sweepStale holds a stale record that `today` still sums", async () => {
    const t = join(dir, "A.jsonl");
    // One instant for the entry and the render, so the day summed is the
    // entry's day whatever the wall clock does in between.
    const at = new Date();
    writeFileSync(t, usageLine("a", at, 0.01));
    const lines: string[] = [];
    const store = new SessionUsageStore({
      sweepIntervalMs: 0,
      staleAgeMs: 1,
      logger: (_level, msg) => lines.push(msg),
    });
    try {
      await store.getTodayInfo(hook("A", t), dir, instantOf(at));
      await new Promise((r) => setTimeout(r, 10));
      expect(store.sweepStale()).toBe(0);
      expect(store.getStats()).toMatchObject({ sweeps: 0, size: 1 });
      expect(lines).toContain("usageStore sweep dropped=0 held=1");
    } finally {
      store.close();
    }
  });

  // The day held is the one `today` summed: with no render asking for `today`,
  // nothing reads the record, so a bucket for the wall clock's day holds nothing.
  test("sweepStale drops a stale record when no render has summed `today`", async () => {
    const t = join(dir, "A.jsonl");
    writeFileSync(t, usageLine("a", new Date(), 0.01));
    const store = new SessionUsageStore({ sweepIntervalMs: 0, staleAgeMs: 1 });
    try {
      await store.getUsageInfo("A", hook("A", t));
      await new Promise((r) => setTimeout(r, 10));
      expect(store.sweepStale()).toBe(1);
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
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  // brandon-client-hints-7ua: the seed scans the directory each session's
  // client reported, never the daemon's own CLAUDE_CONFIG_DIR (test/setup.ts
  // points that at an empty one), and `today` is the rendering session's own
  // directory, whichever other directories have been seen.
  test("a second session's directory is seeded on first sight and keeps its own sum", async () => {
    clearParseCache();
    const other = mkdtempSync(join(tmpdir(), "cc-candybar-store-other-"));
    const store = new SessionUsageStore({ sweepIntervalMs: 0 });
    try {
      const odir = join(other, "projects", "proj");
      mkdirSync(odir, { recursive: true });
      const opath = join(odir, "other-0.jsonl");
      writeFileSync(opath, usageLine("other-0", new Date(), 5));
      writeFileSync(join(odir, "other-1.jsonl"), usageLine("other-1", new Date(), 7));
      const all = PROJECTS * FILES_PER_PROJECT * COST_PER_FILE;

      const first = await store.getTodayInfo(hook("sess-0-0", activePath), root, instantOf(new Date()));
      expect(first.kind === "ok" && first.value.cost).toBeCloseTo(all, 5);
      const second = await store.getTodayInfo(hook("other-0", opath), other, instantOf(new Date()));
      expect(second.kind === "ok" && second.value.cost).toBeCloseTo(12, 5);
      // Each directory is scanned once; a later render of either re-scans none
      // and reads the sum it read before the other was seen.
      const again = await store.getTodayInfo(hook("sess-0-0", activePath), root, instantOf(new Date()));
      expect(again.kind === "ok" && again.value.cost).toBeCloseTo(all, 5);
      expect(store.getStats().seeds).toBe(2);

      // A session that starts after its directory's seed and never asks for
      // `today` itself still counts there, and only there.
      const late = join(odir, "other-late.jsonl");
      writeFileSync(late, usageLine("other-late", new Date(), 3));
      await store.getUsageInfo("other-late", hook("other-late", late));
      const joined = await store.getTodayInfo(hook("other-0", opath), other, instantOf(new Date()));
      expect(joined.kind === "ok" && joined.value.cost).toBeCloseTo(15, 5);
      const apart = await store.getTodayInfo(hook("sess-0-0", activePath), root, instantOf(new Date()));
      expect(apart.kind === "ok" && apart.value.cost).toBeCloseTo(all, 5);
    } finally {
      store.close();
      rmSync(other, { recursive: true, force: true });
    }
  });

  test("seed aggregates today cost across every session", async () => {
    clearParseCache();
    const store = new SessionUsageStore({ sweepIntervalMs: 0 });
    try {
      const info = await store.getTodayInfo(hook("sess-0-0", activePath), root, instantOf(new Date()));
      expect(info.kind).toBe("ok");
      if (info.kind !== "ok") return;
      expect(info.value.cost).toBeCloseTo(
        PROJECTS * FILES_PER_PROJECT * COST_PER_FILE,
        5,
      );
      expect(store.getStats().seeds).toBe(1);
    } finally {
      store.close();
    }
  });

  // brandon-usage-store-x2e0: the store once capped its records at 256, and a
  // seed ingesting more sessions evicted the oldest out of `today` unseen.
  test("today sums every session the seed ingests, however many", async () => {
    clearParseCache();
    const many = mkdtempSync(join(tmpdir(), "cc-candybar-store-many-"));
    const store = new SessionUsageStore({ sweepIntervalMs: 0 });
    try {
      const SESSIONS = 300;
      const at = new Date();
      const pdir = join(many, "projects", "proj");
      mkdirSync(pdir, { recursive: true });
      for (let s = 0; s < SESSIONS; s++) {
        writeFileSync(join(pdir, `many-${s}.jsonl`), usageLine(`many-${s}`, at, 1));
      }
      const info = await store.getTodayInfo(
        hook("many-0", join(pdir, "many-0.jsonl")),
        many,
        instantOf(at),
      );
      expect(info.kind === "ok" && info.value.cost).toBeCloseTo(SESSIONS, 5);
      expect(store.getStats().size).toBe(SESSIONS);
    } finally {
      store.close();
      rmSync(many, { recursive: true, force: true });
    }
  });

  // brandon-unfiled-3248.7xp: a session that never renders (headless
  // `claude -p`, the Agent SDK) reaches `today` through the next rescan, both
  // one that started after the day's seed and one the seed saw that kept going
  // — the latter appending inside the mtime tick of the seed's read, as on a
  // coarse-timestamp filesystem, so only its size says it moved.
  test("today counts never-rendering sessions' work by the next rescan", async () => {
    clearParseCache();
    const tree = mkdtempSync(join(tmpdir(), "cc-candybar-store-rescan-"));
    const RESCAN_MS = 60_000;
    const lines: string[] = [];
    const store = new SessionUsageStore({
      sweepIntervalMs: 0,
      rescanIntervalMs: RESCAN_MS,
      logger: (level, msg) => lines.push(`${level} ${msg}`),
    });
    try {
      const pdir = join(tree, "projects", "proj");
      mkdirSync(pdir, { recursive: true });
      const active = join(pdir, "active.jsonl");
      const ongoing = join(pdir, "ongoing.jsonl");
      // Local noon: every render below falls on one day, whenever this runs.
      const noon = new Date();
      noon.setHours(12, 0, 0, 0);
      writeFileSync(active, usageLine("active", noon, 1));
      writeFileSync(ongoing, usageLine("ongoing-0", noon, 2));
      const tick = new Date(Math.floor(Date.now() / 1000) * 1000);
      utimesSync(ongoing, tick, tick);
      const t0 = noon.getTime();
      const render = (afterMs: number) =>
        store.getTodayInfo(hook("active", active), tree, instantOf(new Date(t0 + afterMs)));
      const cost = async (afterMs: number) => {
        const info = await render(afterMs);
        return info.kind === "ok" ? info.value.cost : info.kind;
      };

      expect(await cost(0)).toBeCloseTo(3, 5);
      writeFileSync(join(pdir, "headless.jsonl"), usageLine("headless", noon, 4));
      appendFileSync(ongoing, usageLine("ongoing-1", noon, 8));
      utimesSync(ongoing, tick, tick);

      // Inside the interval nothing is rescanned.
      expect(await cost(RESCAN_MS - 1)).toBeCloseTo(3, 5);
      await store.scanned();
      expect(await cost(RESCAN_MS - 1)).toBeCloseTo(3, 5);
      expect(store.getStats()).toMatchObject({ seeds: 1, rescans: 0 });

      // The first render past it starts one rescan in the background; a render
      // while it runs starts no second one, even an interval later (both calls
      // reach the memo before the rescan's first fs op); once it settles both
      // sessions count.
      await Promise.all([render(RESCAN_MS), render(2 * RESCAN_MS)]);
      await store.scanned();
      expect(store.getStats()).toMatchObject({ seeds: 1, rescans: 1 });
      expect(await cost(2 * RESCAN_MS)).toBeCloseTo(15, 5);
      // The rescan read the two sessions that moved, and its reads are not
      // the renders' cache misses.
      expect(lines.filter((l) => l.includes("usageStore rescan"))).toEqual([
        expect.stringMatching(/^info usageStore rescan sessions=3 read=2 dirs=\S+ ms=\d+$/),
      ]);
      expect(store.getStats()).toMatchObject({ misses: 0 });
    } finally {
      store.close();
      rmSync(tree, { recursive: true, force: true });
    }
  });

  // A scan that throws drops its memo, so the next render seeds afresh and
  // awaits it rather than summing over a tree nothing is rescanning.
  test("a failed rescan is logged and the next render seeds afresh", async () => {
    clearParseCache();
    const tree = mkdtempSync(join(tmpdir(), "cc-candybar-store-rescan-fail-"));
    const lines: string[] = [];
    let failNextRescan = true;
    const store = new SessionUsageStore({
      sweepIntervalMs: 0,
      rescanIntervalMs: 1,
      logger: (level, msg) => {
        if (failNextRescan && msg.startsWith("usageStore rescan ")) {
          failNextRescan = false;
          throw new Error("scan broke");
        }
        lines.push(`${level} ${msg}`);
      },
    });
    try {
      const pdir = join(tree, "projects", "proj");
      mkdirSync(pdir, { recursive: true });
      const active = join(pdir, "active.jsonl");
      const noon = new Date();
      noon.setHours(12, 0, 0, 0);
      writeFileSync(active, usageLine("active", noon, 1));
      const render = (afterMs: number) =>
        store.getTodayInfo(hook("active", active), tree, instantOf(new Date(noon.getTime() + afterMs)));

      await render(0);
      await render(1);
      await store.scanned();
      expect(lines).toContain("warn usageStore scan: scan broke");
      expect(store.getStats()).toMatchObject({ seeds: 1, rescans: 0 });

      writeFileSync(join(pdir, "headless.jsonl"), usageLine("headless", noon, 4));
      const info = await render(2);
      expect(info.kind === "ok" ? info.value.cost : info.kind).toBeCloseTo(5, 5);
      expect(store.getStats()).toMatchObject({ seeds: 2, rescans: 0 });
    } finally {
      await store.scanned();
      store.close();
      rmSync(tree, { recursive: true, force: true });
    }
  });

  test("after the seed, N renders with an unchanged session do ZERO transcript fs work", async () => {
    clearParseCache();
    const store = new SessionUsageStore({ sweepIntervalMs: 0 });
    try {
      const hd = hook("sess-0-0", activePath);
      const seedOps = await countFsOps(() => store.getTodayInfo(hd, root, instantOf(new Date())));
      expect(seedOps).toBeGreaterThan(0); // the one whole-tree scan

      // 20 further renders: seed is memoized, active mtime unchanged → the only
      // freshness check is a sync statSync. No async fs ops at all.
      const steadyOps = await countFsOps(async () => {
        for (let i = 0; i < 20; i++) await store.getTodayInfo(hd, root, instantOf(new Date()));
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
      const seedOps = await countFsOps(() => store.getTodayInfo(hd, root, instantOf(new Date())));

      // Advance only the active session's mtime, then render once.
      const future = Math.floor(Date.now() / 1000) + 3600;
      utimesSync(activePath, future, future);
      clearParseCache();
      const reparseOps = await countFsOps(() => store.getTodayInfo(hd, root, instantOf(new Date())));

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
