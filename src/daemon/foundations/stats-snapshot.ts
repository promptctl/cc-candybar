// The shapes of the daemon's stats reply: what each owner reports of itself,
// as the stats client prints it.

import type { TranscriptReads } from "../../utils/transcript-fs";

import type { SourceRecord, SourceScope } from "../../utils/refresh-ledger";

import type { RenderSighting } from "./sightings";
import type { ServingDaemon } from "./memory-limit";

import type { KeyedSourceStats } from "../../utils/keyed-source";

import type { MarkBook, PostMortemsRead } from "../../doctor/checks";
import type { Asked } from "../../utils/outcome";

// The keyed sources whose entries a view holds, so a period visits only
// those held: a repo's, a pane's, the host's name and user, a directory
// set's scans, a plugin's session files, a session's transcript lanes.
export type HeldSource =
  | "git"
  | "tmux"
  | "host"
  | "today"
  | "pluginStorage"
  | "transcript";

// [LAW:nothing-unseen] Every source and every home, from the owners that keep
// them (design-docs/SOURCES-AND-FRAMES.md, "Seen").
export interface SourceSnapshots {
  // Every source declared, from the one ledger: its scope, its refreshes by
  // the trigger that asked, its failures and its last refresh's length.
  readonly records: readonly SourceRecord[];
  // How many homes of each scope are kept now.
  readonly homes: Readonly<Record<SourceScope, number>>;
  // How many entries of each keyed source a view holds now.
  readonly held: Readonly<Record<HeldSource, number>>;
  // Every plugin's managed storage: the folders watched now, watch faults by
  // cause, and folders found gone or replaced.
  readonly pluginStorage: Pick<
    ManagedStorageStats,
    "folders" | "faults" | "lost"
  >;
}

// A distribution of durations, in ms to the hundredth: how many,
// the percentiles, the largest, and the mean and standard deviation. Read
// from a histogram of every one, never a sample, so p99 means the 99th
// percentile of all of them.
export interface Durations {
  count: number;
  p50Ms: number;
  p90Ms: number;
  p99Ms: number;
  p999Ms: number;
  maxMs: number;
  meanMs: number;
  stddevMs: number;
}

export interface StatsSnapshot {
  pid: number;
  // [LAW:one-source-of-truth] The daemon's own baked package stamp — set
  // against `cc-candybar --version` to diagnose client-vs-daemon skew in one
  // step. The wire contract number is a different fact under its own name.
  version: string;
  // The digest of the source the daemon's bundle was built from (`null` for a
  // bundle carrying none) — with `version`, the build's identity: a source
  // checkout rebuilds without bumping the version, and a client of another
  // build cannot read this snapshot's shape as its own.
  sourceDigest: string | null;
  protocolVersion: number;
  startedAt: string;
  uptimeSec: number;
  rssBytes: number;
  heapUsedBytes: number;
  heapTotalBytes: number;
  externalBytes: number;
  arrayBuffersBytes: number;
  requests: {
    total: number;
    errored: number;
    timedOut: number;
    inFlight: number;
    // [LAW:one-source-of-truth] How long each render request took, from its
    // start to its answer: every render event's `took`, a refused request's
    // included.
    took: Durations;
  };
  // Hook-data fields this daemon has been sent that its schema does not know:
  // what Anthropic has added since the schema was written.
  unknownHookFields: string[];
  gitCache: GitCacheStats;
  usageCache: {
    size: number;
    hits: number;
    misses: number;
    sweeps: number;
  };
  sources: SourceSnapshots;
  // [LAW:nothing-unseen] Whether the OS is delivering file events, and since
  // when the daemon cannot vouch that it heard every one.
  fileEvents: FileEventsStats;
  // [LAW:nothing-unseen] The declared sources' runs: per read kind, the
  // entries, how many are held, and the ledger's tallies; and the path
  // watches armed for them.
  sourceRuns: SourceRunsStats;
  // [LAW:nothing-unseen] Every forward transcript read since start: gated
  // reads, bytes off disk, lines longer than the fold window read whole and
  // the longest of them — what bounds a fold's memory beyond its window
  // (brandon-unfiled-3248.bfnj).
  transcriptReads: TranscriptReads;
  // Config states: entries the map serves, those a render is drawing with
  // now, and those retired (evicted or reloaded over) whose teardown waits
  // on one. `retired` climbing while `size` holds is a render that never
  // returned. `compiles` below `size` is entries sharing one; `accountedBytes`
  // is what the entries are charged against `budgetBytes`.
  renderCache: RenderCacheStats;
  // Sessions the host's collector reads, and those whose retire is on its way
  // to the renderer: `sessions` climbing with no requests is a session the
  // sweep never retires.
  collector: CollectorStats;
  effectCache: {
    sessions: number;
    effects: number;
  };
  // Sessions whose idle clock the renderer keeps, and those whose menus it
  // will close when their idle period runs out (src/renderer/menu-idle.ts).
  menuIdle: MenuIdleStats;
  // The renderer's mailbox (src/daemon/renderer-host.ts): the input in its
  // turn and for how long, and how many wait behind it. A holder held long is
  // a turn the renderer has not answered.
  mailbox: MailboxStats;
  // `run` acts (src/daemon/runs.ts): programs started, those that failed
  // (a non-zero exit or no start), timed out, and runs in flight now.
  runs: RunStats;
  // The per-session click store: how many sessions it holds, how many
  // derivations are subscribed to it, and its revision — how many changes it
  // has taken. Observers climbing while renderCache holds steady is a
  // disposed config's store still held; the revision climbing while nobody
  // clicks is something writing session state on every render.
  sessionState: {
    sessions: number;
    observers: number;
    revision: number;
  };
  // Subscribed sessions, their subscribers, and the frames drawn for them and
  // pushed (a drawn frame identical to the last is not pushed).
  frameFeeds: FeedStats;
  // The tmux status line lane's writes (src/daemon/tmux-status.ts): sessions
  // it draws, status lines it has laid out, tmux invocations, failed ones.
  tmuxStatus: TmuxStatusStats;
  // Watch slots: open now, opened with every target watched, closed, opened
  // with a target the OS refused, and errors watches reported after opening.
  // `dirs`: the OS directory watches the slots share, open now, opened and
  // closed, a reopen counting one of each; on macOS each open or close
  // rebuilds the one FSEvents stream, so this is the churn that costs.
  // `polled`: the paths the sweep reads now, which hold no OS watch.
  watchers: {
    active: number;
    opened: number;
    closed: number;
    refused: number;
    errors: number;
    dirs: { active: number; opened: number; closed: number };
    polled: number;
  };
  subprocesses: {
    total: number;
    inFlight: number;
    lastMinute: number;
    byCategory: Record<string, number>;
    refused: Record<string, number>;
    // Pipes held open past their launch, the bytes read from them and dropped,
    // how many the launcher cut at the bound, and the launched pipes that
    // failed to read.
    draining: number;
    drainedBytes: number;
    drainsCut: number;
    pipeErrors: number;
    // How long each category's launches ran, keyed as `byCategory` is.
    durations: Record<string, Durations>;
  };
  nextRestartReason: string | null;
  // Each session's latest client, as this daemon process saw its last render
  // request (src/daemon/render-sightings.ts), and the bundle this daemon
  // runs.
  clients: readonly RenderSighting[];
  bundle: string;
  // This daemon's memory against its budget (src/daemon/limits.ts
  // `serving`).
  daemon: ServingDaemon;
}

export interface CollectorStats {
  readonly sessions: number;
  readonly retiring: number;
}

export interface MenuIdleStats {
  readonly sessions: number;
  readonly armed: number;
}

export interface RunStats {
  readonly started: number;
  // Ended with a non-zero exit, or could not be started.
  readonly failed: number;
  readonly timedOut: number;
  // Never started: the host held no environment for its session.
  readonly refused: number;
  // In flight now.
  readonly running: number;
}

export interface TmuxStatusStats {
  readonly sessions: number;
  readonly layouts: number;
  readonly writes: number;
  readonly failedWrites: number;
}

export interface FeedStats {
  readonly feeds: number;
  readonly subscribers: number;
  readonly drawn: number;
  readonly pushed: number;
  // Subscriptions refused or ended because their lane was off.
  readonly refused: number;
  // `newestWhere` lookups (a tmux bar pane asking whose bar its pane holds),
  // and how many found a session.
  readonly lookups: number;
  readonly found: number;
}

// [LAW:nothing-unseen] The states renders are drawing with now, and those
// retired but not yet reclaimed because one still is (`daemon-stats`):
// `retired` climbing while `size` holds is a render that never returned.
export interface RenderCacheStats {
  readonly size: number;
  readonly held: number;
  readonly retired: number;
  // Distinct compiles the cache holds — below `size` exactly when entries
  // share them.
  readonly compiles: number;
  // Sessions' views served now: one per session at most.
  readonly views: number;
  // Sessions an open feed pins (`pin`).
  readonly pinned: number;
  // Views retired but not yet disposed because a render still holds one: as
  // `retired` is for states, climbing while `views` holds is a render that
  // never returned.
  readonly retiredViews: number;
  // The transitions in flight on the views' surfaces, each a rich-js effect
  // holding its settled shares: climbing while `views` holds is a surface
  // whose passages never end.
  readonly passages: number;
  // What the entries the map serves are charged against the budget.
  readonly accountedBytes: number;
  readonly budgetBytes: number;
}

// `held` counts the repos a home holds — the ones the period visits.
// `changes` counts the watch fires on a known repo.
export interface GitCacheStats {
  size: number;
  held: number;
  hits: number;
  misses: number;
  changes: number;
  watchers: number;
  // Branch ref directories the repos' watches could not list, so hear
  // nothing below.
  unlisted: number;
}

export interface ManagedStorageStats extends KeyedSourceStats {
  // Folders watched now.
  readonly folders: number;
  readonly faults: Readonly<Record<FaultCause, number>>;
  // Folders found gone or replaced under their watch.
  readonly lost: number;
}

export interface FileEventsStats {
  readonly delivery: Delivery;
  // Every move into a stall, every span closed, and the probes written and
  // failed.
  readonly stalls: number;
  readonly catchUps: number;
  readonly probes: number;
  readonly probeFailures: number;
}

export interface SourceRunsStats {
  readonly shell: KeyedSourceStats;
  readonly file: KeyedSourceStats;
  readonly watches: number;
}

export interface MailboxStats {
  // The input in the renderer's turn and for how long; `queued` wait behind
  // it.
  readonly holder: string | null;
  readonly heldMs: number;
  readonly queued: number;
}

// [LAW:one-source-of-truth] The documents the doctor keeps under the daemon's
// state directory, by what each holds: the stores that file them
// (src/doctor/edge.ts) and what a run reads of them both map over this one
// list.
export interface DoctorStoreValues {
  // The marks the user has made on what the doctor showed them, kept for
  // good (src/doctor/mark-book.ts).
  readonly marks: MarkBook;
  // The terminals a doctor click has come back from, kept for good
  // (src/doctor/clicked-terminals.ts).
  readonly clicked: readonly string[];
  // The newest post-mortem the user filed as read
  // (src/doctor/post-mortems-read.ts).
  readonly postMortemsRead: PostMortemsRead;
}

// What each store holds, or why it could not be read.
export type StoresRead = {
  readonly [K in keyof DoctorStoreValues]: Asked<DoctorStoreValues[K]>;
};

// The faults a folder can stand in, by cause: it could not be created or read,
// the OS refused to open its watch, or the watch reported an error after it
// opened on a folder still there.
export type FaultCause = "unusable" | "refused" | "error";

// [LAW:types-are-the-program] Whether the OS is delivering this daemon's file
// events. `delivering`: the times of the probes written since the watch last
// reported. `stalled`: STALL_AFTER probes in a row went unreported.
// `unmeasured`: the daemon cannot check, since a time and for a reason.
//
// `missedSince` is the start of the span in which the daemon cannot vouch
// that it heard every event: opened by a stall's first unreported probe or by
// a move into `unmeasured`, whichever comes first, carried through every
// later state, and closed only by an event the watch reports. Closing it is
// the catch-up, so the catch-up runs however the span ended. A stall always
// has one; only an owner never started is unmeasured without one.
export type Delivery =
  | {
      readonly kind: "delivering";
      readonly unreported: readonly number[];
      readonly missedSince: number | null;
    }
  | { readonly kind: "stalled"; readonly missedSince: number }
  | {
      readonly kind: "unmeasured";
      readonly since: number;
      readonly reason: string;
      readonly missedSince: number | null;
    };
