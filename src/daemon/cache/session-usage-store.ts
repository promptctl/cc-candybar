import fs from "node:fs";
import { join } from "node:path";

import {
  SessionProvider,
  type SessionInfo,
  type SessionUsage,
  type UsageInfo,
  type TokenBreakdown,
} from "../../segments/session";
import {
  getClaudePaths,
  findProjectPaths,
  type ClaudeHookData,
} from "../../utils/claude";
// [LAW:single-enforcer] The once-per-day seed's directory walk shares the same
// in-flight-I/O budget (gn4.2) as every other transcript scan.
import {
  readdir as gatedReaddir,
  stat as gatedStat,
} from "../../utils/transcript-fs";
import { SingleFlight } from "../../utils/single-flight";
import { dlog } from "../log";

// [LAW:one-source-of-truth] The daemon's single owner of per-session usage.
// Per-session records are canonical; the `session` projection (whole-session
// totals) and the `today` projection (cross-session sum of today's per-day
// buckets) are BOTH folds over this one store. There is no second usage cache
// and no per-render whole-tree scan: a render observes the active session's
// change through the single mtime stat it already does, re-parses only that one
// session, and folds in-memory records for everything else.
//
// [LAW:dataflow-not-control-flow] `today` stops being "recompute-if-stale"
// (where the staleness probe — a whole-tree mtime sweep — cost as much as the
// recompute it guarded). The aggregate is derived state maintained
// incrementally: the whole transcript tree is scanned EXACTLY ONCE, lazily, to
// seed records for sessions that did work before this daemon saw them; every
// render after that is a single-file stat plus a fold.

export interface TodayInfo {
  cost: number | null;
  tokens: number | null;
  tokenBreakdown: TokenBreakdown | null;
  date: string;
}

// Per-(session, day) scalar contribution — the only granularity the today fold
// needs. Raw entries are discarded after bucketing, so per-session retained
// memory is O(retained-days), not O(entries).
interface DayUsage {
  cost: number;
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
}

interface SessionRecord {
  sessionInfo: SessionInfo;
  days: Map<string, DayUsage>;
  transcriptMtime: number;
  transcriptPath: string | undefined;
  lastSeenAt: number;
}

const DEFAULT_MAX_ENTRIES = 256;
const DEFAULT_STALE_AGE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_SWEEP_INTERVAL_MS = 5 * 60 * 1000;
// Mirrors the transcript-fs gate width: the seed's parse fan-out is bounded by
// the same constant as the I/O it drives, so the once-a-day scan can never
// re-create the unbounded burst gn4 exists to kill.
const SEED_CONCURRENCY = 8;

const EMPTY_DAY: DayUsage = {
  cost: 0,
  input: 0,
  output: 0,
  cacheCreation: 0,
  cacheRead: 0,
};

const EMPTY_SESSION_INFO: SessionInfo = {
  cost: null,
  calculatedCost: null,
  officialCost: null,
  tokens: null,
  tokenBreakdown: null,
};

function dayKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

// Files modified before this can hold no entry that lands in "today", so the
// seed never parses them. A full day of slack absorbs timezone/rollover skew.
function seedCutoffMs(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - 1);
  return d.getTime();
}

function statMtimeMs(filePath: string | undefined): number {
  if (!filePath) return 0;
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

// dayKey strings sort lexically == chronologically, so "keep recent" is a
// string comparison against yesterday's key.
function bucketByDay(usage: SessionUsage): Map<string, DayUsage> {
  const keep = dayKey(new Date(seedCutoffMs()));
  const days = new Map<string, DayUsage>();
  for (const entry of usage.entries) {
    const key = dayKey(new Date(entry.timestamp));
    if (key < keep) continue;
    const d = days.get(key) ?? { ...EMPTY_DAY };
    const u = entry.message.usage;
    d.cost += entry.costUSD ?? 0;
    d.input += u.input_tokens || 0;
    d.output += u.output_tokens || 0;
    d.cacheCreation += u.cache_creation_input_tokens || 0;
    d.cacheRead += u.cache_read_input_tokens || 0;
    days.set(key, d);
  }
  return days;
}

// Bounded-concurrency fan-out for the seed: at most `limit` parses in flight.
async function mapPool<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<unknown>,
): Promise<void> {
  let cursor = 0;
  const worker = async (): Promise<void> => {
    // The while-guard proves the index is in range; the `!` discharges
    // noUncheckedIndexedAccess, it is not a defensive guard.
    while (cursor < items.length) {
      const item = items[cursor++]!;
      await fn(item);
    }
  };
  const width = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: width }, worker));
}

export class SessionUsageStore {
  private readonly sessions = new SessionProvider();
  private readonly entries = new Map<string, SessionRecord>();
  // [LAW:one-source-of-truth] Coalesces concurrent MISSES for the same
  // (session, observed mtime) onto one parse; cleared on settle (a coalescer,
  // not a cache — the records map IS the cache).
  private readonly flight = new SingleFlight();
  // [LAW:dataflow-not-control-flow] Per-day memo of the one seed scan. Unlike
  // SingleFlight this RETAINS the resolved promise for the day, so after the
  // first seed completes every later read awaits an already-settled promise —
  // zero rescan. A rejected seed is dropped so the next read retries.
  private readonly seeded = new Map<string, Promise<void>>();
  private readonly maxEntries: number;
  private readonly staleAgeMs: number;
  private hits = 0;
  private misses = 0;
  private sweeps = 0;
  private seeds = 0;
  private sweepTimer: NodeJS.Timeout | null = null;

  constructor(
    opts: {
      maxEntries?: number;
      staleAgeMs?: number;
      sweepIntervalMs?: number;
    } = {},
  ) {
    this.maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.staleAgeMs = opts.staleAgeMs ?? DEFAULT_STALE_AGE_MS;
    const interval = opts.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
    if (interval > 0) {
      this.sweepTimer = setInterval(() => this.sweepStale(), interval);
      this.sweepTimer.unref();
    }
  }

  getStats(): {
    size: number;
    hits: number;
    misses: number;
    sweeps: number;
    seeds: number;
  } {
    return {
      size: this.entries.size,
      hits: this.hits,
      misses: this.misses,
      sweeps: this.sweeps,
      seeds: this.seeds,
    };
  }

  // The `session` projection: whole-session totals for the active session.
  async getUsageInfo(
    sessionId: string,
    hookData?: ClaudeHookData,
  ): Promise<UsageInfo> {
    const record = await this.ingest(sessionId, hookData?.transcript_path);
    const base = record?.sessionInfo ?? EMPTY_SESSION_INFO;
    // [LAW:one-source-of-truth] Claude's reported total_cost_usd is the
    // authoritative cost of the active session. base.cost (transcript entries
    // priced by PricingService against a hand-maintained rate table) is a
    // reimplementation — kept ONLY as a fallback for clients that omit cost,
    // and to feed the cross-session `today` total, which has no native source
    // (past sessions expose only their transcripts, not a live cost figure).
    // The native cost is overlaid at READ time, not frozen into the mtime-keyed
    // record, because it changes every render while the transcript total moves
    // only when the file does.
    const officialCost = hookData?.cost?.total_cost_usd ?? null;
    return {
      session: { ...base, cost: officialCost ?? base.cost, officialCost },
    };
  }

  // The `today` projection: cross-session sum of every record's today bucket.
  async getTodayInfo(hookData?: ClaudeHookData): Promise<TodayInfo> {
    const today = dayKey(new Date());
    await this.ensureSeeded(today);
    // Keep the active session fresh: the seed runs once per day, so after it
    // every render's freshness for the active session comes from here (a hit
    // when its transcript is unchanged). Empty sessionId no-ops in ingest.
    await this.ingest(hookData?.session_id ?? "", hookData?.transcript_path);

    const total: DayUsage = { ...EMPTY_DAY };
    let any = false;
    for (const record of this.entries.values()) {
      any = any || record.days.has(today);
      const d = record.days.get(today) ?? EMPTY_DAY;
      total.cost += d.cost;
      total.input += d.input;
      total.output += d.output;
      total.cacheCreation += d.cacheCreation;
      total.cacheRead += d.cacheRead;
    }

    if (!any) {
      return { cost: null, tokens: null, tokenBreakdown: null, date: today };
    }
    return {
      cost: total.cost,
      tokens:
        total.input + total.output + total.cacheCreation + total.cacheRead,
      tokenBreakdown: {
        input: total.input,
        output: total.output,
        cacheCreation: total.cacheCreation,
        cacheRead: total.cacheRead,
      },
      date: today,
    };
  }

  // mtime-gated, coalesced re-parse of ONE session. Returns its record, or the
  // last-known record when no path is available, or null for an unknown empty
  // session. This is the single write-path into the records map.
  private async ingest(
    sessionId: string,
    transcriptPath: string | undefined,
    knownMtime?: number,
  ): Promise<SessionRecord | null> {
    if (!sessionId) return null;

    const mtime = knownMtime ?? statMtimeMs(transcriptPath);
    const existing = this.entries.get(sessionId);
    if (existing && mtime !== 0 && existing.transcriptMtime === mtime) {
      existing.lastSeenAt = Date.now();
      this.entries.delete(sessionId);
      this.entries.set(sessionId, existing);
      this.hits++;
      return existing;
    }
    // No path to read fresh content — preserve the last-known record rather
    // than blank it. (The session will refresh when its transcript reappears.)
    if (!transcriptPath) return existing ?? null;

    this.misses++;
    const aggregate = await this.flight.run(`${sessionId}:${mtime}`, () =>
      this.aggregate(sessionId, transcriptPath),
    );
    // Tag with the mtime observed AFTER the read so the next render that sees
    // the same mtime is a safe hit.
    const record: SessionRecord = {
      ...aggregate,
      transcriptMtime: statMtimeMs(transcriptPath),
      transcriptPath,
      lastSeenAt: Date.now(),
    };
    this.entries.delete(sessionId);
    this.entries.set(sessionId, record);
    this.evictIfNeeded();
    return record;
  }

  private async aggregate(
    sessionId: string,
    transcriptPath: string,
  ): Promise<{ sessionInfo: SessionInfo; days: Map<string, DayUsage> }> {
    const usage = await this.sessions.getSessionUsageFromPath(
      sessionId,
      transcriptPath,
    );
    return {
      sessionInfo: this.sessions.toSessionInfo(usage),
      days: usage ? bucketByDay(usage) : new Map(),
    };
  }

  private ensureSeeded(day: string): Promise<void> {
    const existing = this.seeded.get(day);
    if (existing) return existing;
    // Drop other days' memos so the map holds at most the current day.
    this.seeded.clear();
    const promise = this.seed(day);
    this.seeded.set(day, promise);
    promise.catch(() => {
      if (this.seeded.get(day) === promise) this.seeded.delete(day);
    });
    return promise;
  }

  // The one and only whole-tree scan: lazily, once per day, ingest every
  // session whose transcript was touched recently enough to hold a today entry.
  private async seed(_day: string): Promise<void> {
    const cutoff = seedCutoffMs();
    const projectPaths = await findProjectPaths(getClaudePaths());
    const candidates: Array<{
      sessionId: string;
      path: string;
      mtime: number;
    }> = [];

    for (const dir of projectPaths) {
      let files: string[];
      try {
        files = await gatedReaddir(dir);
      } catch {
        continue;
      }
      for (const file of files) {
        if (!file.endsWith(".jsonl")) continue;
        const filePath = join(dir, file);
        let mtime: number;
        try {
          mtime = (await gatedStat(filePath)).mtimeMs;
        } catch {
          continue;
        }
        if (mtime < cutoff) continue;
        candidates.push({
          sessionId: file.slice(0, -".jsonl".length),
          path: filePath,
          mtime,
        });
      }
    }

    await mapPool(candidates, SEED_CONCURRENCY, (c) =>
      this.ingest(c.sessionId, c.path, c.mtime),
    );
    this.seeds++;
    dlog("info", `usageStore seed sessions=${candidates.length}`);
  }

  // Public for tests; called periodically from the timer.
  sweepStale(): number {
    const now = Date.now();
    let dropped = 0;
    for (const [sid, record] of this.entries) {
      if (now - record.lastSeenAt > this.staleAgeMs) {
        this.entries.delete(sid);
        dropped++;
      }
    }
    if (dropped > 0) {
      this.sweeps++;
      dlog("info", `usageStore sweep dropped=${dropped}`);
    }
    return dropped;
  }

  private evictIfNeeded(): void {
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
      dlog("info", `usageStore evict ${oldest}`);
    }
  }

  close(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    this.entries.clear();
    this.seeded.clear();
  }
}
