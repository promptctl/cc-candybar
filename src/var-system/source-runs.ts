// [LAW:single-enforcer] The one owner of every declared source's runs for the
// daemon: a `shell` or `file` source is identified by a digest of what its run
// needs (spec: docs/design/gather-and-renderer.md, section 19), and every
// declaration whose identity digests alike holds the one entry and reads the
// one run. Two sessions in one directory, two directories declaring one
// command in one cwd, two views whose key values agree, a reload that
// re-declares a running source: one program, one value.
//
// [LAW:one-type-per-behavior] A declared source is one more keyed source
// (src/utils/keyed-source.ts), as the tmux names, the host facts, the plugin
// session files and the usage scans are: one per read kind, keyed by the
// digest, its period the identity's ttl and its change the identity's watched
// path. What differs is data in the spec.
//
// [LAW:one-source-of-truth] The identity is what a run needs and nothing the
// renderer owns: the default, the empty default and the key template are a
// declaration's, so two declarations differing only in those share a run.
// The key's VALUE is in, hashed, so a key that moves is a new identity with a
// run of its own, and the declaration keeps publishing the old entry's answer
// until the new one lands (sources.ts).
//
// [LAW:no-ambient-temporal-coupling] An entry exists exactly while held: the
// last release drops it, aborting the read in flight and ending its period or
// watch. Nothing unheld is kept, because a key value nobody holds has nobody
// to answer, and a kept entry's period would keep spawning for no bar.

import crypto from "node:crypto";
import { readFile as fsReadFile } from "node:fs/promises";
import { observable, runInAction } from "mobx";
import { failureText, type Launcher } from "../proc/launch";
import { systemFilesystem } from "../disk/system-filesystem.js";
import type { Filesystem } from "../disk/filesystem.js";
import {
  WatcherRegistry,
  watchFault,
  watchTargetsOf,
  type BoundWatch,
  type Invalidation,
  type PathsWatch,
} from "../daemon/cache/watchers.js";
import {
  NO_FILE_EVENTS,
  stallReason,
  type DeliveryNotice,
  type FileEvents,
} from "../daemon/cache/file-events.js";
import type { Holds } from "../utils/holds.js";
import {
  KeyedSource,
  NO_WATCH,
  type KeyedSourceStats,
} from "../utils/keyed-source.js";
import { quietLogger, type DaemonLogger } from "../utils/logger.js";
import {
  ABSENT,
  failed,
  ok,
  pendingOf,
  type Outcome,
  type Reading,
} from "../utils/outcome.js";
import { RefreshLedger } from "../utils/refresh-ledger.js";
import { valueOf } from "../utils/logfmt.js";
import { shortDigest } from "../source-digest.js";
import { digestOf as plainDigestOf } from "../utils/plain.js";
import type { Timekeeper } from "../time";
import { jsonParser, regexParser, textParser, type Parser } from "./parse.js";

// [LAW:no-silent-failure] How long one run of a shell source may take. The
// launcher's output bound ends a child that writes without end; this ends one
// that never writes, which would otherwise hold its entry open for the life
// of the daemon, and so for every declaration sharing it. A run past it is
// failed in its read phase, naming the bound.
// [LAW:no-mode-explosion] Not a config knob: one bound, named where chosen.
export const SHELL_READ_TIMEOUT_MS = 10_000;

export type ReadMode = "whole" | "first-line";

// ─── Identity ────────────────────────────────────────────────────────────────

// What text a run reads: a command's stdout in a directory, or a file's
// content, whole or its first line.
export type SourceRead =
  | { readonly kind: "shell"; readonly command: string; readonly cwd: string }
  | {
      readonly kind: "file";
      readonly path: string;
      readonly readMode: ReadMode;
    };

// [LAW:types-are-the-program] The parser without its default: the identity
// arm, a capture over a pattern, or a document. A `RegExp` is not JSON, so the
// identity carries its source and flags.
export type ParserId =
  | { readonly kind: "text" }
  | { readonly kind: "regex"; readonly source: string; readonly flags: string }
  | { readonly kind: "json" };

// The cache policy as a run sees it: a period, a watched path, or none, the
// run reading once. A policy over the declaration's own values (`key`,
// `depends_on`) is a hash of what those values answered: the template is the
// renderer's, its value's hash is the run's.
export type RunRefresh =
  | { readonly kind: "ttl"; readonly durationMs: number }
  | { readonly kind: "watch_file"; readonly path: string }
  | { readonly kind: "key"; readonly hash: string }
  | { readonly kind: "never" };

export interface SourceIdentity {
  readonly read: SourceRead;
  readonly parse: ParserId;
  readonly refresh: RunRefresh;
}

// [LAW:one-source-of-truth] The identity's digest is the one digest of a
// plain value (src/utils/plain.ts): lowercase sha256 hex of its canonical JSON.
export const digestOf = (identity: SourceIdentity): string =>
  plainDigestOf(identity);

// [LAW:one-source-of-truth] The one hash of a key's value, the `key` message's
// `keyHash` on the wire (spec section 13).
export function keyHashOf(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

// ─── Readers ─────────────────────────────────────────────────────────────────

// [LAW:effects-at-boundaries] A reader is the effect half of a run: it
// performs the read and classifies its own failure (a non-zero exit, an
// unreadable file, a read its owner abandoned) as a value. `where` names the
// text's origin for the parser's failure message ("regex no-match in output
// of \"uptime\"").
interface SourceReader {
  readonly where: string;
  read(): Promise<Outcome<string>>;
}

// The directory is part of the origin: a command that asks about "this repo"
// answers differently per directory, so every failure — exit, regex
// no-match, JSON parse — names where it ran.
export const whereOf = (read: SourceRead): string =>
  read.kind === "shell"
    ? `output of "${read.command}" in ${read.cwd}`
    : `"${read.path}"`;

function shellReader(
  launcher: Launcher,
  command: string,
  cwd: string,
  signal: AbortSignal,
): SourceReader {
  return {
    where: whereOf({ kind: "shell", command, cwd }),
    read: async () => {
      const r = await launcher.launch({
        bin: "/bin/sh",
        args: ["-c", command],
        cwd,
        category: "user-shell",
        timeoutMs: SHELL_READ_TIMEOUT_MS,
        signal,
      });
      if (r.ok) return ok(r.stdout);
      // The reason, not the exit code, says which: a child the launcher ended
      // (timeout, output-limit, an abandoned read's abort) can still exit
      // with a code of its own.
      return failed(
        `shell "${command}" ${failureText(r, ` in ${cwd}`)}`,
        "read",
      );
    },
  };
}

function fileReader(
  filePath: string,
  readMode: ReadMode,
  signal: AbortSignal,
): SourceReader {
  return {
    where: whereOf({ kind: "file", path: filePath, readMode }),
    read: async () => {
      try {
        const raw = await fsReadFile(filePath, { encoding: "utf8", signal });
        return ok(
          readMode === "first-line" ? (raw.split(/\r?\n/)[0] ?? "") : raw,
        );
      } catch (e) {
        // [LAW:no-silent-failure] The errno says which mistake: a file not
        // there yet, a directory, a permission, a link loop.
        const code = (e as NodeJS.ErrnoException).code ?? String(e);
        return failed(
          signal.aborted
            ? `file read aborted: ${String(signal.reason)}`
            : `file unreadable (${code}): ${filePath}`,
          "read",
        );
      }
    },
  };
}

function readerOf(
  launcher: Launcher,
  read: SourceRead,
  signal: AbortSignal,
): SourceReader {
  switch (read.kind) {
    case "shell":
      return shellReader(launcher, read.command, read.cwd, signal);
    case "file":
      return fileReader(read.path, read.readMode, signal);
  }
}

// [LAW:one-type-per-behavior] The parser an identity names. Blank text under
// the document parser is nothing to read — a command that printed nothing, a
// file only touched — exactly as a missing file is; a string arm reads blank
// text as the empty string it is.
function parserOf(parse: ParserId): Parser<unknown> {
  switch (parse.kind) {
    case "text":
      return textParser;
    case "regex":
      return regexParser(new RegExp(parse.source, parse.flags));
    case "json":
      return (text) => (text.trim() === "" ? ABSENT : jsonParser(text));
  }
}

// The parse step over a read's outcome: a failed read passes through
// untouched (it already names its origin); a failed parse gains the origin.
function parsed(
  read: Outcome<string>,
  parser: Parser<unknown>,
  where: string,
): Outcome<unknown> {
  if (read.kind !== "ok") return read;
  const out = parser(read.value);
  return out.kind === "failed"
    ? failed(`${out.reason} in ${where}`, out.failedAt)
    : out;
}

// ─── PathWatches ──────────────────────────────────────────────────────────────

// What a watch says to each subscriber: why it may be missing changes to its
// path right now, or `null` when it hears every place the path can change.
type WatchFault = (fault: string | null) => void;

interface WatchEntry {
  // Where the path can change, as last derived from disk, and the watcher
  // registry's watch on it.
  bound: BoundWatch;
  // Each subscriber's update, and where it hears the watch's fault.
  readonly subscribers: Map<() => void, WatchFault>;
}

// [LAW:single-enforcer] One watch per path regardless of subscriber count:
// several entries can share it. The directory watches are the watcher
// registry's, which opens, shares, counts and logs every one in the daemon;
// this follows each path's spec and fans its windows out.
//
// A path is watched wherever it can change (`watchTargetsOf`, the rule the
// config watcher shares): each directory through which its link chain passes,
// filtered to the names there, and the path itself when it is a directory. A
// directory, never a file, because a watch on a file binds its inode: it
// never sees a file created after it (an app that has not written yet) and
// goes deaf after the first atomic rename (write-then-rename, the safe way to
// rewrite a file). A directory that does not exist yet is watched through its
// nearest existing ancestor, and each one that appears moves the watch one
// level deeper.
class PathWatches {
  private readonly entries = new Map<string, WatchEntry>();
  private readonly releaseDelivery: () => void;

  constructor(
    private readonly watchers: WatcherRegistry,
    private readonly fileEvents: FileEvents,
  ) {
    this.releaseDelivery = fileEvents.subscribe((notice) =>
      this.noticed(notice),
    );
  }

  subscribe(
    filePath: string,
    callback: () => void,
    onFault: WatchFault,
  ): () => void {
    const entry = this.entries.get(filePath) ?? this.arm(filePath);
    entry.subscribers.set(callback, onFault);
    onFault(this.faultOf(filePath, entry));
    return () => this.unsubscribe(filePath, callback);
  }

  private arm(filePath: string): WatchEntry {
    const watch = derived(this.watchers.filesystem, filePath);
    const entry: WatchEntry = {
      bound: {
        derived: watch,
        held: this.watchers.follow(null, watch, (heard) =>
          this.heard(filePath, entry, heard),
        ).watch,
      },
      subscribers: new Map(),
    };
    this.entries.set(filePath, entry);
    return entry;
  }

  // Derive where the path can change, follow it, and say the watch's fault.
  // A new key acquires its watch, keeping every directory both keys name.
  private rederive(filePath: string, entry: WatchEntry): void {
    const paths = derived(this.watchers.filesystem, filePath);
    const { watch } = this.watchers.follow(entry.bound.held, paths, (heard) =>
      this.heard(filePath, entry, heard),
    );
    entry.bound = { derived: paths, held: watch };
    this.report(filePath, entry);
  }

  // A window re-derives and re-reads.
  private heard(
    filePath: string,
    entry: WatchEntry,
    heard: Invalidation,
  ): void {
    const wasLeaf = entry.bound.derived.reached;
    this.rederive(filePath, entry);
    // Ancestor churn on the way DOWN is not a change to the path; a move
    // up from the leaf is its removal, which the subscribers must read. A
    // failed directory may have missed a change, so its window always reads.
    if (heard.kind !== "failed" && !wasLeaf && !entry.bound.derived.reached)
      return;
    for (const cb of entry.subscribers.keys()) cb();
  }

  private report(filePath: string, entry: WatchEntry): void {
    const fault = this.faultOf(filePath, entry);
    for (const onFault of entry.subscribers.values()) onFault(fault);
  }

  // The watch's fault, derived from what it holds now and whether the OS is
  // delivering what it would hear. A stall is the fault of a watch that rides
  // the delivery owner's one stream; a polled watch hears through it.
  private faultOf(filePath: string, entry: WatchEntry): string | null {
    return watchFault(
      `watch_file ${filePath}`,
      entry.bound,
      stallReason(this.fileEvents.delivery(), entry.bound.held.handle),
    );
  }

  // [LAW:no-silent-failure] Delivery moved or a span closed, so the watches
  // may have missed events: each watch re-derives where its path can change,
  // since a directory may have appeared unheard, which says its fault, and
  // every subscriber re-reads as if its own watch had reported. Both together,
  // so no entry drops a stall's fault without reading again, and in one
  // action, so one change of delivery is one publish of every entry's.
  private noticed(notice: DeliveryNotice): void {
    switch (notice.kind) {
      case "period":
        return;
      case "moved":
      case "caught-up":
        runInAction(() => {
          for (const [filePath, entry] of this.entries) {
            this.rederive(filePath, entry);
            for (const cb of entry.subscribers.keys()) cb();
          }
        });
        return;
    }
  }

  private unsubscribe(filePath: string, callback: () => void): void {
    const entry = this.entries.get(filePath);
    if (!entry) return;
    entry.subscribers.delete(callback);
    if (entry.subscribers.size === 0) {
      entry.bound.held.handle.release();
      this.entries.delete(filePath);
    }
  }

  dispose(): void {
    this.releaseDelivery();
    for (const entry of this.entries.values())
      entry.bound.held.handle.release();
    this.entries.clear();
  }

  size(): number {
    return this.entries.size;
  }
}

// Where the path can change: every hop of its link chain by name, and the
// path itself when it is a directory.
const derived = (filesystem: Filesystem, filePath: string): PathsWatch =>
  watchTargetsOf(filesystem, { named: [filePath], whole: [filePath] });

// ─── SourceRuns ──────────────────────────────────────────────────────────────

// [LAW:types-are-the-program] What a declaration holds: the run's reading as
// it stands (observable, so a declaration publishes in the turn it lands) and
// its watch's fault, read the same way; and the digest, for the record. A
// reading, not a landing to await: a registry waits on its lanes by
// observing them (sources.ts, `inFlight`), and a lane a document answers has
// no landing to hand.
export interface SourceLane {
  readonly digest: string;
  current(): Reading<unknown>;
  // Why the run's watch may be missing changes to its path, or `null` when
  // it hears every place the path can change, or the run watches nothing.
  fault(): string | null;
}

// [LAW:locality-or-seam] Where a registry's `shell` and `file` sources get
// their lanes: `declare` takes, in the caller's `holds`, whatever the lane
// needs held, and the lane reads the run as it stands. `SourceRuns` is one
// (a registry no session draws, such as `cc-candybar check`'s, runs its own);
// a session's facts arm is another, whose lanes read the session's document
// (src/daemon/facts-source.ts), so a view's sources are drawn only through
// the facts seam and a recording carries them.
export interface SourceLanes {
  declare(holds: Holds, identity: SourceIdentity): SourceLane;
}

// Lanes that never answer and take nothing: a view declared only to find what
// fails to declare (the load's probe), which starts no run.
export const UNREAD_RUNS: SourceLanes = {
  declare: (_holds, identity) => ({
    digest: digestOf(identity),
    current: () => pendingOf("unread"),
    fault: () => null,
  }),
};

// [LAW:no-silent-failure] A directory's registry declares no `shell` or
// `file` source (src/dsl/variable-scope.ts): each is a session's view's, read
// from its document. One declared here is a scope bug, refused by name rather
// than drawn pending for good.
export const NO_RUNS: SourceLanes = {
  declare: (_holds, identity) => {
    throw new Error(
      `a directory declares no shell or file source, and ${whereOf(identity.read)} was declared in one: each is a session view's`,
    );
  },
};

export interface SourceRunsDeps {
  // Who a shell run's program belongs to.
  readonly launcher: Launcher;
  // What the periods are armed and the refreshes timed on: the daemon's.
  readonly clock: Pick<Timekeeper, "monotonic" | "after">;
  readonly logger?: DaemonLogger;
  // [LAW:single-enforcer] The daemon's one ledger, which every run is recorded
  // in; an owner outside the daemon keeps its own.
  readonly ledger?: RefreshLedger;
  // [LAW:single-enforcer] The daemon's one watcher registry, which holds every
  // directory watch a `watch_file` run needs; an owner outside the daemon
  // keeps its own.
  readonly watchers?: WatcherRegistry;
  // [LAW:one-source-of-truth] The daemon's one word on whether the OS is
  // delivering file events, which the watches ride. Only the daemon measures
  // delivery.
  readonly fileEvents?: FileEvents;
}

export interface SourceRunsStats {
  readonly shell: KeyedSourceStats;
  readonly file: KeyedSourceStats;
  readonly watches: number;
}

export class SourceRuns implements SourceLanes {
  private readonly byKind: Readonly<
    Record<SourceRead["kind"], KeyedSource<SourceIdentity, unknown>>
  >;
  private readonly watchMgr: PathWatches;
  // Each watching entry's fault, by digest, for the lanes that read it.
  private readonly faults = observable.map<string, string>(undefined, {
    deep: false,
  });

  constructor(deps: SourceRunsDeps) {
    const logger = deps.logger ?? quietLogger;
    const ledger = deps.ledger ?? new RefreshLedger(logger);
    this.watchMgr = new PathWatches(
      deps.watchers ??
        new WatcherRegistry({
          filesystem: systemFilesystem,
          clock: deps.clock,
        }),
      deps.fileEvents ?? NO_FILE_EVENTS,
    );
    // [LAW:nothing-unseen] One record per read kind (spec section 21's source
    // event): each refresh names its digest, its origin and how many homes
    // share it. A record per digest would grow with every key value a bar
    // ever had.
    const source = (kind: SourceRead["kind"]) =>
      new KeyedSource<SourceIdentity, unknown>({
        name: `source.${kind}`,
        scope: "daemon",
        keyOf: digestOf,
        fields: (identity, holders) =>
          `digest=${shortDigest(digestOf(identity))} where=${valueOf(whereOf(identity.read))} sharedBy=${holders}`,
        // [LAW:single-enforcer] THE run: read → parse. Shell and file are two
        // readers through this one function; text/regex/json are three
        // parsers through it.
        read: async (identity, signal) => {
          const reader = readerOf(deps.launcher, identity.read, signal);
          return parsed(
            await reader.read(),
            parserOf(identity.parse),
            reader.where,
          );
        },
        every: ({ refresh }) =>
          refresh.kind === "ttl"
            ? { okMs: refresh.durationMs, failedMs: refresh.durationMs }
            : null,
        watch: (identity, changed) => {
          if (identity.refresh.kind !== "watch_file") return NO_WATCH();
          const digest = digestOf(identity);
          const unsubscribe = this.watchMgr.subscribe(
            identity.refresh.path,
            changed,
            (fault) =>
              runInAction(() => {
                if (fault === null) this.faults.delete(digest);
                else this.faults.set(digest, fault);
              }),
          );
          return () => {
            unsubscribe();
            runInAction(() => this.faults.delete(digest));
          };
        },
        maxEntries: 0,
        logger,
        ledger,
        clock: deps.clock,
      });
    this.byKind = { shell: source("shell"), file: source("file") };
  }

  // [LAW:single-enforcer] The one way to a run: `holds` takes the entry for
  // the identity's digest, created and read once on its first hold, and the
  // lane reads it as it stands.
  declare(holds: Holds, identity: SourceIdentity): SourceLane {
    const digest = digestOf(identity);
    const lane = this.byKind[identity.read.kind].declare(holds, identity);
    return {
      digest,
      current: () => lane.current(),
      fault: () => this.faults.get(digest) ?? null,
    };
  }

  stats(): SourceRunsStats {
    return {
      shell: this.byKind.shell.stats(),
      file: this.byKind.file.stats(),
      watches: this.watchMgr.size(),
    };
  }

  // Drops every entry, ending its read, its period and its watch.
  close(): void {
    this.byKind.shell.close();
    this.byKind.file.close();
    this.watchMgr.dispose();
  }
}
