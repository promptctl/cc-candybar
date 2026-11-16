import type { SessionId } from "../daemon/foundations/session-id";
import type { ActivityInfo } from "../segments/activity";
import type { AutoCompactWindow } from "../segments/autocompact";
import type { GitRead, PullRequest } from "../segments/git";
import type { MetricsFold } from "../segments/metrics";
import type { TranscriptUsage } from "../segments/session";
import type { JsonValue } from "../var-system/types";
import type { Fact } from "./fact";
import { pendingOf } from "../utils/outcome";
import type { FileEventsWarning } from "../daemon/foundations/file-events-warnings";
import type { LauncherFact } from "../proc/launcher";
import type { HeldEvent } from "../utils/event-hold";

// [LAW:types-are-the-program] The seam between the host and a renderer: one
// total document per session. Every field exists on every document; a fact
// not yet known is the `pending` arm, one found to be nothing is `absent`, one
// whose read failed carries its reason and the phase it failed in. The value
// types are the ones the daemon's owners already produce, so each owner's
// current output is its fact's `T` as it stands.
//
// What stays out is the renderer's: the hook's instantaneous fields, client
// hints, settings, picks, config facts, feeds, the drawing and the menu. The
// payload a template reads is composed from these, the hook, the hints and the
// renderer's own state.

// What the declared plugin sources read, by their variables' names.
export type SourceId = string;
export type SourceValue = JsonValue;

// [LAW:types-are-the-program] What a `shell` or `file` run read, and why its
// watch may be missing changes (`null` when it hears every place its path can
// change, or watches nothing). Keyed apart from the plugin sources, by the
// run's digest, so two variables naming one run read one entry.
export interface RunFact {
  readonly reading: Fact<SourceValue>;
  readonly fault: string | null;
}

// [LAW:types-are-the-program] A run no world state carries yet: never read,
// with no watch to fault.
export const UNREAD_RUN: RunFact = {
  reading: pendingOf("unread"),
  fault: null,
};

// The tmux session the pane belongs to.
export interface TmuxFacts {
  readonly session: string;
}

// A fault of the collector's own: one lane of the session whose refresh threw,
// or the stamp itself, which kept the readings of the document before it.
export interface LaneDiagnostic {
  readonly kind: "lane";
  readonly lane: RefreshLane;
  readonly reason: string;
}
export interface StampDiagnostic {
  readonly kind: "stamp";
  readonly reason: string;
}
export type FactsDiagnostic = LaneDiagnostic | StampDiagnostic;

// [LAW:types-are-the-program] What every session's document carries of the
// daemon itself, by whose it is: the update, whether file events are heard,
// and what the launcher stands behind (whether what it launches dies with it,
// and the latest pipe event, whose hold each draw judges at its own instant
// and for whom it draws, src/utils/event-hold.ts), how the last renderer
// process ended, and the acts that failed with no session's bar to hold them
// (one no session asked for, or one whose renderer had ended), each held the
// same way: null while none has.
export interface DaemonFacts {
  readonly update: UpdateState;
  readonly fileEvents: readonly FileEventsWarning[];
  readonly launcher: readonly LauncherFact[];
  readonly rendererEnded: HeldEvent | null;
  readonly actFailed: HeldEvent | null;
}

// [LAW:types-are-the-program] `session`, `context` and `metrics` are the
// transcript's folds alone: the hook's instantaneous fields (cost, the
// context window, durations, lines) are the renderer's, laid over them when
// the payload is composed, so a document is gathered from the session's
// locator and never from a request.
export interface BuiltinFacts {
  readonly session: Fact<TranscriptUsage>;
  readonly today: Fact<TodayFacts>;
  readonly speed: Fact<SpeedObservation>;
  // The transcript's context tokens: its newest main-chain usage entry's.
  readonly context: Fact<number>;
  readonly metrics: Fact<MetricsFold>;
  readonly activity: Fact<ActivityInfo>;
  readonly cache: Fact<number>;
  readonly autocompact: Fact<AutoCompactWindow>;
  // The repository's read; its PR is its own fact, because its cost is its own.
  readonly git: Fact<GitRead>;
  readonly pr: Fact<PullRequest>;
  readonly tmux: Fact<TmuxFacts>;
  // The host's name and its user are read apart and fail apart (a directory
  // service briefly away fails the user alone), so each is its own fact.
  readonly hostName: Fact<string>;
  readonly hostUser: Fact<string>;
}

export interface WorldState {
  readonly v: number;
  readonly session: SessionId;
  readonly seq: number;
  readonly builtins: BuiltinFacts;
  readonly sources: Readonly<Record<SourceId, Fact<SourceValue>>>;
  readonly runs: Readonly<Record<string, RunFact>>;
  readonly daemon: DaemonFacts;
  readonly diagnostics: readonly FactsDiagnostic[];
}

// [LAW:types-are-the-program] The act on an update as every daemon sees it.
// `succeeded` is its own arm, not `idle`, so a daemon watching an act end can
// tell a rebuilt bundle from nothing having happened.
export type ActState =
  | { readonly kind: "idle" }
  | { readonly kind: "running"; readonly act: number }
  | { readonly kind: "succeeded"; readonly act: number }
  | {
      readonly kind: "failed";
      readonly act: number;
      readonly identity: string;
      readonly reason: string;
    };

export const IDLE: ActState = { kind: "idle" };

// What the update notice is folded from: what is newer than the running code,
// the act on it as its files were last read, and why those files could not be
// read (null when they could).
export interface UpdateState {
  readonly newer: Fact<Update>;
  readonly act: ActState;
  readonly actsError: string | null;
}

// [LAW:one-source-of-truth] One observation of the active session's cumulative
// token counts, taken when its transcript is written. tok/s is the delta
// between two of these — the prior sample lives in the session usage store (the
// single owner of per-session token totals), never in a parallel counter.
// `input` folds the cache lanes into the prompt-side total so
// `total === input + output`. `atMs` is the refresh's clock instant (the
// daemon's single-enforcer clock), so a frozen test clock makes the rate
// deterministic. `turnOpen` is whether Claude was still working on a turn as
// of that write: the interval after a sample in an open turn is generation,
// and the one after a closed turn is the person's idle time.
export interface SpeedSample {
  readonly input: number;
  readonly output: number;
  readonly total: number;
  readonly atMs: number;
  readonly turnOpen: boolean;
}

// The session's recent samples, oldest→newest. The pure projections live at
// the render-payload boundary; the session usage store only remembers and
// reports. [LAW:one-source-of-truth] tok/s and the burn-rate history fold
// from this one ring, never two parallel stores.
export interface SpeedObservation {
  readonly samples: readonly SpeedSample[];
}

// The `today` fact and its projection, apart from the store that remembers the
// records (session-usage-store.ts): a draw's day is a pure function of the
// fact and the draw's instant, so what reads it (the draw, `check`)
// does not load the store's pricing, transcript reads or observables.

// Per-(session, day) scalar contribution — the only granularity the today fold
// needs. Raw entries are discarded after bucketing, so per-session retained
// memory is O(retained-days), not O(entries).
export interface DayUsage {
  cost: number;
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
}

// [LAW:types-are-the-program] Everything the `today` projection reads: the
// directory set's day sums, and the rendering session's own days the sums do
// not hold (a session whose transcript lies outside the set's projects; one
// under them is in `sums` already, so its `own` is empty). The session's
// ingest failing is not a field, it is the fact failing.
export interface TodayFacts {
  readonly sums: Readonly<Record<string, DayUsage>>;
  readonly own: Readonly<Record<string, DayUsage>>;
}

// The lanes a session's transcript read refreshes
// (src/daemon/cache/transcript-lanes.ts). [LAW:one-source-of-truth] The list is
// the one declaration: the type derives from it, and a facts document's
// diagnostics walk it in this order.
export const REFRESH_LANES = [
  "session",
  "context",
  "metrics",
  "activity",
  "cache",
  "speed",
  "autocompact",
] as const;

export type RefreshLane = (typeof REFRESH_LANES)[number];

// [LAW:types-are-the-program] What is newer than the running code. `source`
// is a checkout whose tree no longer matches the bundle; `release` is an
// install behind the registry. Each carries both sides of the comparison
// under one name pair, so the sentence reads the same fields off either.
export type Update =
  | {
      readonly kind: "source";
      readonly root: string;
      readonly newer: SourceStamp;
      readonly running: SourceStamp;
    }
  | {
      readonly kind: "release";
      readonly newer: Version;
      readonly running: Version;
    };

// [LAW:types-are-the-program] A release version is exactly MAJOR.MINOR.PATCH.
// semantic-release on `main` mints nothing else, and the ordering the currency
// verdict needs is total only over that shape — so the parser refuses anything
// else rather than admitting a prerelease it could not order.
export type Version = readonly [major: number, minor: number, patch: number];

export function formatVersion(v: Version): string {
  return v.join(".");
}

// What identifies a build to a person: the version it reports and the
// digest of the source it was built from.
export interface SourceStamp {
  readonly version: string;
  readonly digest: string;
}

// How much of a digest a person is shown: seven hex characters, the length
// git abbreviates a commit to, so the identifier reads as the familiar
// short hash rather than a wall of hex.
export const SHORT_DIGEST_LENGTH = 7;

export const shortDigest = (digest: string): string =>
  digest.slice(0, SHORT_DIGEST_LENGTH);

// Why the document is drawn from older facts, or null when its stamp held.
export function stampFailureOf(document: WorldState): string | null {
  return document.diagnostics.find((d) => d.kind === "stamp")?.reason ?? null;
}
