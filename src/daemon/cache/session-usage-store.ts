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
import { ABSENT, failed, ok, type Outcome } from "../../utils/outcome";
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

// [LAW:types-are-the-program] An `ok` TodayInfo always carries real totals —
// "no usage recorded today" is the `absent` outcome arm, not a bag of nulls.
export interface TodayInfo {
  cost: number;
  tokens: number;
  tokenBreakdown: TokenBreakdown;
  date: string;
}

// [LAW:one-source-of-truth] One observation of the active session's cumulative
// token counts at a single instant. tok/s is the delta between two of these —
// the prior sample lives in this store (the single owner of per-session token
// totals), never in a parallel counter. `input` folds the cache lanes into the
// prompt-side total so `total === input + output`. `atMs` is the render's clock
// instant (the daemon's single-enforcer clock), so a frozen test clock makes
// the rate deterministic.
export interface SpeedSample {
  readonly input: number;
  readonly output: number;
  readonly total: number;
  readonly atMs: number;
}

// The prior observation (absent on the very first render of a session), the one
// just taken, and the recent ring (oldest→newest, INCLUDING `cur`). The pure
// projections live at the render-payload boundary; this store only remembers and
// reports. [LAW:one-source-of-truth] `prev === samples[samples.length - 2]` — the
// tok/s baseline and the burn-rate history fold from the SAME owned ring, not two
// parallel stores. tok/s reads the last pair; the sparkline reads every pair.
export interface SpeedObservation {
  readonly prev?: SpeedSample;
  readonly cur: SpeedSample;
  readonly samples: readonly SpeedSample[];
}

// How many recent samples the burn-rate ring retains per session. A render-cadence
// trend, not an archive: enough to fill a wide sparkline cell, capped so an
// idle-but-alive session can't grow it without bound. The window the sparkline
// draws is a tail slice of this (the `width` arg), so this only sets the ceiling.
const SPEED_RING_CAPACITY = 64;

function speedSampleOf(
  breakdown: TokenBreakdown | null,
  atMs: number,
): SpeedSample {
  // Prompt-side = raw input plus both cache lanes (all tokens fed to the model);
  // output = generated. total = the same sum the store's `tokens` projection
  // uses, so `total === input + output`. [LAW:one-source-of-truth]
  const input = breakdown
    ? breakdown.input + breakdown.cacheCreation + breakdown.cacheRead
    : 0;
  const output = breakdown ? breakdown.output : 0;
  return { input, output, total: input + output, atMs };
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
  // [LAW:one-source-of-truth] The recent tok/s observations per session, a
  // bounded ring (oldest→newest). tok/s is a derivative of the SAME token totals
  // the records map already owns; the baseline (prior counts + time) is the ring's
  // last element, not a parallel counter. The burn-rate sparkline folds over the
  // whole ring; tok/s folds over its final pair. One call to observeSpeed appends;
  // the pure delta math is render-payload's.
  private readonly speedRings = new Map<string, SpeedSample[]>();
  // [LAW:no-ambient-temporal-coupling] Explicit owner of observe/commit ordering
  // for the speed sample. Concurrent renders observing the SAME transcript state
  // (key = `${sessionId}:${mtime}`) share ONE observation and commit the baseline
  // exactly once — so they return the same prev+cur and render identical,
  // deterministic throughput instead of the second clobbering the first.
  private readonly speedFlight = new SingleFlight();
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
  // [LAW:no-silent-failure] A failed transcript parse flows out as `failed`
  // (the payload boundary logs it); an unknown/empty session is the all-null
  // SessionInfo whose fields the boundary drops per-field — top-level
  // `absent` is reserved for ingest, since the native officialCost overlay
  // applies even with no record.
  async getUsageInfo(
    sessionId: string,
    hookData?: ClaudeHookData,
  ): Promise<Outcome<UsageInfo>> {
    const record = await this.ingest(sessionId, hookData?.transcript_path);
    if (record.kind === "failed") return record;
    const base =
      record.kind === "ok" ? record.value.sessionInfo : EMPTY_SESSION_INFO;
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
    return ok({
      session: { ...base, cost: officialCost ?? base.cost, officialCost },
    });
  }

  // The `today` projection: cross-session sum of every record's today bucket.
  // [LAW:no-silent-failure] A failed seed or a failed active-session ingest
  // makes the whole projection `failed` — a total silently missing today's
  // main work would be a confident wrong number, worse than a loud gap.
  async getTodayInfo(hookData?: ClaudeHookData): Promise<Outcome<TodayInfo>> {
    const today = dayKey(new Date());
    try {
      await this.ensureSeeded(today);
    } catch (error) {
      return failed(
        `usage seed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    // Keep the active session fresh: the seed runs once per day, so after it
    // every render's freshness for the active session comes from here (a hit
    // when its transcript is unchanged). Empty sessionId no-ops in ingest.
    const active = await this.ingest(
      hookData?.session_id ?? "",
      hookData?.transcript_path,
    );
    if (active.kind === "failed") return active;

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

    if (!any) return ABSENT;
    return ok({
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
    });
  }

  // Take one tok/s observation of the active session: ingest its current
  // cumulative counts, return the prior sample alongside, and record this one as
  // the new baseline. [LAW:no-silent-failure] A failed transcript parse flows out
  // as `failed` (the boundary logs it and the segment reads "—"); an unknown
  // session yields a zero-count sample, so a first-ever render establishes a
  // baseline without fabricating a rate. `nowMs` is the caller's single-enforcer
  // clock instant — the store never reads the clock for tok/s timing itself.
  async observeSpeed(
    sessionId: string,
    transcriptPath: string | undefined,
    nowMs: number,
  ): Promise<Outcome<SpeedObservation>> {
    // [LAW:no-ambient-temporal-coupling] Key the observation by the same
    // (session, mtime) tuple ingest uses, so concurrent renders at one transcript
    // state coalesce onto a single observe-and-commit — the read of `prev` and
    // the write of `cur` happen exactly once for that state, with the flight as
    // the sole owner of ordering. A distinct mtime is a genuinely new sample and
    // gets its own key.
    const mtime = statMtimeMs(transcriptPath);
    return this.speedFlight.run(`${sessionId}:${mtime}`, async () => {
      const record = await this.ingest(sessionId, transcriptPath, mtime);
      if (record.kind === "failed") return record;
      const breakdown =
        record.kind === "ok" ? record.value.sessionInfo.tokenBreakdown : null;
      const cur = speedSampleOf(breakdown, nowMs);
      const ring = this.speedRings.get(sessionId) ?? [];
      // [LAW:no-ambient-temporal-coupling] Observation time (atMs, the render
      // clock) owns ring order — NOT ingest-completion order. Two concurrent
      // observes with different mtimes don't coalesce in speedFlight and each
      // awaits ingest before this mutation, so a plain append would record
      // samples in whichever-ingest-settled-first order and invert oldest→newest.
      // prev is the latest sample strictly before this observation; the post-
      // insert sort by atMs makes the ring's order independent of completion
      // order. (get→insert→set is synchronous after the await, so each resumed
      // continuation mutates atomically — no lost update.)
      let prev: SpeedSample | undefined;
      for (const s of ring) {
        if (s.atMs < cur.atMs && (prev === undefined || s.atMs > prev.atMs)) {
          prev = s;
        }
      }
      ring.push(cur);
      ring.sort((a, b) => a.atMs - b.atMs);
      // Drop oldest (smallest atMs ⇒ ring[0]) beyond the cap — a tail window,
      // not an archive.
      if (ring.length > SPEED_RING_CAPACITY) ring.shift();
      this.speedRings.set(sessionId, ring);
      return ok({
        ...(prev !== undefined && { prev }),
        cur,
        samples: [...ring],
      });
    });
  }

  // mtime-gated, coalesced re-parse of ONE session. `ok` is its record,
  // `absent` is an unknown empty session (or no sessionId), `failed` is a
  // transcript that exists but couldn't be parsed — NOT cached (only ok
  // records enter the map; the next render retries, same rule as the git
  // cache). This is the single write-path into the records map.
  private async ingest(
    sessionId: string,
    transcriptPath: string | undefined,
    knownMtime?: number,
  ): Promise<Outcome<SessionRecord>> {
    if (!sessionId) return ABSENT;

    const mtime = knownMtime ?? statMtimeMs(transcriptPath);
    const existing = this.entries.get(sessionId);
    if (existing && mtime !== 0 && existing.transcriptMtime === mtime) {
      existing.lastSeenAt = Date.now();
      this.entries.delete(sessionId);
      this.entries.set(sessionId, existing);
      this.hits++;
      return ok(existing);
    }
    // No path to read fresh content — preserve the last-known record rather
    // than blank it. (The session will refresh when its transcript reappears.)
    if (!transcriptPath) return existing ? ok(existing) : ABSENT;

    this.misses++;
    const aggregate = await this.flight.run(`${sessionId}:${mtime}`, () =>
      this.aggregate(sessionId, transcriptPath),
    );
    if (aggregate.kind !== "ok") return aggregate;
    // Tag with the mtime observed AFTER the read so the next render that sees
    // the same mtime is a safe hit.
    const record: SessionRecord = {
      ...aggregate.value,
      transcriptMtime: statMtimeMs(transcriptPath),
      transcriptPath,
      lastSeenAt: Date.now(),
    };
    this.entries.delete(sessionId);
    this.entries.set(sessionId, record);
    this.evictIfNeeded();
    return ok(record);
  }

  private async aggregate(
    sessionId: string,
    transcriptPath: string,
  ): Promise<
    Outcome<{ sessionInfo: SessionInfo; days: Map<string, DayUsage> }>
  > {
    const usage = await this.sessions.getSessionUsageFromPath(
      sessionId,
      transcriptPath,
    );
    // getSessionUsageFromPath never produces absent (an empty transcript is a
    // real zero-entry usage); failed passes through to the boundary.
    if (usage.kind !== "ok") return usage;
    return ok({
      sessionInfo: this.sessions.toSessionInfo(usage.value),
      days: bucketByDay(usage.value),
    });
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

    // [LAW:no-silent-failure] The seed is its own effect edge (timer/lazy
    // driven, no render boundary to carry the outcome to), so its per-session
    // parse failures are logged here.
    await mapPool(candidates, SEED_CONCURRENCY, async (c) => {
      const outcome = await this.ingest(c.sessionId, c.path, c.mtime);
      if (outcome.kind === "failed") {
        dlog("warn", `usageStore seed: ${outcome.reason}`);
      }
    });
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
        this.speedRings.delete(sid);
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
      this.speedRings.delete(oldest);
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
    this.speedRings.clear();
  }
}
