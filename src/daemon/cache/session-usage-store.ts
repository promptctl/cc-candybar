import { dirname, join, sep } from "node:path";

import { observable, runInAction, type IObservableValue } from "mobx";

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
  longLineLog,
  unlessGone,
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
import {
  ABSENT,
  failed,
  ok,
  PENDING,
  type Outcome,
  type Reading,
} from "../../utils/outcome";
import { quietLogger, type DaemonLogger } from "../../utils/logger";
import { dateOf, type Instant } from "../../utils/instant";
import { laneOutcome, type Lane } from "../../utils/reading";
import { valueOf } from "../../utils/logfmt";
import type { Holds } from "../../utils/holds";
import { KeyedSource, type KeyedSourceStats } from "../../utils/keyed-source";
import { RefreshLedger, type Refreshes } from "../../utils/refresh-ledger";
import type { Every } from "../../utils/period";
import { Kept } from "../../var-system/store";

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
// incrementally: a Claude Code directory's transcript tree is scanned once
// when a render first asks for its `today` (the seed), to make records for
// sessions that did work before this daemon saw them; every render after that
// is a single-file stat plus a lookup. A session that never renders (headless
// `claude -p`, the Agent SDK) is kept current by RESCANNING the tree on the
// directory's own period while a home holds it — the seed again, which over
// warm records is a stat per transcript plus the bytes appended since the last
// scan (measured: ~75 ms over 6k transcripts).
//
// [LAW:one-source-of-truth] `today` is derived, never summed by its reader:
// records live in an observable map, and each directory's day sums are a kept
// computed over it, so a frame's `today` is one lookup that changes in the
// turn a record does (brandon-unfiled-3248.8ro6, step 3).

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
// [LAW:types-are-the-program] `record` is readonly: a record lands by
// replacing the slot in the observable map (`stored`), the write the day sums
// see, so a write in place — which they would not — does not compile.
interface SessionSlot {
  lastSeenAt: number;
  readonly record: SessionRecord | undefined;
  // [LAW:one-source-of-truth] The recent tok/s observations, a bounded ring
  // (oldest→newest). tok/s is a derivative of the SAME token totals the record
  // owns; the baseline (prior counts + time) is the ring's last element, not a
  // parallel counter. The burn-rate sparkline folds over the whole ring; tok/s
  // folds over its final pair. One call to observeSpeed appends; the pure delta
  // math is render-payload's.
  readonly ring: SpeedSample[];
  // What the session's last request's refreshes answered, which a draw reads
  // as they stand: the record's ingest — `null` when it worked, else why it
  // failed — and the speed observation it took. Observable, so a view's
  // payload over them is recomputed in the turn they land, and boxes of their
  // own, so a request's answer moves no day sum.
  readonly failure: IObservableValue<string | null>;
  readonly speed: IObservableValue<Outcome<SpeedObservation> | undefined>;
}

// A request's one refresh of its session: the stamp it observed, and the
// record that refresh answered.
interface SessionRefresh {
  readonly stamp: string;
  readonly record: Promise<Outcome<SessionRecord>>;
}

// What one statusline request reads of its session's record: each lane over
// the request's one refresh of it.
export interface SessionRequest {
  usage(hookData: ClaudeHookData | undefined): Promise<Outcome<UsageInfo>>;
  speed(nowMs: number): Promise<Outcome<SpeedObservation>>;
  today(today: Lane<DaySums>): Promise<void>;
}

// What one caller's ingests did. Renders share the store's running tally — the
// usage cache's hit rate; each scan keeps its own, reported on its event, so a
// rescan over thousands of warm records cannot pass for render behaviour.
interface IngestTally {
  hits: number;
  misses: number;
}

// What one scan of a directory set did: the sessions recent enough to hold a
// `today` entry, and how many of them it had to read — over warm records, the
// ones that changed since the last scan.
interface Scanned {
  readonly sessions: number;
  readonly read: number;
}

const DEFAULT_STALE_AGE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_SWEEP_INTERVAL_MS = 5 * 60 * 1000;
// How far behind a never-rendering session's work `today` may run, and how
// soon a scan that failed — which is `today`'s failure until one lands — is
// tried again.
const DEFAULT_RESCAN: Every = { okMs: 60 * 1000, failedMs: 10 * 1000 };
// Directory sets nothing holds whose last scan is kept: a user has few
// Claude Code directories, and a held one is never dropped.
const MAX_UNHELD_SCANS = 8;
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

function addDay(into: DayUsage, d: DayUsage): void {
  into.cost += d.cost;
  into.input += d.input;
  into.output += d.output;
  into.cacheCreation += d.cacheCreation;
  into.cacheRead += d.cacheRead;
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
      addDay(d, v);
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

// Whether a transcript path lies under one of a directory set's `projects/`
// roots — exactly when its session's `today` is that set's.
function under(path: string | undefined, roots: readonly string[]): boolean {
  return path !== undefined && roots.some((root) => path.startsWith(root));
}

// [LAW:effects-at-boundaries] One directory set's day sums: each day some
// record under its roots holds a bucket for, the sum of those buckets. Keyed
// by the records' own days, so it reads no clock — the day `today` reads off
// it is the frame's.
function daySumsOver(
  slots: Iterable<SessionSlot>,
  roots: readonly string[],
): ReadonlyMap<string, DayUsage> {
  const sums = new Map<string, DayUsage>();
  for (const { record } of slots) {
    if (record === undefined || !under(record.transcriptPath, roots)) continue;
    for (const [day, d] of record.days) {
      const sum = sums.get(day) ?? { ...EMPTY_DAY };
      addDay(sum, d);
      sums.set(day, sum);
    }
  }
  return sums;
}

// A directory set's `today` state beside its scan: its roots, and its day
// sums derived from the records.
interface DaySet {
  readonly roots: readonly string[];
  readonly sums: Kept<ReadonlyMap<string, DayUsage>>;
}

// What `today`'s lane answers: the set's roots and its day sums as they
// stand. Read through the lane, so whatever tracks the lane moves when a
// record lands, as it does for every other lane.
export interface DaySums {
  readonly roots: readonly string[];
  readonly sums: ReadonlyMap<string, DayUsage>;
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

// The `session` projection's last step, shared by a request's refresh and a
// draw. [LAW:one-source-of-truth] Claude's reported total_cost_usd is the
// authoritative cost of the active session. base.cost (transcript entries
// priced by PricingService against a hand-maintained rate table) is a
// reimplementation — kept ONLY as a fallback for clients that omit cost, and
// to feed the cross-session `today` total, which has no native source (past
// sessions expose only their transcripts, not a live cost figure). The native
// cost is overlaid at READ time, not frozen into the stamp-keyed record,
// because it changes every render while the transcript total moves only when
// the file does.
function usageOver(base: SessionInfo, hookData?: ClaudeHookData): UsageInfo {
  const officialCost = hookData?.cost?.total_cost_usd ?? null;
  return {
    session: { ...base, cost: officialCost ?? base.cost, officialCost },
  };
}

// A slot's answer, stored in the turn it lands.
function answer<T>(box: IObservableValue<T>, value: T): void {
  runInAction(() => box.set(value));
}

export class SessionUsageStore {
  // No count cap: `today` is a fold over every record, so a cap smaller than
  // the day's sessions would drop work from it unseen. A record is a few
  // scalars per file and retained day, and `sweepStale` bounds the map to the
  // sessions seen within `staleAgeMs` plus those holding work done today.
  // Observable, shallowly: a slot replaced is the change the day sums read.
  private readonly sessions = observable.map<string, SessionSlot>(undefined, {
    deep: false,
  });
  // [LAW:one-source-of-truth] Coalesces concurrent MISSES for the same
  // (session, observed stamp) onto one parse; cleared on settle (a coalescer,
  // not a cache — the records map IS the cache).
  private readonly flight = new SingleFlight();
  // [LAW:single-enforcer] The one owner of when a directory set is scanned:
  // its first read is the seed, and its period, which runs only while a home
  // holds the set, is the rescan. Keyed by the directories themselves, so a
  // default that resolves to one directory shares a scan with that directory
  // named outright. Its answer is `today`'s, a failed scan included.
  private readonly scans: KeyedSource<readonly string[], Scanned>;
  // Each directory set's day sums, derived from the records, kept for the
  // store's life: there are as few as the Claude Code directories rendered
  // from, and each reads only this store's own map.
  private readonly daySets = new Map<string, DaySet>();
  // [LAW:no-ambient-temporal-coupling] Explicit owner of observe/commit ordering
  // for the speed sample. Concurrent renders observing the SAME transcript state
  // (key = `${sessionId}:${mtime}`) share ONE observation and commit the baseline
  // exactly once — so they return the same prev+cur and render identical,
  // deterministic throughput instead of the second clobbering the first.
  private readonly speedFlight = new SingleFlight();
  // [LAW:single-enforcer] A request's refresh of a session is one unit of
  // work per (session, observed stamp): the lanes of one request that read
  // the record (session, speed, today) share it, so it records and logs once.
  private readonly requestFlight = new SingleFlight();
  private readonly staleAgeMs: number;
  private readonly log: DaemonLogger;
  private readonly renderTally: IngestTally = { hits: 0, misses: 0 };
  private readonly ledger: RefreshLedger;
  // The session record's refresh, which its statusline request makes; a
  // rescan's reads are its `today` scan's.
  private readonly usage: Refreshes<"request">;
  private sweeps = 0;
  private sweepTimer: NodeJS.Timeout | null = null;

  constructor(
    opts: {
      staleAgeMs?: number;
      sweepIntervalMs?: number;
      rescan?: Every;
      // [LAW:single-enforcer] One injection point, as on GitDataProvider: the
      // daemon passes its log; every other consumer keeps the debug-routed
      // default and never writes daemon.log.
      logger?: DaemonLogger;
      ledger?: RefreshLedger;
    } = {},
  ) {
    this.log = opts.logger ?? quietLogger;
    this.ledger = opts.ledger ?? new RefreshLedger(this.log);
    this.usage = this.ledger.declare({
      name: "usage",
      scope: "session",
      refresh: ["request"],
    });
    this.staleAgeMs = opts.staleAgeMs ?? DEFAULT_STALE_AGE_MS;
    this.scans = new KeyedSource({
      name: "today",
      scope: "configDir",
      keyOf: (paths) => paths.join("\0"),
      fields: (paths) => `dirs=${valueOf(paths.join(","))}`,
      read: (paths) => this.scan(paths),
      every: opts.rescan ?? DEFAULT_RESCAN,
      maxEntries: MAX_UNHELD_SCANS,
      logger: this.log,
      ledger: this.ledger,
    });
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
  } {
    return {
      size: this.sessions.size,
      hits: this.renderTally.hits,
      misses: this.renderTally.misses,
      sweeps: this.sweeps,
    };
  }

  // The scans as a source: the directory sets kept, those a home holds, the
  // seeds (`first`) and rescans (`period`), and how many failed.
  scanStats(): KeyedSourceStats {
    return this.scans.stats();
  }

  // The `session` projection: whole-session totals for the active session.
  // [LAW:no-silent-failure] A failed transcript parse flows out as `failed`
  // (the payload boundary logs it); an unknown/empty session is the all-null
  // SessionInfo whose fields the boundary drops per-field — top-level
  // `absent` is reserved for ingest, since the native officialCost overlay
  // applies even with no record.
  getUsageInfo(
    sessionId: string,
    hookData?: ClaudeHookData,
  ): Promise<Outcome<UsageInfo>> {
    return this.request(sessionId, hookData?.transcript_path).usage(hookData);
  }

  // [LAW:no-ambient-temporal-coupling] One statusline request's refresh of
  // its session, as a value: the request's session, speed and today lanes
  // read the one refresh it starts, whichever asks first and whenever the
  // others land, so it reads, records and logs once per request.
  request(
    sessionId: string,
    transcriptPath: string | undefined,
  ): SessionRequest {
    let refresh: SessionRefresh | null = null;
    const once = (): SessionRefresh => {
      if (refresh !== null) return refresh;
      const stamp = statStamp(transcriptPath);
      refresh = {
        stamp,
        record: this.refreshed(sessionId, transcriptPath, stamp),
      };
      return refresh;
    };
    return {
      usage: async (hookData) => {
        const record = await once().record;
        if (record.kind === "failed") return record;
        return ok(
          usageOver(
            record.kind === "ok"
              ? record.value.sessionInfo
              : EMPTY_SESSION_INFO,
            hookData,
          ),
        );
      },
      speed: (nowMs) => this.observed(sessionId, once, nowMs),
      // [LAW:no-ambient-temporal-coupling] The scan first, then the
      // session's own refresh: run together, a seed's ingest of this session
      // and the request's are two cold parses at two stamps, and whichever
      // lands second is not stored — the request's own, newer fold among
      // them. A refresh another lane already started is the one awaited.
      today: async (today) => {
        await laneOutcome(today);
        await once().record;
      },
    };
  }

  // The `session` projection as the session's last refresh left it, for a
  // draw: no I/O, no fold. A session no refresh has answered (or one the sweep
  // dropped) is not answered yet; one whose refresh found no transcript is the
  // empty record its refresh answers for it.
  usageOf(sessionId: string, hookData: ClaudeHookData): Reading<UsageInfo> {
    const slot = this.sessions.get(sessionId);
    if (slot === undefined) return PENDING;
    const failure = slot.failure.get();
    if (failure !== null) return failed(failure);
    return ok(
      usageOver(slot.record?.sessionInfo ?? EMPTY_SESSION_INFO, hookData),
    );
  }

  // A request's ingest of its own session, whose outcome the session's slot
  // keeps for the draws until the next one.
  private refreshed(
    sessionId: string,
    transcriptPath: string | undefined,
    stamp: string,
  ): Promise<Outcome<SessionRecord>> {
    return this.requestFlight.run(`${sessionId}:${stamp}`, async () => {
      // [LAW:no-ambient-temporal-coupling] This refresh's own tally, so
      // whether IT read is its own fact, never another session's refresh
      // landing in the same await.
      const tally: IngestTally = { hits: 0, misses: 0 };
      const startedAt = Date.now();
      const record = await this.ingest(sessionId, transcriptPath, tally, stamp);
      this.renderTally.hits += tally.hits;
      this.renderTally.misses += tally.misses;
      if (tally.misses > 0) {
        this.usage.recorded(
          `sid=${valueOf(sessionId)}`,
          "request",
          record,
          Date.now() - startedAt,
        );
      }
      // The session's slot records that its refresh answered — a failure
      // kept so the draws until the next refresh show it.
      answer(
        this.hold(sessionId).failure,
        record.kind === "failed" ? record.reason : null,
      );
      return record;
    });
  }

  // The `today` projection: cross-session sum of every record's today bucket.
  // [LAW:no-silent-failure] A failed scan or a failed active-session ingest
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
  //
  // A request's refresh of `today`: the active session's own record — so
  // `today` keeps up with the cost it was sent with (short only by what a
  // rescan's fold of the same session stores first, `ingest`) — once the
  // directory set's first scan, which `today`'s lane waits on, has landed.
  refreshToday(
    today: Lane<DaySums>,
    hookData: ClaudeHookData | undefined,
  ): Promise<void> {
    return this.request(
      hookData?.session_id ?? "",
      hookData?.transcript_path,
    ).today(today);
  }

  // [LAW:single-enforcer] A view's declaration of `today` (declareLanes in
  // src/daemon/render-payload.ts): the directory set's scans, held, so a set
  // no scan has answered starts its first one now — before the request or the
  // frame that reads it. The lane answers the set's day sums once a scan has
  // answered; which day of them is the draw's (`todayAt`).
  declareToday(
    holds: Holds,
    claudeConfigDir: string | undefined,
  ): Lane<DaySums> {
    const claudePaths = getClaudePaths(claudeConfigDir);
    const scans = this.scans.declare(holds, claudePaths);
    const set = this.daySet(claudePaths);
    return {
      current: () => {
        const scan = scans.current();
        return scan.kind === "ok"
          ? ok({ roots: set.roots, sums: set.sums.read() })
          : scan;
      },
    };
  }

  // The `today` projection as the records stand, for a draw: the directory
  // set's day sums at the day of `at`, so a frame past midnight sums the new
  // day with no refresh. The active session's last ingest failing is the
  // projection's failure.
  todayAt(
    set: DaySums,
    hookData: ClaudeHookData | undefined,
    at: Instant,
  ): Outcome<TodayInfo> {
    const active = this.sessions.get(hookData?.session_id ?? "");
    const failure = active?.failure.get() ?? null;
    if (failure !== null) return failed(failure);

    const today = dayKey(dateOf(at));
    const total: DayUsage = { ...EMPTY_DAY };
    const inSet = set.sums.get(today);
    if (inSet !== undefined) addDay(total, inSet);
    // The rendering session counts wherever its transcript lives; under the
    // set's roots it is already in the sums.
    const own = under(active?.record?.transcriptPath, set.roots)
      ? undefined
      : active?.record?.days.get(today);
    if (own !== undefined) addDay(total, own);

    if (inSet === undefined && own === undefined) return ABSENT;
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
  observeSpeed(
    sessionId: string,
    transcriptPath: string | undefined,
    nowMs: number,
  ): Promise<Outcome<SpeedObservation>> {
    return this.request(sessionId, transcriptPath).speed(nowMs);
  }

  // A request's speed sample, over the request's one refresh of the session.
  private async observed(
    sessionId: string,
    refresh: () => SessionRefresh,
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
    const { stamp, record: refreshed } = refresh();
    return this.speedFlight.run(`${sessionId}:${stamp}`, async () => {
      const record = await refreshed;
      if (record.kind === "failed") {
        answer(this.hold(sessionId).speed, record);
        return record;
      }
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
      const observed = ok({
        ...(prev !== undefined && { prev }),
        cur,
        samples: [...ring],
      });
      answer(this.hold(sessionId).speed, observed);
      return observed;
    });
  }

  // The session's speed as its last request observed it, for a draw: a frame
  // takes no sample, so how often the bar is drawn moves no rate.
  speedOf(sessionId: string): Reading<SpeedObservation> {
    if (!sessionId) return ABSENT;
    return this.sessions.get(sessionId)?.speed.get() ?? PENDING;
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
    // The transcript's stamp as the caller observed it.
    stamp: string,
  ): Promise<Outcome<SessionRecord>> {
    if (!sessionId) return ABSENT;
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
    // on it: the first to land replaces the prior, and the other folds again
    // over what landed (below), so neither caller's fold is lost and a request
    // that lands second still stores its newer stamp. So the stored record only ever
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
    // Store only over the record this fold started from. A sweep of that
    // record mid-flight is a change too, so its slot is not brought back.
    const landed = this.sessions.get(sessionId)?.record;
    if (landed === prior) {
      this.stored(sessionId, record);
      return ok(record);
    }
    if (landed === undefined) return ok(record);
    // [LAW:no-ambient-temporal-coupling] Another fold landed first — a
    // rescan's at an older stamp, say. Fold again over it at this stamp, so
    // the newer fold is never the one dropped: an incremental read of what
    // lies past it, or a hit when it already covers this stamp. Each retry
    // starts from what landed, so the stored record only advances.
    return this.ingest(sessionId, transcriptPath, tally, stamp);
  }

  // [LAW:single-enforcer] The one write of a slot's record: the slot is
  // replaced in the observable map, which is the change the day sums derive
  // from.
  private stored(sessionId: string, record: SessionRecord): void {
    const slot = this.hold(sessionId);
    runInAction(() => this.sessions.set(sessionId, { ...slot, record }));
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
      failure: observable.box<string | null>(null),
      speed: observable.box<Outcome<SpeedObservation> | undefined>(undefined, {
        deep: false,
      }),
    };
    runInAction(() => this.sessions.set(sessionId, slot));
    return slot;
  }

  // A directory set's day sums, derived on first ask and kept with the store.
  private daySet(claudePaths: readonly string[]): DaySet {
    const key = claudePaths.join("\0");
    const known = this.daySets.get(key);
    if (known !== undefined) return known;
    const roots = claudePaths.map((dir) => join(dir, "projects") + sep);
    const set: DaySet = {
      roots,
      sums: new Kept(`today over ${claudePaths.join(",")}`, () =>
        daySumsOver(this.sessions.values(), roots),
      ),
    };
    this.daySets.set(key, set);
    return set;
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
    for (const line of longLineLog(agents.longLines)) this.log("info", line);
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
      const { folded, longLines } = read.value;
      for (const line of longLineLog(longLines)) this.log("info", line);
      newFiles.set(filePath, folded);
      if (filePath === transcriptPath) mainStamp = folded.cursor.stamp;
    }
    return ok({ files: newFiles, ...mergeFolds(newFiles), mainStamp });
  }

  // The one whole-tree scan of a directory set — its seed, or a rescan:
  // ingest every session whose transcript was touched recently enough to hold
  // a today entry. A rescan is the same scan over warm records, so it costs a
  // stat per transcript plus the bytes appended since the last one.
  // [LAW:no-silent-failure] A scan that throws, or that could not read a
  // session it found, answers as failed, which is `today`'s failure until a
  // scan lands — never a sum silently missing the sessions it did not reach.
  // Only a file or directory gone between the listing and its read (ENOENT) is
  // absence.
  private async scan(
    claudePaths: readonly string[],
  ): Promise<Outcome<Scanned>> {
    try {
      const cutoff = seedCutoffMs();
      const projectPaths = await findProjectPaths(claudePaths);
      const candidates: Array<{
        sessionId: string;
        path: string;
        stamp: string;
      }> = [];

      for (const dir of projectPaths) {
        const files = await unlessGone(gatedReaddir(dir));
        for (const file of files ?? []) {
          if (!file.endsWith(".jsonl")) continue;
          const filePath = join(dir, file);
          const st = await unlessGone(gatedStat(filePath));
          if (st === undefined || st.mtimeMs < cutoff) continue;
          candidates.push({
            sessionId: file.slice(0, -".jsonl".length),
            path: filePath,
            stamp: stampOf(st),
          });
        }
      }

      // [LAW:no-silent-failure] The scan is its own effect edge (its period's,
      // no render boundary to carry each outcome to), so each session it could
      // not read is logged here, and the first answers for them all.
      const failures: string[] = [];
      const tally: IngestTally = { hits: 0, misses: 0 };
      await mapPool(candidates, SEED_CONCURRENCY, async (c) => {
        const outcome = await this.ingest(c.sessionId, c.path, tally, c.stamp);
        if (outcome.kind === "failed") {
          failures.push(outcome.reason);
          this.log("warn", `usageStore scan: ${outcome.reason}`);
        }
      });
      // [LAW:nothing-unseen] `read` is how many of the sessions the scan had to
      // read: over warm records, the ones that changed since the last scan. Its
      // trigger and duration are the source's refresh event.
      this.log(
        "info",
        `usageStore scan dirs=${valueOf(claudePaths.join(","))} sessions=${candidates.length} read=${tally.misses} failed=${failures.length}`,
      );
      if (failures.length > 0) {
        return failed(
          `usage scan: ${failures.length} of ${candidates.length} sessions could not be read — ${failures[0]}`,
        );
      }
      return ok({ sessions: candidates.length, read: tally.misses });
    } catch (error) {
      return failed(
        `usage scan: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // Public for tests; called periodically from the timer. Drops what nothing
  // reads any more: a session unseen for `staleAgeMs` holding no bucket for
  // today. A stale record holding one is `held`, since `today` sums it — a
  // session whose transcript the scans have stopped visiting is seen no more,
  // and a day can run past `staleAgeMs` (a 25-hour DST day).
  // [LAW:one-source-of-truth] Today is the day of the sweep's own `now`: the
  // wall clock a frame's instant and the scan's cutoff read too.
  sweepStale(): number {
    const now = Date.now();
    const today = dayKey(new Date(now));
    let dropped = 0;
    let held = 0;
    // Slots dropped holding no record: a session seen only before its
    // transcript had bytes, or with no transcript path at all.
    let noRecord = 0;
    // One action: the day sums see the sweep as one change.
    runInAction(() => {
      for (const [sid, { lastSeenAt, record }] of [...this.sessions]) {
        if (now - lastSeenAt <= this.staleAgeMs) continue;
        if (record?.days.has(today)) {
          held++;
          continue;
        }
        this.sessions.delete(sid);
        dropped++;
        if (record === undefined) noRecord++;
      }
    });
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
    this.scans.close();
    runInAction(() => {
      for (const { sums } of this.daySets.values()) sums.release();
      this.sessions.clear();
    });
    this.daySets.clear();
  }
}
