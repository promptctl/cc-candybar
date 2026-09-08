import { dirname, join } from "node:path";

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
  readAppendedEntries,
  type ClaudeHookData,
  type ParsedEntry,
  type TranscriptCursor,
} from "../../utils/claude";
import {
  readdir as gatedReaddir,
  stat as gatedStat,
  statMtimeMs,
} from "../../utils/transcript-fs";
import { SingleFlight } from "../../utils/single-flight";
import { ABSENT, failed, ok, type Outcome } from "../../utils/outcome";
import { dlog } from "../log";

// [LAW:one-source-of-truth] The single owner of per-session usage: `session` and
// `today` are folds over this store. [LAW:dataflow-not-control-flow] The tree is
// scanned whole exactly once, lazily; every render after is a stat plus a fold.

// [LAW:types-are-the-program] "No usage today" is the `absent` arm, not null fields.
export interface TodayInfo {
  cost: number;
  tokens: number;
  tokenBreakdown: TokenBreakdown;
  date: string;
}

// [LAW:one-source-of-truth] tok/s is the delta between two of these; `atMs` is the caller's clock.
export interface SpeedSample {
  readonly input: number;
  readonly output: number;
  readonly total: number;
  readonly atMs: number;
}

// [LAW:one-source-of-truth] tok/s and the burn-rate history fold from ONE owned ring.
export interface SpeedObservation {
  readonly prev?: SpeedSample;
  readonly cur: SpeedSample;
  readonly samples: readonly SpeedSample[];
}

const SPEED_RING_CAPACITY = 64;

function speedSampleOf(
  breakdown: TokenBreakdown | null,
  atMs: number,
): SpeedSample {
  const input = breakdown
    ? breakdown.input + breakdown.cacheCreation + breakdown.cacheRead
    : 0;
  const output = breakdown ? breakdown.output : 0;
  return { input, output, total: input + output, atMs };
}

// Raw entries are discarded after bucketing: memory is O(days), not O(entries).
interface DayUsage {
  cost: number;
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
}

interface SessionRecord {
  // [LAW:one-source-of-truth] `files` is canonical; the rest is derived by mergeFolds.
  files: Map<string, FileFold>;
  sessionInfo: SessionInfo;
  days: Map<string, DayUsage>;
  transcriptMtime: number;
  transcriptPath: string | undefined;
  lastSeenAt: number;
}

const DEFAULT_MAX_ENTRIES = 256;
const DEFAULT_STALE_AGE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_SWEEP_INTERVAL_MS = 5 * 60 * 1000;
// Bounds the seed's parse fan-out by the same constant as the I/O it drives.
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

// Files older than this hold no "today" entry; a day of slack absorbs rollover skew.
function seedCutoffMs(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - 1);
  return d.getTime();
}

function emptyBreakdown(): TokenBreakdown {
  return { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };
}

// [LAW:one-source-of-truth] `cursor` marks bytes already folded; a session is the MERGE of its files' folds.
interface FileFold {
  cursor: TranscriptCursor;
  entries: number; // usage-bearing entries folded (0 ⇒ empty session, all-null)
  cost: number;
  breakdown: TokenBreakdown;
  days: Map<string, DayUsage>; // keys >= seed cutoff only (pruned on fold)
}

// [LAW:effects-at-boundaries] Pure fold onto a prior fold, returning a FRESH FileFold.
// [LAW:one-source-of-truth] One priced value feeds both the session total and its day bucket.
async function foldFile(
  prior: FileFold | undefined,
  reset: boolean,
  entries: readonly ParsedEntry[],
  cursor: TranscriptCursor,
): Promise<FileFold> {
  // dayKey strings sort lexically == chronologically.
  const keep = dayKey(new Date(seedCutoffMs()));
  const base = prior && !reset ? prior : undefined;
  let count = base?.entries ?? 0;
  let cost = base?.cost ?? 0;
  const breakdown = base ? { ...base.breakdown } : emptyBreakdown();
  const days = new Map<string, DayUsage>();
  if (base) {
    for (const [k, v] of base.days) if (k >= keep) days.set(k, { ...v });
  }
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
    d.cost += priced;
    d.input += u.input_tokens || 0;
    d.output += u.output_tokens || 0;
    d.cacheCreation += u.cache_creation_input_tokens || 0;
    d.cacheRead += u.cache_read_input_tokens || 0;
    days.set(key, d);
  }
  return { cursor, entries: count, cost, breakdown, days };
}

function mergeFolds(files: ReadonlyMap<string, FileFold>): {
  sessionInfo: SessionInfo;
  days: Map<string, DayUsage>;
} {
  let count = 0;
  let cost = 0;
  const bd = emptyBreakdown();
  const days = new Map<string, DayUsage>();
  for (const f of files.values()) {
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

async function mapPool<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<unknown>,
): Promise<void> {
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < items.length) {
      const item = items[cursor++]!;
      await fn(item);
    }
  };
  const width = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: width }, worker));
}

export class SessionUsageStore {
  private readonly entries = new Map<string, SessionRecord>();
  // [LAW:one-source-of-truth] A coalescer, not a cache — the records map IS the cache.
  private readonly flight = new SingleFlight();
  // [LAW:dataflow-not-control-flow] Per-day memo that RETAINS the resolved promise.
  private readonly seeded = new Map<string, Promise<void>>();
  private readonly speedRings = new Map<string, SpeedSample[]>();
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

  // [LAW:no-silent-failure] An empty session is the all-null SessionInfo; top-level `absent` is ingest's.
  async getUsageInfo(
    sessionId: string,
    hookData?: ClaudeHookData,
  ): Promise<Outcome<UsageInfo>> {
    const record = await this.ingest(sessionId, hookData?.transcript_path);
    if (record.kind === "failed") return record;
    const base =
      record.kind === "ok" ? record.value.sessionInfo : EMPTY_SESSION_INFO;
    // [LAW:one-source-of-truth] Claude's total_cost_usd is authoritative; base.cost is
    // the fallback and the only source for `today`. Overlaid at READ time because it
    // changes every render while the transcript total moves only with the file.
    const officialCost = hookData?.cost?.total_cost_usd ?? null;
    return ok({
      session: { ...base, cost: officialCost ?? base.cost, officialCost },
    });
  }

  // [LAW:no-silent-failure] A failed seed or active ingest fails the whole projection.
  async getTodayInfo(hookData?: ClaudeHookData): Promise<Outcome<TodayInfo>> {
    const today = dayKey(new Date());
    try {
      await this.ensureSeeded(today);
    } catch (error) {
      return failed(
        `usage seed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
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

  // [LAW:no-silent-failure] An unknown session yields a zero-count sample, so a first render invents no rate.
  async observeSpeed(
    sessionId: string,
    transcriptPath: string | undefined,
    nowMs: number,
  ): Promise<Outcome<SpeedObservation>> {
    // [LAW:no-ambient-temporal-coupling] Keyed like ingest, so `prev` is read and `cur` written once per state.
    const mtime = statMtimeMs(transcriptPath);
    return this.speedFlight.run(`${sessionId}:${mtime}`, async () => {
      const record = await this.ingest(sessionId, transcriptPath, mtime);
      if (record.kind === "failed") return record;
      const breakdown =
        record.kind === "ok" ? record.value.sessionInfo.tokenBreakdown : null;
      const cur = speedSampleOf(breakdown, nowMs);
      const ring = this.speedRings.get(sessionId) ?? [];
      // [LAW:no-ambient-temporal-coupling] Observation time owns ring order, not
      // ingest-completion order; the post-insert sort keeps the ring oldest→newest.
      let prev: SpeedSample | undefined;
      for (const s of ring) {
        if (s.atMs < cur.atMs && (prev === undefined || s.atMs > prev.atMs)) {
          prev = s;
        }
      }
      ring.push(cur);
      ring.sort((a, b) => a.atMs - b.atMs);
      if (ring.length > SPEED_RING_CAPACITY) ring.shift();
      this.speedRings.set(sessionId, ring);
      return ok({
        ...(prev !== undefined && { prev }),
        cur,
        samples: [...ring],
      });
    });
  }

  // mtime-gated, coalesced re-parse of ONE session; `failed` is NOT cached, so the next render retries.
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
    // No path to read fresh content — preserve the last-known record, don't blank it.
    if (!transcriptPath) return existing ? ok(existing) : ABSENT;

    this.misses++;
    // [LAW:no-ambient-temporal-coupling] Concurrent different-mtime refolds are
    // last-writer-wins and cannot double-count: `refold` writes the byte cursor and
    // its fold as ONE atomic pair always covering [0, cursor).
    // [LAW:no-silent-failure] ingest stays total — any throw maps to `failed`.
    let outcome: Outcome<{
      files: Map<string, FileFold>;
      sessionInfo: SessionInfo;
      days: Map<string, DayUsage>;
      mainMtime: number;
    }>;
    try {
      outcome = await this.flight.run(`${sessionId}:${mtime}`, () =>
        this.refold(sessionId, transcriptPath, this.entries.get(sessionId)),
      );
    } catch (error) {
      return failed(
        `usage refold (${sessionId}): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (outcome.kind !== "ok") return outcome;
    const record: SessionRecord = {
      files: outcome.value.files,
      sessionInfo: outcome.value.sessionInfo,
      days: outcome.value.days,
      transcriptMtime: outcome.value.mainMtime,
      transcriptPath,
      lastSeenAt: Date.now(),
    };
    this.entries.delete(sessionId);
    this.entries.set(sessionId, record);
    this.evictIfNeeded();
    return ok(record);
  }

  // [LAW:dataflow-not-control-flow] Re-fold ONLY the bytes appended since the prior record.
  private async refold(
    sessionId: string,
    transcriptPath: string,
    prior: SessionRecord | undefined,
  ): Promise<
    Outcome<{
      files: Map<string, FileFold>;
      sessionInfo: SessionInfo;
      days: Map<string, DayUsage>;
      mainMtime: number;
    }>
  > {
    // Files no longer in the set drop out, so a renamed file cannot linger in the merge.
    const agentPaths = await findAgentTranscripts(
      sessionId,
      dirname(transcriptPath),
      prior === undefined ? undefined : new Set(prior.files.keys()),
    );
    const newFiles = new Map<string, FileFold>();
    let mainMtime = 0;
    for (const filePath of [transcriptPath, ...agentPaths]) {
      const priorFold = prior?.files.get(filePath);
      const read = await readAppendedEntries(filePath, priorFold?.cursor);
      if (read.kind === "failed") return read;
      if (read.kind === "absent") {
        // An absent main transcript leaves mainMtime 0, so the next render re-attempts.
        if (priorFold) newFiles.set(filePath, priorFold);
        continue;
      }
      const { entries, cursor, reset } = read.value;
      newFiles.set(filePath, await foldFile(priorFold, reset, entries, cursor));
      if (filePath === transcriptPath) mainMtime = cursor.mtimeMs;
    }
    return ok({ files: newFiles, ...mergeFolds(newFiles), mainMtime });
  }

  private ensureSeeded(day: string): Promise<void> {
    const existing = this.seeded.get(day);
    if (existing) return existing;
    this.seeded.clear();
    const promise = this.seed(day);
    this.seeded.set(day, promise);
    promise.catch(() => {
      if (this.seeded.get(day) === promise) this.seeded.delete(day);
    });
    return promise;
  }

  // The one whole-tree scan: lazily, once per day, over recently-touched transcripts.
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

    // [LAW:no-silent-failure] The seed is its own effect edge, so failures log here.
    await mapPool(candidates, SEED_CONCURRENCY, async (c) => {
      const outcome = await this.ingest(c.sessionId, c.path, c.mtime);
      if (outcome.kind === "failed") {
        dlog("warn", `usageStore seed: ${outcome.reason}`);
      }
    });
    this.seeds++;
    dlog("info", `usageStore seed sessions=${candidates.length}`);
  }

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
