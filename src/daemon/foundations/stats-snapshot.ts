// The shapes of the daemon's stats reply: what each owner reports of itself,
// as the stats client prints it.

import type { TranscriptReads } from "../../utils/transcript-fs";

import type { SourceRecord, SourceScope } from "../../utils/refresh-ledger";

import type { RenderSighting } from "./sightings";
import type { ProcessMemory } from "./memory-limit";
import type { RendererName } from "./renderer-name";
import type { Asked } from "../../utils/outcome";

import type { KeyedSourceStats } from "../../utils/keyed-source";
import type { RendererStats } from "../../renderer-interface/renderer-stats.js";

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
  // How many homes of each scope the host keeps now. A renderer keeps the
  // directory and view homes, which its panel's render cache counts.
  readonly homes: Readonly<Record<HostScope, number>>;
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

// The scopes whose homes the host keeps.
export type HostScope = Exclude<SourceScope, "directory" | "view">;

// [LAW:types-are-the-program] Where a renderer's memory is, as its panel says
// it: in the host's process, charged as the host's; in no process, and why;
// or in a process of its own, read against the limit on its own.
export type RendererMemoryPanel =
  | { readonly kind: "in-host" }
  | { readonly kind: "not-running"; readonly why: string }
  | { readonly kind: "process"; readonly memory: ProcessMemory };

// [LAW:one-type-per-behavior] One renderer as the stats reply shows it, the
// same for every renderer whatever its name: its memory, its mailbox, and
// what it answered of itself or why it gave no answer.
export interface RendererPanel {
  readonly name: RendererName;
  readonly process: RendererMemoryPanel;
  // The renderer's mailbox (src/daemon/renderer-host.ts): the input in its
  // turn and for how long, and how many wait behind it. A holder held long is
  // a turn the renderer has not answered.
  readonly mailbox: MailboxStats;
  readonly stats: Asked<RendererStats>;
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
    /** Valid compact requests that asked the client for its environment before drawing. */
    environmentMisses: number;
    errored: number;
    timedOut: number;
    inFlight: number;
    // [LAW:one-source-of-truth] How long each render request took, from its
    // start to its answer: every render event's `took`, a refused request's
    // included.
    took: Durations;
  };
  // [LAW:nothing-unseen] Throws the daemon's own tasks reported, every
  // recurrence counted, where a bar shows each task once while it is held.
  tasksThrew: number;
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
  // Sessions the host's collector reads, and those whose retire is on its way
  // to the renderer: `sessions` climbing with no requests is a session the
  // sweep never retires.
  collector: CollectorStats;
  // `run` acts (src/daemon/runs.ts): programs started, those that failed
  // (a non-zero exit or no start), timed out, and runs in flight now.
  runs: RunStats;
  // Subscribed sessions, their subscribers, and the frames pushed for them (a
  // drawn frame identical to the last is not pushed). The frames drawn are
  // each renderer's, on its panel.
  frameFeeds: FeedStats;
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
  // Each session's latest client, as this daemon process saw its last render
  // request (src/daemon/render-sightings.ts), and the bundle this daemon
  // runs.
  clients: readonly RenderSighting[];
  bundle: string;
  // [LAW:one-source-of-truth] The id of the key this daemon signs its links
  // with, which every link it draws names (src/click/link-signer.ts), or why
  // the key cannot be had. `cc-candybar ssh-config` names the forwarded socket
  // by it, so the stanza and the daemon cannot disagree.
  linkKeyId: Asked<string>;
  // The host process's memory against the limit (src/daemon/limits.ts).
  host: ProcessMemory;
  // Every renderer the host holds, one panel each.
  renderers: readonly RendererPanel[];
}

export interface CollectorStats {
  readonly sessions: number;
  readonly retiring: number;
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

export interface FeedStats {
  readonly feeds: number;
  readonly subscribers: number;
  readonly pushed: number;
  // Subscriptions refused or ended because their lane was off.
  readonly refused: number;
  // `newestWhere` lookups (a tmux bar pane asking whose bar its pane holds),
  // and how many found a session.
  readonly lookups: number;
  readonly found: number;
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

// The faults a folder can stand in, by cause: it could not be created, its
// identity could not be read, the OS refused to open its watch, or the watch
// reported an error after it opened on a folder still there.
export type FaultCause = "unusable" | "unreadable" | "refused" | "error";

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

// [LAW:no-silent-failure] The named renderer's panel, for a reader that needs
// it: a renderer the stats hold no panel of throws, naming those they hold.
export function rendererPanelOf(
  snapshot: Pick<StatsSnapshot, "renderers">,
  name: RendererName,
): RendererPanel {
  const panel = snapshot.renderers.find((each) => each.name === name);
  if (panel === undefined)
    throw new Error(
      `stats hold no renderer ${name}, only ${snapshot.renderers.map((each) => each.name).join(", ") || "none"}`,
    );
  return panel;
}

// [LAW:no-silent-failure] What the named renderer answered of itself: one that
// gave no answer throws, naming why, rather than reading as zeroes.
export function rendererStatsOf(
  snapshot: Pick<StatsSnapshot, "renderers">,
  name: RendererName,
): RendererStats {
  const panel = rendererPanelOf(snapshot, name);
  if (panel.stats.kind === "failed")
    throw new Error(`renderer ${name} gave no stats: ${panel.stats.reason}`);
  return panel.stats.value;
}
