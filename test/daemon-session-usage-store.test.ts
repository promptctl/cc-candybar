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
  chmodSync,
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
import type { ClaudeHookData } from "../src/utils/claude";
import { Holds } from "../src/utils/holds";
import { instantOf } from "../src/utils/instant";
import { ABSENT, PENDING } from "../src/utils/outcome";
import { FOLD_WINDOW_BYTES } from "../src/utils/transcript-fs";
import { until } from "./helpers/until";

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

// A path as a regex matching itself.
function escaped(path: string): string {
  return path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hook(sessionId: string, transcriptPath: string): ClaudeHookData {
  return {
    session_id: sessionId,
    transcript_path: transcriptPath,
  } as ClaudeHookData;
}

// ─── Session projection: cache hit / miss / eviction / sweep ──────────────────

describe("SessionUsageStore — session projection", () => {
  // The home every read here renders from; closed after each test, so no
  // directory set stays on its rescan period past it.
  let holds: Holds;
  beforeEach(() => {
    holds = new Holds();
  });
  afterEach(() => {
    holds.close();
  });
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cc-candybar-store-"));
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

  test("empty sessionId does no work, and a draw of it is what its refresh answered", async () => {
    const store = new SessionUsageStore({ sweepIntervalMs: 0 });
    try {
      const bare = { session_id: "" } as ClaudeHookData;
      const info = await store.getUsageInfo("", bare);
      expect(info.kind).toBe("ok");
      if (info.kind !== "ok") return;
      expect(info.value.session.cost).toBeNull();
      expect(store.getStats()).toMatchObject({ misses: 0, hits: 0 });
      expect(store.usageOf("", bare)).toEqual(info);
    } finally {
      store.close();
    }
  });

  // brandon-unfiled-3248.bfnj: a fold reads window by window, so a session
  // spanning several windows sums like a whole-file read, and a line longer
  // than the window — in the main transcript or a sidechain's first line — is
  // read whole and logged.
  test("a multi-window session sums every entry, and each long line read is logged", async () => {
    const t = join(dir, "W.jsonl");
    const now = new Date();
    const pad = "x".repeat(1024);
    const many = Array.from({ length: 1500 }, (_, i) => {
      const parsed = JSON.parse(usageLine(`w${i}`, now, 0.001)) as Record<string, unknown>;
      return JSON.stringify({ ...parsed, pad }) + "\n";
    });
    const long = JSON.stringify({
      ...(JSON.parse(usageLine("long", now, 0.5)) as Record<string, unknown>),
      pad: "y".repeat(Math.floor(FOLD_WINDOW_BYTES * 2.5)),
    }) + "\n";
    writeFileSync(t, many.join("") + long);
    const subagents = join(dir, "W", "subagents");
    mkdirSync(subagents, { recursive: true });
    const agent = join(subagents, "agent-1.jsonl");
    writeFileSync(
      agent,
      JSON.stringify({
        ...(JSON.parse(usageLine("agent", now, 0.25)) as Record<string, unknown>),
        sessionId: "W",
        pad: "z".repeat(Math.floor(FOLD_WINDOW_BYTES * 1.5)),
      }) + "\n",
    );
    const lines: string[] = [];
    const store = new SessionUsageStore({
      sweepIntervalMs: 0,
      logger: (_level, msg) => lines.push(msg),
    });
    try {
      const info = await store.getUsageInfo("W", hook("W", t));
      if (info.kind !== "ok") throw new Error("expected ok");
      expect(info.value.session.cost).toBeCloseTo(1500 * 0.001 + 0.5 + 0.25, 5);
      const long = lines.filter((l) => l.startsWith("transcript long line"));
      // The sidechain's first-line check, its fold, and the main transcript's.
      expect(long).toEqual([
        expect.stringContaining("agent-1.jsonl"),
        expect.stringContaining("W.jsonl"),
        expect.stringContaining("agent-1.jsonl"),
      ]);
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
      expect(lines).toContain("usageStore sweep dropped=1 noRecord=0 held=0");
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
      await store.getTodayInfo(holds, hook("A", t), dir, instantOf(at));
      await new Promise((r) => setTimeout(r, 10));
      expect(store.sweepStale()).toBe(0);
      expect(store.getStats()).toMatchObject({ sweeps: 0, size: 1 });
      expect(lines).toContain("usageStore sweep dropped=0 noRecord=0 held=1");
    } finally {
      store.close();
    }
  });

  // The day held is the sweep's own: a record holding work done on the wall
  // clock's day is held whether or not a render has asked for `today` yet.
  test("sweepStale holds a stale record with today's work before any `today` is asked", async () => {
    const t = join(dir, "A.jsonl");
    writeFileSync(t, usageLine("a", new Date(), 0.01));
    const store = new SessionUsageStore({ sweepIntervalMs: 0, staleAgeMs: 1 });
    try {
      await store.getUsageInfo("A", hook("A", t));
      await new Promise((r) => setTimeout(r, 10));
      expect(store.sweepStale()).toBe(0);
      expect(store.getStats()).toMatchObject({ size: 1 });
    } finally {
      store.close();
    }
  });

  // brandon-unfiled-3248.59m: a session that renders before its transcript
  // has bytes holds a speed ring and no record; it is swept on the same clock.
  test("sweepStale drops a session seen only by a speed observation", async () => {
    const lines: string[] = [];
    let now = Date.now();
    const clock = jest.spyOn(Date, "now").mockImplementation(() => now);
    const store = new SessionUsageStore({
      sweepIntervalMs: 0,
      staleAgeMs: 1,
      logger: (_level, msg) => lines.push(msg),
    });
    try {
      await store.observeSpeed("R", undefined, 1_000);
      expect(store.getStats()).toMatchObject({ size: 1 });
      now += 2;
      expect(store.sweepStale()).toBe(1);
      expect(store.getStats()).toMatchObject({ size: 0 });
      expect(lines).toContain("usageStore sweep dropped=1 noRecord=1 held=0");
      // The ring went with it: the next observation starts a new baseline.
      const next = await store.observeSpeed("R", undefined, 2_000);
      expect(next.kind).toBe("ok");
      if (next.kind !== "ok") return;
      expect(next.value.prev).toBeUndefined();
    } finally {
      store.close();
      clock.mockRestore();
    }
  });

  // A render reporting no transcript_path still sees its session, so the
  // record and its tok/s baseline outlive `staleAgeMs` while it renders.
  test("a render with no transcript path keeps its session seen", async () => {
    const a = join(dir, "A.jsonl");
    const b = join(dir, "B.jsonl");
    // Last week's work: no bucket for today holds either record.
    const lastWeek = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    writeFileSync(a, usageLine("a", lastWeek, 0.01));
    writeFileSync(b, usageLine("b", lastWeek, 0.01));
    let now = Date.now();
    const clock = jest.spyOn(Date, "now").mockImplementation(() => now);
    const store = new SessionUsageStore({
      sweepIntervalMs: 0,
      staleAgeMs: 300,
    });
    try {
      await store.getUsageInfo("A", hook("A", a));
      await store.getUsageInfo("B", hook("B", b));
      now += 400;
      await store.getUsageInfo("B", { session_id: "B" } as ClaudeHookData);
      expect(store.sweepStale()).toBe(1);
      const info = await store.getUsageInfo("B", {
        session_id: "B",
      } as ClaudeHookData);
      expect(info.kind).toBe("ok");
      if (info.kind !== "ok") return;
      expect(info.value.session.calculatedCost).toBeCloseTo(0.01, 5);
    } finally {
      store.close();
      clock.mockRestore();
    }
  });

  // A draw reads what the session's last refresh answered: before any refresh
  // nothing is answered, and a refresh that finds no transcript answers the
  // empty record — two facts a draw must not confuse.
  test("a draw before the session's refresh is not answered; after one it is what the refresh answered", async () => {
    const store = new SessionUsageStore({ sweepIntervalMs: 0 });
    try {
      const bare = { session_id: "H" } as ClaudeHookData;
      expect(store.usageOf("H", bare)).toBe(PENDING);
      const answered = await store.getUsageInfo("H", bare);
      expect(answered.kind).toBe("ok");
      expect(store.usageOf("H", bare)).toEqual(answered);
      // The session-less ask stores nothing.
      expect(await store.observeSpeed("", undefined, 1_000)).toEqual(ABSENT);
      expect(store.getStats()).toMatchObject({ size: 1 });
      const failed = await store.getUsageInfo("G", hook("G", dir));
      expect(failed.kind).toBe("failed");
      // A draw between requests reads the failure the last refresh met.
      expect(store.usageOf("G", hook("G", dir))).toEqual(failed);
      expect(store.getStats()).toMatchObject({ size: 2 });
    } finally {
      store.close();
    }
  });

  test("`today` is not answered until a scan has finished over its directories, never a partial sum", async () => {
    const t = join(dir, "A.jsonl");
    const at = new Date();
    writeFileSync(t, usageLine("a", at, 0.01));
    const store = new SessionUsageStore({ sweepIntervalMs: 0 });
    try {
      // The session's own refresh has landed, but no scan has.
      await store.getUsageInfo("A", hook("A", t));
      expect(store.todayOf(holds, hook("A", t), dir, instantOf(at))).toBe(PENDING);
      const today = await store.getTodayInfo(holds, hook("A", t), dir, instantOf(at));
      expect(today.kind).toBe("ok");
      expect(store.todayOf(holds, hook("A", t), dir, instantOf(at))).toEqual(today);
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
      const oneParse = await countFsOps(() => store.getUsageInfo("A", hd));

      // Fresh store: K concurrent first-reads coalesce onto
      // one flight, so cumulative fs ops stay near a single parse, not K×.
      const store2 = new SessionUsageStore({ sweepIntervalMs: 0 });
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
  // The home every read here renders from; closed after each test, so no
  // directory set stays on its rescan period past it.
  let holds: Holds;
  beforeEach(() => {
    holds = new Holds();
  });
  afterEach(() => {
    holds.close();
  });
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
    const other = mkdtempSync(join(tmpdir(), "cc-candybar-store-other-"));
    const store = new SessionUsageStore({ sweepIntervalMs: 0 });
    try {
      const odir = join(other, "projects", "proj");
      mkdirSync(odir, { recursive: true });
      const opath = join(odir, "other-0.jsonl");
      writeFileSync(opath, usageLine("other-0", new Date(), 5));
      writeFileSync(join(odir, "other-1.jsonl"), usageLine("other-1", new Date(), 7));
      const all = PROJECTS * FILES_PER_PROJECT * COST_PER_FILE;

      const first = await store.getTodayInfo(holds, hook("sess-0-0", activePath), root, instantOf(new Date()));
      expect(first.kind === "ok" && first.value.cost).toBeCloseTo(all, 5);
      const second = await store.getTodayInfo(holds, hook("other-0", opath), other, instantOf(new Date()));
      expect(second.kind === "ok" && second.value.cost).toBeCloseTo(12, 5);
      // Each directory is scanned once; a later render of either re-scans none
      // and reads the sum it read before the other was seen.
      const again = await store.getTodayInfo(holds, hook("sess-0-0", activePath), root, instantOf(new Date()));
      expect(again.kind === "ok" && again.value.cost).toBeCloseTo(all, 5);
      expect(store.scanStats().refreshes.first).toBe(2);

      // A session that starts after its directory's seed and never asks for
      // `today` itself still counts there, and only there.
      const late = join(odir, "other-late.jsonl");
      writeFileSync(late, usageLine("other-late", new Date(), 3));
      await store.getUsageInfo("other-late", hook("other-late", late));
      const joined = await store.getTodayInfo(holds, hook("other-0", opath), other, instantOf(new Date()));
      expect(joined.kind === "ok" && joined.value.cost).toBeCloseTo(15, 5);
      const apart = await store.getTodayInfo(holds, hook("sess-0-0", activePath), root, instantOf(new Date()));
      expect(apart.kind === "ok" && apart.value.cost).toBeCloseTo(all, 5);
    } finally {
      store.close();
      rmSync(other, { recursive: true, force: true });
    }
  });

  test("seed aggregates today cost across every session", async () => {
    const store = new SessionUsageStore({ sweepIntervalMs: 0 });
    try {
      const info = await store.getTodayInfo(holds, hook("sess-0-0", activePath), root, instantOf(new Date()));
      expect(info.kind).toBe("ok");
      if (info.kind !== "ok") return;
      expect(info.value.cost).toBeCloseTo(
        PROJECTS * FILES_PER_PROJECT * COST_PER_FILE,
        5,
      );
      expect(store.scanStats().refreshes.first).toBe(1);
    } finally {
      store.close();
    }
  });

  // The seed runs before the request's own refresh, so a cold request reads
  // its session once — the seed's — and its refresh takes that record: run
  // together they were two cold parses, and whichever landed second, the
  // request's newer fold among them, was not stored.
  test("a cold request's own session is read once, by the seed", async () => {
    const store = new SessionUsageStore({ sweepIntervalMs: 0 });
    try {
      await store.getTodayInfo(holds, hook("sess-0-0", activePath), root, instantOf(new Date()));
      expect(store.getStats()).toMatchObject({ hits: 1, misses: 0 });
    } finally {
      store.close();
    }
  });

  // brandon-usage-store-x2e0: the store once capped its records at 256, and a
  // seed ingesting more sessions evicted the oldest out of `today` unseen.
  test("today sums every session the seed ingests, however many", async () => {
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
      const info = await store.getTodayInfo(holds, hook("many-0", join(pdir, "many-0.jsonl")),
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
  // one that started after the seed and one the seed saw that kept going —
  // the latter appending inside the mtime tick of the seed's read, as on a
  // coarse-timestamp filesystem, so only its size says it moved. The rescan
  // is the directory set's own period (brandon-unfiled-3248.8ro6, step 3): no
  // render starts it, and it runs only while a home holds the set.
  test("today counts never-rendering sessions' work by the held set's next rescan", async () => {
    const tree = mkdtempSync(join(tmpdir(), "cc-candybar-store-rescan-"));
    const PERIOD_MS = 50;
    const lines: string[] = [];
    const store = new SessionUsageStore({
      sweepIntervalMs: 0,
      rescan: { okMs: PERIOD_MS, failedMs: PERIOD_MS },
      logger: (level, msg) => lines.push(`${level} ${msg}`),
    });
    try {
      const pdir = join(tree, "projects", "proj");
      mkdirSync(pdir, { recursive: true });
      const active = join(pdir, "active.jsonl");
      const ongoing = join(pdir, "ongoing.jsonl");
      // Local noon: every draw below falls on one day, whenever this runs.
      const noon = new Date();
      noon.setHours(12, 0, 0, 0);
      writeFileSync(active, usageLine("active", noon, 1));
      writeFileSync(ongoing, usageLine("ongoing-0", noon, 2));
      const tick = new Date(Math.floor(Date.now() / 1000) * 1000);
      utimesSync(ongoing, tick, tick);
      const hd = hook("active", active);
      const cost = () => {
        const info = store.todayOf(holds, hd, tree, instantOf(noon));
        return info.kind === "ok" ? info.value.cost : info.kind;
      };

      const seeded = await store.getTodayInfo(holds, hd, tree, instantOf(noon));
      expect(seeded.kind === "ok" && seeded.value.cost).toBeCloseTo(3, 5);
      writeFileSync(join(pdir, "headless.jsonl"), usageLine("headless", noon, 4));
      appendFileSync(ongoing, usageLine("ongoing-1", noon, 8));
      utimesSync(ongoing, tick, tick);

      // No request comes: the held set's period rescans it, and the draw's
      // lookup sees both sessions in the turn their records land.
      await until(() => cost() === 15, "the rescan counting both sessions");
      expect(store.scanStats().refreshes.first).toBe(1);
      expect(store.scanStats().refreshes.period).toBeGreaterThanOrEqual(1);
      // The rescan read only the two sessions that moved, and its event is
      // the source's: trigger and duration on the refresh, counts on the scan.
      expect(lines).toContain(
        `info usageStore scan dirs=${tree} sessions=3 read=2 failed=0`,
      );
      expect(lines).toEqual(
        expect.arrayContaining([
          expect.stringMatching(
            new RegExp(
              `^info today refresh dirs=${escaped(tree)} stored=Y by=period outcome=ok took=\\d+ms$`,
            ),
          ),
        ]),
      );

      // Released, the set's period stops: a scan in flight may still land,
      // and none starts after it.
      holds.close();
      await new Promise((r) => setTimeout(r, 5 * PERIOD_MS));
      const settled = store.scanStats().refreshes.period;
      await new Promise((r) => setTimeout(r, 5 * PERIOD_MS));
      expect(store.scanStats().refreshes.period).toBe(settled);
      expect(store.scanStats().held).toBe(0);
    } finally {
      store.close();
      rmSync(tree, { recursive: true, force: true });
    }
  });

  // [LAW:no-silent-failure] A scan that fails is `today`'s failure — never a
  // sum silently missing the sessions it did not reach — until one lands, on
  // the set's failed period.
  test("a failed scan is today's failure until the retry lands", async () => {
    const tree = mkdtempSync(join(tmpdir(), "cc-candybar-store-scan-fail-"));
    const lines: string[] = [];
    let failNextScan = true;
    const store = new SessionUsageStore({
      sweepIntervalMs: 0,
      rescan: { okMs: 60_000, failedMs: 50 },
      logger: (level, msg) => {
        if (failNextScan && msg.startsWith("usageStore scan dirs=")) {
          failNextScan = false;
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
      writeFileSync(join(pdir, "headless.jsonl"), usageLine("headless", noon, 4));
      const hd = hook("active", active);

      const first = await store.getTodayInfo(holds, hd, tree, instantOf(noon));
      expect(first).toEqual({ kind: "failed", reason: "usage scan: scan broke" });
      expect(store.todayOf(holds, hd, tree, instantOf(noon))).toEqual(first);
      expect(lines).toEqual(
        expect.arrayContaining([
          expect.stringMatching(
            new RegExp(
              `^warn today refresh dirs=${escaped(tree)} stored=Y by=first outcome=failed reason="usage scan: scan broke" took=\\d+ms$`,
            ),
          ),
        ]),
      );

      await until(
        () => store.todayOf(holds, hd, tree, instantOf(noon)).kind === "ok",
        "the retried scan landing",
      );
      const info = store.todayOf(holds, hd, tree, instantOf(noon));
      expect(info.kind === "ok" && info.value.cost).toBeCloseTo(5, 5);
      expect(store.scanStats()).toMatchObject({
        failures: 1,
        refreshes: { first: 1, period: 1 },
      });
    } finally {
      store.close();
      rmSync(tree, { recursive: true, force: true });
    }
  });

  // A session the scan found and could not read is the scan's failure, so
  // `today` is failed rather than a confident sum without that session.
  test("a session the scan cannot read is today's failure until it reads", async () => {
    const tree = mkdtempSync(join(tmpdir(), "cc-candybar-store-unread-"));
    const pdir = join(tree, "projects", "proj");
    const headless = join(pdir, "headless.jsonl");
    const store = new SessionUsageStore({
      sweepIntervalMs: 0,
      rescan: { okMs: 60_000, failedMs: 50 },
    });
    try {
      mkdirSync(pdir, { recursive: true });
      const active = join(pdir, "active.jsonl");
      const noon = new Date();
      noon.setHours(12, 0, 0, 0);
      writeFileSync(active, usageLine("active", noon, 1));
      writeFileSync(headless, usageLine("headless", noon, 4));
      chmodSync(headless, 0o000);
      const hd = hook("active", active);

      const first = await store.getTodayInfo(holds, hd, tree, instantOf(noon));
      expect(first.kind).toBe("failed");
      if (first.kind !== "failed") return;
      expect(first.reason).toMatch(
        /^usage scan: 1 of 2 sessions could not be read — .*EACCES/,
      );

      chmodSync(headless, 0o644);
      await until(
        () => store.todayOf(holds, hd, tree, instantOf(noon)).kind === "ok",
        "the retried scan reading the session",
      );
      const info = store.todayOf(holds, hd, tree, instantOf(noon));
      expect(info.kind === "ok" && info.value.cost).toBeCloseTo(5, 5);
    } finally {
      store.close();
      chmodSync(headless, 0o644);
      rmSync(tree, { recursive: true, force: true });
    }
  });

  // Only a file or directory gone since its listing is absence: a project the
  // scan cannot list fails it, named in the refresh event, whose directories
  // — what a client reported — are one logfmt value however they are spelled.
  test("a project directory the scan cannot list is today's failure", async () => {
    const tree = mkdtempSync(join(tmpdir(), "cc candybar store unlisted-"));
    const locked = join(tree, "projects", "locked");
    const lines: string[] = [];
    const store = new SessionUsageStore({
      sweepIntervalMs: 0,
      rescan: { okMs: 60_000, failedMs: 60_000 },
      logger: (level, msg) => lines.push(`${level} ${msg}`),
    });
    try {
      const pdir = join(tree, "projects", "proj");
      mkdirSync(pdir, { recursive: true });
      mkdirSync(locked);
      const active = join(pdir, "active.jsonl");
      writeFileSync(active, usageLine("active", new Date(), 1));
      chmodSync(locked, 0o000);

      const info = await store.getTodayInfo(holds, hook("active", active), tree, instantOf(new Date()));
      expect(info.kind).toBe("failed");
      if (info.kind !== "failed") return;
      expect(info.reason).toMatch(/^usage scan: .*EACCES.*locked/);
      expect(lines).toEqual(
        expect.arrayContaining([
          expect.stringMatching(
            new RegExp(
              `^warn today refresh dirs=${escaped(JSON.stringify(tree))} stored=Y by=first outcome=failed `,
            ),
          ),
        ]),
      );
    } finally {
      store.close();
      chmodSync(locked, 0o755);
      rmSync(tree, { recursive: true, force: true });
    }
  });

  // The same at the top of the tree: a `projects/` that cannot be listed is a
  // failed scan, never an empty tree summing to nothing.
  test("a projects directory the scan cannot list is today's failure", async () => {
    const tree = mkdtempSync(join(tmpdir(), "cc-candybar-store-noprojects-"));
    const projects = join(tree, "projects");
    const store = new SessionUsageStore({
      sweepIntervalMs: 0,
      rescan: { okMs: 60_000, failedMs: 60_000 },
    });
    try {
      mkdirSync(projects);
      chmodSync(projects, 0o000);
      const info = await store.getTodayInfo(holds, hook("active", join(projects, "p", "active.jsonl")), tree, instantOf(new Date()));
      expect(info.kind).toBe("failed");
      if (info.kind !== "failed") return;
      expect(info.reason).toMatch(/^usage scan: .*EACCES.*projects/);
    } finally {
      store.close();
      chmodSync(projects, 0o755);
      rmSync(tree, { recursive: true, force: true });
    }
  });

  // `today` is the day sums at the frame's own day: past local midnight, with
  // no record changed and nothing read, it is the new day's — nothing spent.
  test("a frame past midnight reads the new day with no refresh", async () => {
    const store = new SessionUsageStore({ sweepIntervalMs: 0 });
    try {
      const hd = hook("sess-0-0", activePath);
      const now = new Date();
      const answered = await store.getTodayInfo(holds, hd, root, instantOf(now));
      expect(answered.kind).toBe("ok");
      const tomorrow = new Date(now);
      tomorrow.setDate(tomorrow.getDate() + 1);
      tomorrow.setHours(0, 0, 1, 0);
      const ops = await countFsOps(async () => {
        expect(store.todayOf(holds, hd, root, instantOf(tomorrow))).toBe(ABSENT);
        expect(store.todayOf(holds, hd, root, instantOf(now))).toEqual(answered);
      });
      expect(ops).toBe(0);
      expect(store.scanStats().refreshes).toEqual({
        first: 1,
        period: 0,
        supersede: 0,
      });
    } finally {
      store.close();
    }
  });

  test("after the seed, N renders with an unchanged session do ZERO transcript fs work", async () => {
    const store = new SessionUsageStore({ sweepIntervalMs: 0 });
    try {
      const hd = hook("sess-0-0", activePath);
      const seedOps = await countFsOps(() => store.getTodayInfo(holds, hd, root, instantOf(new Date())));
      expect(seedOps).toBeGreaterThan(0); // the one whole-tree scan

      // 20 further renders: seed is memoized, active mtime unchanged → the only
      // freshness check is a sync statSync. No async fs ops at all.
      const steadyOps = await countFsOps(async () => {
        for (let i = 0; i < 20; i++) await store.getTodayInfo(holds, hd, root, instantOf(new Date()));
      });
      expect(steadyOps).toBe(0);
      // Never re-seeded, and no render rescans.
      expect(store.scanStats().refreshes).toMatchObject({ first: 1, period: 0 });
    } finally {
      store.close();
    }
  });

  test("a changed session re-parses only itself, not the tree", async () => {
    const store = new SessionUsageStore({ sweepIntervalMs: 0 });
    try {
      const hd = hook("sess-0-0", activePath);
      const seedOps = await countFsOps(() => store.getTodayInfo(holds, hd, root, instantOf(new Date())));

      // Advance only the active session's mtime, then render once.
      const future = Math.floor(Date.now() / 1000) + 3600;
      utimesSync(activePath, future, future);
      const reparseOps = await countFsOps(() => store.getTodayInfo(holds, hd, root, instantOf(new Date())));

      // One session's re-parse is a tiny fraction of a whole-tree scan, and the
      // seed never runs again.
      expect(reparseOps).toBeGreaterThan(0);
      expect(reparseOps).toBeLessThan(seedOps / 2);
      expect(store.scanStats().refreshes.first).toBe(1);
    } finally {
      store.close();
    }
  });
});
