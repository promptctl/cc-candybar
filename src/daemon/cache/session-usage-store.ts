import { dirname, join, sep } from "node:path";

import {
  type SessionInfo,
  type UsageInfo,
  type TokenBreakdown,
} from "../../segments/session";
import { PricingService } from "../../segments/pricing";
import {
  getClaudePaths,
  findProjectPaths,
  findAgentTranscripts,
  foldAppended,
  widenedLines,
  type ClaudeHookData,
  type Folded,
  type ParsedEntry,
} from "../../utils/claude";
// [LAW:single-enforcer] The once-per-day seed's directory walk shares the same
// in-flight-I/O budget (gn4.2) as every other transcript scan.
import {
  readdir as gatedReaddir,
  stat as gatedStat,
  statStamp,
  stampOf,
} from "../../utils/transcript-fs";
import { SingleFlight } from "../../utils/single-flight";
import { ABSENT, failed, ok, type Outcome } from "../../utils/outcome";
import { quietLogger, type DaemonLogger } from "../log";
import { dateOf, type Instant } from "../../utils/instant";

// [LAW:one-source-of-truth] The daemon's single owner of per-session usage.
// Per-session records are canonical; the `session` projection (whole-session
// totals) and the `today` projection (cross-session sum of today's per-day
// buckets) are BOTH folds over this one store. There is no second usage cache
// and no per-render whole-tree scan: a render observes the active session's
// change through the single stat it already does, re-parses only that one
// session, and folds in-memory records for everything else.
//
// [LAW:dataflow-not-control-flow] `today` stops being "recompute-if-stale"
// (where the staleness probe — a whole-tree mtime sweep — cost as much as the
// recompute it guarded). The aggregate is derived state maintained
// incrementally: the whole transcript tree is scanned lazily, once a day, to
// seed records for sessions that did work before this daemon saw them; every
// render after that is a single-file stat plus a fold. A session that never
// renders (headless `claude -p`, the Agent SDK) is kept current by RESCANNING
// the tree in the background at most once per `rescanIntervalMs` — the seed
// again, which over warm records is a stat per transcript plus the bytes
// appended since the last scan (measured: ~75 ms over 6k transcripts).

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

// What a record another directory's session owns contributes to `today`.
const NO_DAYS: ReadonlyMap<string, DayUsage> = new Map();

interface SessionRecord {
  // [LAW:one-source-of-truth] `files` is canonical (main transcript + agent
  // sidechains, each its own incremental FileFold); `sessionInfo`/`days` are
  // derived from mergeFolds and re-synced on every ingest — the single writer.
  files: Map<string, Folded<FileFold>>;
  sessionInfo: SessionInfo;
  days: Map<string, DayUsage>;
  transcriptStamp: string;
  transcriptPath: string | undefined;
}

// Everything the store holds for one session, living exactly as long as the
// session is seen: the slot exists once something is stored for it (a record,
// a speed sample), every render or scan asking about it moves `lastSeenAt`,
// and `sweepStale` drops the slot whole. [LAW:types-are-the-program] The
// record and the speed ring hang off the one slot, so neither can outlive the
// other — a session that renders before its transcript has bytes holds a ring
// and no record, and is swept on the same clock.
interface SessionSlot {
  lastSeenAt: number;
  record: SessionRecord | undefined;
  // [LAW:one-source-of-truth] The recent tok/s observations, a bounded ring
  // (oldest→newest). tok/s is a derivative of the SAME token totals the record
  // owns; the baseline (prior counts + time) is the ring's last element, not a
  // parallel counter. The burn-rate sparkline folds over the whole ring; tok/s
  // folds over its final pair. One call to observeSpeed appends; the pure delta
  // math is render-payload's.
  readonly ring: SpeedSample[];
}

// What one caller's ingests did. Renders share the store's running tally — the
// usage cache's hit rate; each scan keeps its own, reported on its event, so a
// rescan over thousands of warm records cannot pass for render behaviour.
interface IngestTally {
  hits: number;
  misses: number;
}

// One set of Claude Code directories' scans on `seededDay`.
interface DaySeed {
  // What a `today` render awaits: the day's first scan. A rescan never
  // replaces it — the records it refreshes are read as each ingest lands, and
  // an append-only fold only grows, so a render mid-rescan sums no less than
  // the last scan did.
  readonly done: Promise<void>;
  // The scan in flight, the first included: at most one per directory set.
  scanning: Promise<void> | undefined;
  // The render instant (ms) the latest scan started at.
  startedAtMs: number;
}

const DEFAULT_STALE_AGE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_SWEEP_INTERVAL_MS = 5 * 60 * 1000;
// How far behind a never-rendering session's work `today` may run.
const DEFAULT_RESCAN_INTERVAL_MS = 60 * 1000;
// Mirrors the transcript-fs gate width: the seed's parse fan-out is bounded by
// the same constant as the I/O it drives, so a scan can never re-create the
// unbounded burst gn4 exists to kill.
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

function emptyBreakdown(): TokenBreakdown {
  return { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };
}

// [LAW:one-source-of-truth] The incremental fold of ONE append-only transcript
// file (a session's main transcript or one agent sidechain): the sums over
// every usage-bearing entry seen so far. The cursor marking the bytes folded
// is the `Folded` pair's, never a field of its own here.
// The session aggregate is the MERGE of its files' folds (mergeFolds), so a file
// rewritten by /compact re-folds in isolation without disturbing the others.
interface FileFold {
  entries: number; // usage-bearing entries folded (0 ⇒ empty session, all-null)
  cost: number;
  breakdown: TokenBreakdown;
  days: Map<string, DayUsage>; // keys >= seed cutoff only (pruned on fold)
}

const EMPTY_FILE_FOLD: FileFold = {
  entries: 0,
  cost: 0,
  breakdown: emptyBreakdown(),
  days: new Map(),
};

// [LAW:effects-at-boundaries] The fold step: NEW entries onto a file fold.
// Returns a FRESH FileFold (the state is never mutated) so two concurrent
// refolds sharing one prior snapshot can't corrupt each other. A rewritten
// file is foldAppended's to start over from EMPTY_FILE_FOLD.
//
// [LAW:one-source-of-truth] Session cost and day cost use the SAME priced value:
// an entry lacking costUSD is priced once (PricingService) and that figure feeds
// BOTH the session total and its day bucket, so `today` is not silently
// under-counted for un-costed entries.
async function foldFile(
  state: FileFold,
  entries: readonly ParsedEntry[],
): Promise<FileFold> {
  // dayKey strings sort lexically == chronologically, so "keep recent" is a
  // string comparison against yesterday's key.
  const keep = dayKey(new Date(seedCutoffMs()));
  let count = state.entries;
  let cost = state.cost;
  const breakdown = { ...state.breakdown };
  const days = new Map<string, DayUsage>();
  for (const [k, v] of state.days) if (k >= keep) days.set(k, { ...v });
  for (const entry of entries) {
    const u = entry.message?.usage;
    if (!u) continue;
    count++;
    const priced =
      entry.costUSD ?? (await PricingService.calculateCostForEntry(entry.raw));
    cost += priced;
    breakdown.input += u.input_tokens || 0;
    breakdown.output += u.output_tokens || 0;
    breakdown.cacheCreation += u.cache_creation_input_tokens || 0;
    breakdown.cacheRead += u.cache_read_input_tokens || 0;
    const key = dayKey(new Date(entry.timestamp));
    if (key < keep) continue;
    const d = days.get(key) ?? { ...EMPTY_DAY };
    // [LAW:one-source-of-truth] Day cost uses the PRICED value, same as session
    // cost — the old path mutated entry.costUSD to the priced cost before
    // bucketByDay read it, so an un-costed entry contributed its priced value to
    // `today`, not 0. Using `priced` here preserves that (session and day agree).
    d.cost += priced;
    d.input += u.input_tokens || 0;
    d.output += u.output_tokens || 0;
    d.cacheCreation += u.cache_creation_input_tokens || 0;
    d.cacheRead += u.cache_read_input_tokens || 0;
    days.set(key, d);
  }
  return { entries: count, cost, breakdown, days };
}

// [LAW:effects-at-boundaries] Pure merge of a session's file folds into the
// derived record shape the read path serves. `entries === 0` across all files is
// the empty session (all-null SessionInfo, whose fields the payload drops) — the
// same distinction the old `entries.length === 0` arm carried.
function mergeFolds(files: ReadonlyMap<string, Folded<FileFold>>): {
  sessionInfo: SessionInfo;
  days: Map<string, DayUsage>;
} {
  let count = 0;
  let cost = 0;
  const bd = emptyBreakdown();
  const days = new Map<string, DayUsage>();
  for (const { value: f } of files.values()) {
    count += f.entries;
    cost += f.cost;
    bd.input += f.breakdown.input;
    bd.output += f.breakdown.output;
    bd.cacheCreation += f.breakdown.cacheCreation;
    bd.cacheRead += f.breakdown.cacheRead;
    for (const [k, v] of f.days) {
      const d = days.get(k) ?? { ...EMPTY_DAY };
      d.cost += v.cost;
      d.input += v.input;
      d.output += v.output;
      d.cacheCreation += v.cacheCreation;
      d.cacheRead += v.cacheRead;
      days.set(k, d);
    }
  }
  if (count === 0) return { sessionInfo: EMPTY_SESSION_INFO, days };
  const tokens = bd.input + bd.output + bd.cacheCreation + bd.cacheRead;
  return {
    sessionInfo: {
      cost,
      calculatedCost: cost,
      officialCost: null,
      tokens,
      tokenBreakdown: bd,
    },
    days,
  };
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
  // No count cap: `today` is a fold over every record, so a cap smaller than
  // the day's sessions would drop work from it unseen. A record is a few
  // scalars per file and retained day, and `sweepStale` bounds the map to the
  // sessions seen within `staleAgeMs` plus those holding work done today.
  private readonly sessions = new Map<string, SessionSlot>();
  // [LAW:one-source-of-truth] Coalesces concurrent MISSES for the same
  // (session, observed stamp) onto one parse; cleared on settle (a coalescer,
  // not a cache — the records map IS the cache).
  private readonly flight = new SingleFlight();
  // [LAW:dataflow-not-control-flow] Memo of the seed scans of `seededDay`, one
  // per set of Claude Code directories a session's client resolves to (keyed
  // by the directories themselves, so a default that resolves to one directory
  // shares a scan with that directory named outright). Unlike SingleFlight
  // this RETAINS the resolved promise, so after a seed completes every later
  // read awaits an already-settled promise. A rejected scan is dropped so the
  // next read seeds afresh.
  private readonly seeded = new Map<string, DaySeed>();
  private seededDay = "";
  private readonly rescanIntervalMs: number;
  // [LAW:no-ambient-temporal-coupling] Explicit owner of observe/commit ordering
  // for the speed sample. Concurrent renders observing the SAME transcript state
  // (key = `${sessionId}:${mtime}`) share ONE observation and commit the baseline
  // exactly once — so they return the same prev+cur and render identical,
  // deterministic throughput instead of the second clobbering the first.
  private readonly speedFlight = new SingleFlight();
  private readonly staleAgeMs: number;
  private readonly log: DaemonLogger;
  private readonly renderTally: IngestTally = { hits: 0, misses: 0 };
  private sweeps = 0;
  // Scans that completed and reported, by kind: a `seed` is a day's first (or
  // one after a failed scan dropped its memo), a `rescan` the background one.
  private readonly scans = { seed: 0, rescan: 0 };
  private sweepTimer: NodeJS.Timeout | null = null;

  constructor(
    opts: {
      staleAgeMs?: number;
      sweepIntervalMs?: number;
      rescanIntervalMs?: number;
      // [LAW:single-enforcer] One injection point, as on GitDataProvider: the
      // daemon passes `dlog`; every other consumer keeps the debug-routed
      // default and never writes daemon.log.
      logger?: DaemonLogger;
    } = {},
  ) {
    this.log = opts.logger ?? quietLogger;
    this.staleAgeMs = opts.staleAgeMs ?? DEFAULT_STALE_AGE_MS;
    this.rescanIntervalMs = opts.rescanIntervalMs ?? DEFAULT_RESCAN_INTERVAL_MS;
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
    rescans: number;
  } {
    return {
      size: this.sessions.size,
      hits: this.renderTally.hits,
      misses: this.renderTally.misses,
      sweeps: this.sweeps,
      seeds: this.scans.seed,
      rescans: this.scans.rescan,
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
    const record = await this.ingest(
      sessionId,
      hookData?.transcript_path,
      this.renderTally,
    );
    if (record.kind === "failed") return record;
    const base =
      record.kind === "ok" ? record.value.sessionInfo : EMPTY_SESSION_INFO;
    // [LAW:one-source-of-truth] Claude's reported total_cost_usd is the
    // authoritative cost of the active session. base.cost (transcript entries
    // priced by PricingService against a hand-maintained rate table) is a
    // reimplementation — kept ONLY as a fallback for clients that omit cost,
    // and to feed the cross-session `today` total, which has no native source
    // (past sessions expose only their transcripts, not a live cost figure).
    // The native cost is overlaid at READ time, not frozen into the stamp-keyed
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
  //
  // `claudeConfigDir` is the rendering session's `claudeConfigDir` hint, and
  // the sum is that session plus every session whose transcript lives in THAT
  // directory — the daemon's own env names none.
  // [LAW:no-ambient-temporal-coupling] Whose `today` a record is in is read
  // off where its transcript lives: a sum over every directory seen so far, or
  // over the sessions that had asked, would move with which other sessions
  // happened to have rendered.
  async getTodayInfo(
    hookData: ClaudeHookData | undefined,
    claudeConfigDir: string | undefined,
    // The instant the render is drawn at: its local date is the day summed.
    at: Instant,
  ): Promise<Outcome<TodayInfo>> {
    const today = dayKey(dateOf(at));
    const claudePaths = getClaudePaths(claudeConfigDir);
    try {
      await this.ensureSeeded(today, claudePaths, at * 1000);
    } catch (error) {
      return failed(
        `usage seed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    // Keep the active session fresh: a scan reaches it at most once a minute,
    // so every render's freshness for the active session comes from here (a
    // hit when its transcript is unchanged). Empty sessionId no-ops in ingest.
    const active = await this.ingest(
      hookData?.session_id ?? "",
      hookData?.transcript_path,
      this.renderTally,
    );
    if (active.kind === "failed") return active;

    const roots = claudePaths.map((dir) => join(dir, "projects") + sep);
    const total: DayUsage = { ...EMPTY_DAY };
    let any = false;
    for (const [sessionId, { record }] of this.sessions) {
      const path = record?.transcriptPath ?? "";
      const counted =
        sessionId === hookData?.session_id ||
        roots.some((root) => path.startsWith(root));
      // A slot holding only a speed ring has no record, and no days.
      const days = counted ? (record?.days ?? NO_DAYS) : NO_DAYS;
      any = any || days.has(today);
      const d = days.get(today) ?? EMPTY_DAY;
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
    // (session, stamp) tuple ingest uses, so concurrent renders at one transcript
    // state coalesce onto a single observe-and-commit — the read of `prev` and
    // the write of `cur` happen exactly once for that state, with the flight as
    // the sole owner of ordering. A distinct stamp is a genuinely new sample and
    // gets its own key.
    // No session id is no session: there is no baseline to keep, and a ring
    // keyed "" would be every id-less caller's baseline at once.
    if (!sessionId) return ABSENT;
    const stamp = statStamp(transcriptPath);
    return this.speedFlight.run(`${sessionId}:${stamp}`, async () => {
      const record = await this.ingest(
        sessionId,
        transcriptPath,
        this.renderTally,
        stamp,
      );
      if (record.kind === "failed") return record;
      const breakdown =
        record.kind === "ok" ? record.value.sessionInfo.tokenBreakdown : null;
      const cur = speedSampleOf(breakdown, nowMs);
      const { ring } = this.hold(sessionId);
      // [LAW:no-ambient-temporal-coupling] Observation time (atMs, the render
      // clock) owns ring order — NOT ingest-completion order. Two concurrent
      // observes with different stamps don't coalesce in speedFlight and each
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
      return ok({
        ...(prev !== undefined && { prev }),
        cur,
        samples: [...ring],
      });
    });
  }

  // stamp-gated, coalesced re-parse of ONE session. `ok` is its record,
  // `absent` is an unknown empty session (or no sessionId), `failed` is a
  // transcript that exists but couldn't be parsed — NOT cached (only ok
  // records are stored; the next render retries, same rule as the git
  // cache). This is the single write-path of a slot's record.
  private async ingest(
    sessionId: string,
    transcriptPath: string | undefined,
    tally: IngestTally,
    knownStamp?: string,
  ): Promise<Outcome<SessionRecord>> {
    if (!sessionId) return ABSENT;
    const stamp = knownStamp ?? statStamp(transcriptPath);
    const existing = this.see(sessionId)?.record;
    if (existing && stamp !== "" && existing.transcriptStamp === stamp) {
      tally.hits++;
      return ok(existing);
    }
    // No path to read fresh content — preserve the last-known record rather
    // than blank it. (The session will refresh when its transcript reappears.)
    if (!transcriptPath) return existing ? ok(existing) : ABSENT;

    tally.misses++;
    // [LAW:no-ambient-temporal-coupling] The flight thunk snapshots the prior
    // record when it RUNS (first caller); coalesced callers share that one
    // refold. Two concurrent DIFFERENT-stamp refolds — a render and a rescan,
    // say — each read the same prior, and the commit below is a compare-and-set
    // on it: the first to land replaces the prior, and the other is not stored,
    // though its caller still gets the fold its own stamp asked for (so a tok/s
    // sample is never another stamp's counts). So the stored record only ever
    // advances — `today` never steps back to a shorter fold — and since
    // `refold` writes the byte cursor and the fold as ONE pair
    // covering exactly [0, cursor), the next refold folds each byte once.
    // `foldFile` is pure (fresh FileFold, prior never mutated), so the shared
    // prior can't corrupt. Pinned by the concurrency test in
    // test/transcript-incremental.test.ts.
    // [LAW:no-silent-failure] ingest MUST stay total — every caller reads
    // `.kind`, so a rejected promise (e.g. PricingService.calculateCostForEntry
    // throwing on a bad rate table or network hiccup inside foldFile) would
    // escape the Outcome contract entirely. The deleted getSessionUsageFromPath
    // wrapped this; keep that guarantee by mapping any throw to `failed`.
    let refolded: {
      prior: SessionRecord | undefined;
      outcome: Outcome<{
        files: Map<string, Folded<FileFold>>;
        sessionInfo: SessionInfo;
        days: Map<string, DayUsage>;
        mainStamp: string;
      }>;
    };
    try {
      refolded = await this.flight.run(`${sessionId}:${stamp}`, async () => {
        const prior = this.sessions.get(sessionId)?.record;
        return {
          prior,
          outcome: await this.refold(sessionId, transcriptPath, prior),
        };
      });
    } catch (error) {
      return failed(
        `usage refold (${sessionId}): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const { prior, outcome } = refolded;
    if (outcome.kind !== "ok") return outcome;
    const record: SessionRecord = {
      files: outcome.value.files,
      sessionInfo: outcome.value.sessionInfo,
      days: outcome.value.days,
      transcriptStamp: outcome.value.mainStamp,
      transcriptPath,
    };
    // Something else landed first (another refold, a sweep): store nothing.
    // Store only over the record this fold started from; a sweep of that record
    // mid-flight is a change too, so its slot is not brought back.
    if (this.sessions.get(sessionId)?.record !== prior) return ok(record);
    this.hold(sessionId).record = record;
    return ok(record);
  }

  // The one write of `lastSeenAt`: the session's slot, refreshed as seen, or
  // undefined while the store holds nothing for it — asking stores nothing.
  private see(sessionId: string): SessionSlot | undefined {
    const slot = this.sessions.get(sessionId);
    if (slot) slot.lastSeenAt = Date.now();
    return slot;
  }

  // The slot something is about to be stored in, created on the first store.
  private hold(sessionId: string): SessionSlot {
    const seen = this.see(sessionId);
    if (seen) return seen;
    const slot: SessionSlot = {
      lastSeenAt: Date.now(),
      record: undefined,
      ring: [],
    };
    this.sessions.set(sessionId, slot);
    return slot;
  }

  // [LAW:dataflow-not-control-flow] Re-fold ONLY the bytes appended since the
  // prior record — the transcript (and each agent sidechain) is append-only, so
  // per-render work is O(new bytes), not O(file). The whole-file case (cold
  // record, or a first-ever read) is the same path with an empty prior: the
  // reader yields the whole file from offset 0. A `failed` read on any file
  // fails the fold (the boundary logs it); an `absent` file (not yet written /
  // agent removed) keeps its prior fold and contributes nothing new.
  private async refold(
    sessionId: string,
    transcriptPath: string,
    prior: SessionRecord | undefined,
  ): Promise<
    Outcome<{
      files: Map<string, Folded<FileFold>>;
      sessionInfo: SessionInfo;
      days: Map<string, DayUsage>;
      mainStamp: string;
    }>
  > {
    // File set for this fold: the main transcript plus the session's current
    // agent sidechains. Files no longer in the set (a removed sidechain) drop
    // out of `newFiles`, so a rewritten/renamed file cannot linger in the merge.
    // Pass the prior file set so already-verified agent sidechains skip their
    // first-line re-read — per-render agent discovery is O(new sidechains).
    const agents = await findAgentTranscripts(
      sessionId,
      dirname(transcriptPath),
      prior === undefined ? undefined : new Set(prior.files.keys()),
    );
    for (const line of widenedLines(agents.reads)) this.log("info", line);
    const newFiles = new Map<string, Folded<FileFold>>();
    let mainStamp = "";
    for (const filePath of [transcriptPath, ...agents.paths]) {
      const priorFold = prior?.files.get(filePath);
      const read = await foldAppended(
        filePath,
        priorFold,
        EMPTY_FILE_FOLD,
        foldFile,
      );
      if (read.kind === "failed") return read;
      if (read.kind === "absent") {
        // The file has no bytes yet (fresh main) or vanished (removed agent
        // sidechain). Carry a prior fold forward; otherwise it contributes
        // nothing. The main transcript's absence leaves mainStamp empty, so the
        // next render's stamp gate re-attempts rather than caching an empty read.
        if (priorFold) newFiles.set(filePath, priorFold);
        continue;
      }
      const { folded, reads } = read.value;
      for (const line of widenedLines(reads)) this.log("info", line);
      newFiles.set(filePath, folded);
      if (filePath === transcriptPath) mainStamp = folded.cursor.stamp;
    }
    return ok({ files: newFiles, ...mergeFolds(newFiles), mainStamp });
  }

  // [LAW:no-ambient-temporal-coupling] `atMs` is the render's instant: a
  // rescan is due by the clock the render is drawn at, and the memo owns that
  // at most one scan per directory set runs.
  private ensureSeeded(
    day: string,
    claudePaths: string[],
    atMs: number,
  ): Promise<void> {
    // Drop other days' memos so the map holds only the current day's.
    if (this.seededDay !== day) {
      this.seeded.clear();
      this.seededDay = day;
    }
    const key = claudePaths.join("\0");
    const existing = this.seeded.get(key);
    if (!existing) {
      const done = this.seed(claudePaths, "seed");
      const memo: DaySeed = { done, scanning: done, startedAtMs: atMs };
      this.seeded.set(key, memo);
      this.settle(key, memo, done);
      return done;
    }
    if (
      existing.scanning === undefined &&
      atMs - existing.startedAtMs >= this.rescanIntervalMs
    ) {
      existing.startedAtMs = atMs;
      existing.scanning = this.seed(claudePaths, "rescan");
      this.settle(key, existing, existing.scanning);
    }
    return existing.done;
  }

  // [LAW:no-silent-failure] A failed scan drops its memo, so the next render
  // seeds afresh and awaits it — `today` is `failed` if that fails too, never
  // a total silently frozen at the last scan that worked.
  private settle(key: string, memo: DaySeed, scan: Promise<void>): void {
    scan.then(
      () => {
        memo.scanning = undefined;
      },
      (error: unknown) => {
        this.log(
          "warn",
          `usageStore scan: ${error instanceof Error ? error.message : String(error)}`,
        );
        if (this.seeded.get(key) === memo) this.seeded.delete(key);
      },
    );
  }

  // Resolves once every scan in flight has settled, whatever its outcome.
  async scanned(): Promise<void> {
    await Promise.allSettled(
      [...this.seeded.values()].map((memo) => memo.scanning),
    );
  }

  // The one whole-tree scan, per day and Claude Code directory set: ingest
  // every session whose transcript was touched recently enough to hold a today
  // entry. A rescan is the same scan over warm records, so it costs a stat per
  // transcript plus the bytes appended since the last one.
  private async seed(
    claudePaths: string[],
    kind: "seed" | "rescan",
  ): Promise<void> {
    const startedMs = Date.now();
    const cutoff = seedCutoffMs();
    const projectPaths = await findProjectPaths(claudePaths);
    const candidates: Array<{
      sessionId: string;
      path: string;
      stamp: string;
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
        let st: { mtimeMs: number; size: number };
        try {
          st = await gatedStat(filePath);
        } catch {
          continue;
        }
        if (st.mtimeMs < cutoff) continue;
        candidates.push({
          sessionId: file.slice(0, -".jsonl".length),
          path: filePath,
          stamp: stampOf(st),
        });
      }
    }

    // [LAW:no-silent-failure] The seed is its own effect edge (timer/lazy
    // driven, no render boundary to carry the outcome to), so its per-session
    // parse failures are logged here.
    const tally: IngestTally = { hits: 0, misses: 0 };
    await mapPool(candidates, SEED_CONCURRENCY, async (c) => {
      const outcome = await this.ingest(c.sessionId, c.path, tally, c.stamp);
      if (outcome.kind === "failed") {
        this.log("warn", `usageStore ${kind}: ${outcome.reason}`);
      }
    });
    // [LAW:nothing-unseen] `read` is how many of the sessions the scan had to
    // read: over warm records, the ones that changed since the last scan.
    this.log(
      "info",
      `usageStore ${kind} sessions=${candidates.length} read=${tally.misses} dirs=${claudePaths.join(",")} ms=${Date.now() - startedMs}`,
    );
    this.scans[kind]++;
  }

  // Public for tests; called periodically from the timer. Drops what nothing
  // reads any more: a session unseen for `staleAgeMs` holding no bucket for the
  // day `today` last summed. A stale record holding one is `held`, since
  // `today` sums it — a session whose transcript the scans have stopped
  // visiting is seen no more, and a day can run past `staleAgeMs` (a 25-hour
  // DST day).
  // [LAW:one-source-of-truth] That day is `seededDay`, taken from the render's
  // instant, not this timer's clock: which day counts is the projection's.
  sweepStale(): number {
    const now = Date.now();
    let dropped = 0;
    let held = 0;
    // Slots dropped holding no record: a session seen only before its
    // transcript had bytes, or with no transcript path at all.
    let noRecord = 0;
    for (const [sid, { lastSeenAt, record }] of this.sessions) {
      if (now - lastSeenAt <= this.staleAgeMs) continue;
      if (record?.days.has(this.seededDay)) {
        held++;
        continue;
      }
      this.sessions.delete(sid);
      dropped++;
      if (record === undefined) noRecord++;
    }
    if (dropped > 0) this.sweeps++;
    // [LAW:nothing-unseen] A sweep that held records for `today` says so.
    if (dropped > 0 || held > 0) {
      this.log(
        "info",
        `usageStore sweep dropped=${dropped} noRecord=${noRecord} held=${held}`,
      );
    }
    return dropped;
  }

  close(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    this.sessions.clear();
    this.seeded.clear();
  }
}
