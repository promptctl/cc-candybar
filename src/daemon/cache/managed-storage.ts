import path from "node:path";
import type { SessionId } from "../session-id";
import { elapsedMs, type Timekeeper } from "../../time";
import {
  deafnessReason,
  type Deafness,
  type Invalidation,
  type WatcherHandle,
  type WatcherRegistry,
} from "./watchers";
import {
  stallReason,
  type DeliveryNotice,
  type FileEvents,
} from "./file-events";
import {
  sameIdentity,
  statIdentity,
  type FolderIdentity,
} from "../../utils/folder-identity";
import type { Holds, Release } from "../../utils/holds";
import {
  KeyedSource,
  NO_WATCH,
  type KeyedSourceStats,
  type Resume,
} from "../../utils/keyed-source";
import type { Lane } from "../../utils/reading";
import { ABSENT, failed, type Outcome } from "../../utils/outcome";
import type { DaemonLogger } from "../../utils/logger";
import { RefreshLedger } from "../../utils/refresh-ledger";
import { valueOf } from "../../utils/logfmt";
import { jsonParser } from "../../var-system/parse";
import { sessionFileName } from "../../config/loader/plugins";
import type { JsonValue } from "../../var-system/types";

const DAY_MS = 24 * 60 * 60 * 1000;
// A file its program has not written for this long belongs to a session that
// is gone.
export const STORAGE_FILE_MAX_AGE_MS = 30 * DAY_MS;
export const STORAGE_SWEEP_EVERY_MS = DAY_MS;
// Entries nobody holds that are kept, so a session back from idle draws its
// last value while it is re-read.
const MAX_ENTRIES = 256;

// [LAW:types-are-the-program] A storage folder as the owner keys it: the real
// path the loader resolved, and the generation the owner has reached for it.
// Only a loss moves the generation, so a folder replaced at the same path is a
// new key, read fresh, with a watch of its own.
export interface StorageKey {
  readonly folder: string;
  readonly generation: number;
}

// The faults a folder can stand in, by cause: it could not be created or read,
// the OS refused to open its watch, or its watch reported an error after it
// opened or its stat failed during a judgment.
export type FaultCause = "unusable" | "refused" | "error";

export interface ManagedStorageStats extends KeyedSourceStats {
  // Folders watched now.
  readonly folders: number;
  // Each start of a generation's fault, or move to another reason, by the
  // cause it moved to.
  readonly faults: Readonly<Record<FaultCause, number>>;
  // Folders found gone or replaced under their watch.
  readonly lost: number;
}

// One session's file: the folder's key and the session it is for.
interface SessionFile {
  readonly storage: StorageKey;
  readonly sessionId: SessionId;
}

// [LAW:types-are-the-program] A `SessionId` is a safe file name, so the path
// needs no check of its own.
const fileName = (sessionId: SessionId): string => sessionFileName(sessionId);
const fileOf = (f: SessionFile): string =>
  path.join(f.storage.folder, fileName(f.sessionId));
const keyString = (key: StorageKey): string =>
  JSON.stringify([key.folder, key.generation]);
const sameKey = (a: StorageKey, b: StorageKey): boolean =>
  a.folder === b.folder && a.generation === b.generation;

// What the owner knows of one folder path across its generations.
interface Folder {
  generation: number;
  // Recorded when the current generation's watch opened (or when a key
  // request moved the generation); null while nothing is recorded.
  identity: FolderIdentity | null;
  // Gone, replaced, or could not be made: the next key request moves the
  // generation.
  lost: boolean;
  // Why the last key request could not create or read the folder, or null:
  // its generation's standing fault, set when the watch opens.
  unusable: string | null;
}

// [LAW:types-are-the-program] What has become of one generation's folder.
// `watching`: its folder is the one its watch opened on. `lost`: its folder
// is gone or replaced. `unusable`: its folder could not be made, which only
// the next key request's mkdir retries. `closed`: its last holder released
// it. `lost`, `unusable` and `closed` end the generation: nothing moves it on,
// so each is counted once.
type Health =
  | { readonly kind: "watching" }
  | { readonly kind: "lost" }
  | { readonly kind: "unusable"; readonly reason: string }
  | { readonly kind: "closed" };

// The one fault a generation's sources read ahead of a stall.
interface Fault {
  readonly cause: FaultCause;
  readonly reason: string;
}

// [LAW:one-source-of-truth] A generation's fault, derived, in rank order: the
// folder that could not be made, its watch's deafness, the stat its last
// judgment could not take. Only the first is the owner's to hold; a deafness
// is the handle's and a stat failure the disk's, each until it answers
// otherwise.
const faultOf = (
  health: Health,
  deafness: Deafness | null,
  statFailure: string | null,
): Fault | null => {
  if (health.kind === "unusable")
    return { cause: "unusable", reason: health.reason };
  if (deafness !== null)
    return {
      cause: deafness.kind === "refused" ? "refused" : "error",
      reason: deafnessReason(deafness),
    };
  if (statFailure !== null) return { cause: "error", reason: statFailure };
  return null;
};

// One generation's watch, held by the render states that declare the folder.
interface Watched {
  readonly key: StorageKey;
  readonly folder: Folder;
  // The folder the watch opened on.
  readonly identity: FolderIdentity | "gone";
  holders: number;
  readonly handle: WatcherHandle;
  readonly stopSweep: () => void;
  health: Health;
  // The handle's deafness as of the last window it told, or its opening: the
  // registry tells a window on every move of it.
  deafness: Deafness | null;
  // Why the last judgment could not stat the folder, or null.
  statFailure: string | null;
  // The fault last logged and counted, or null.
  reported: Fault | null;
}

// [LAW:single-enforcer] The one owner of every plugin's managed storage, for
// the whole daemon (design-docs/PLUGIN-API.md, "Managed storage"). A plugin's
// program writes `<storage>/<session id>.json` whole, by rename; this owner
// creates the folder, watches it once per generation, reads only the files of
// sessions something holds, and removes files nobody has written for 30 days.
//
// [LAW:no-ambient-temporal-coupling] A folder's watch lives as long as a
// render state declaring it holds it (`watch`), never as long as a view:
// opening or closing a directory watch leaks on macOS. The owner never re-arms
// a watch: a folder gone or replaced, or one that could not be made, is marked
// lost, and the next key request (a config load) moves its generation. A deaf
// watch is the registry's to reopen, on the delivery owner's period.
//
// [LAW:one-source-of-truth] Whether the OS is delivering file events is the
// daemon's one fact, not a folder's (file-events.ts): a stall is every
// folder's, read from that owner.
export class ManagedStorage {
  private readonly sessions: KeyedSource<SessionFile, JsonValue>;
  private readonly folders = new Map<string, Folder>();
  private readonly watched = new Map<string, Watched>();
  private readonly faultCounts: Record<FaultCause, number> = {
    unusable: 0,
    refused: 0,
    error: 0,
  };
  private lost = 0;
  private readonly watchers: WatcherRegistry;
  private readonly logger: DaemonLogger;
  private readonly fileEvents: FileEvents;
  private readonly clock: Pick<
    Timekeeper,
    "now" | "monotonic" | "after" | "every"
  >;
  private readonly unsubscribe: Release;

  constructor(opts: {
    readonly watchers: WatcherRegistry;
    readonly logger: DaemonLogger;
    readonly fileEvents: FileEvents;
    // [LAW:effects-at-boundaries] The daemon's clock: the sweep period, the
    // age a file is judged against, and the source's timings.
    readonly clock: Pick<Timekeeper, "now" | "monotonic" | "after" | "every">;
    readonly ledger?: RefreshLedger;
  }) {
    this.watchers = opts.watchers;
    this.logger = opts.logger;
    this.fileEvents = opts.fileEvents;
    this.clock = opts.clock;
    this.unsubscribe = opts.fileEvents.subscribe((notice) =>
      this.noticed(notice),
    );
    this.sessions = new KeyedSource({
      name: "plugin storage",
      scope: "session",
      keyOf: (f) =>
        JSON.stringify([f.storage.folder, f.storage.generation, f.sessionId]),
      fields: (f) =>
        `file=${valueOf(fileOf(f))} generation=${f.storage.generation}`,
      read: (f) => this.read(f),
      // [LAW:types-are-the-program] A plugin source has no period: its watch
      // is its trigger, and a hold's return re-reads a kept entry.
      every: () => null,
      watch: NO_WATCH,
      maxEntries: MAX_ENTRIES,
      logger: opts.logger,
      ledger: opts.ledger ?? new RefreshLedger(opts.logger),
      clock: opts.clock,
    });
  }

  // The key a render state's build holds for a folder its config declares.
  // Creates the folder, so its program has somewhere to write before any
  // session reads it, and stats it. The generation moves when the folder was
  // marked lost or is no longer the folder its watch opened on; so whichever
  // of a removal's events comes first, a recreated folder is a new key.
  // [LAW:no-silent-failure] A folder that cannot be created or read is its
  // generation's standing fault, read by every source in it, never a throw:
  // one plugin's folder fails only that plugin's sources, not the build.
  keyFor(folder: string): StorageKey {
    const known = this.folders.get(folder) ?? this.recorded(folder);
    let now: FolderIdentity | "gone" = "gone";
    known.unusable = null;
    try {
      this.watchers.filesystem.mkdirSync(folder);
      now = statIdentity(this.watchers.filesystem, folder);
    } catch (e) {
      known.unusable = `could not be created or read: ${(e as Error).message}`;
    }
    const moved =
      known.lost ||
      (known.identity !== null &&
        (now === "gone" || !sameIdentity(now, known.identity)));
    if (moved) {
      known.generation++;
      known.lost = false;
      known.identity = now === "gone" ? null : now;
      this.logger(
        "info",
        `plugin storage generation folder=${valueOf(folder)} generation=${known.generation}`,
      );
    }
    return { folder, generation: known.generation };
  }

  // A render state's hold on a folder's watch, from its build to its reclaim.
  // The first holder of a generation opens its one watch and sweeps it; the
  // last release closes it.
  watch(key: StorageKey): Release {
    const watched = this.watched.get(keyString(key)) ?? this.opened(key);
    watched.holders++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      watched.holders--;
      if (watched.holders === 0) this.closed(watched);
    };
  }

  // A view's declaration of one session's file: held at (storage key,
  // session id) until the view's next declaration takes it no more.
  declare(
    holds: Holds,
    storage: StorageKey,
    sessionId: SessionId,
  ): Lane<JsonValue> {
    return this.sessions.declare(holds, { storage, sessionId });
  }

  // [LAW:one-source-of-truth] The keyed source's one supersede: a program run
  // for the session is about to write this file.
  supersede(storage: StorageKey, sessionId: SessionId): Resume {
    return this.sessions.supersede({ storage, sessionId });
  }

  stats(): ManagedStorageStats {
    return {
      ...this.sessions.stats(),
      folders: this.watched.size,
      faults: { ...this.faultCounts },
      lost: this.lost,
    };
  }

  close(): void {
    this.unsubscribe();
    this.sessions.close();
    for (const watched of [...this.watched.values()]) this.closed(watched);
  }

  private recorded(folder: string): Folder {
    const known: Folder = {
      generation: 0,
      identity: null,
      lost: false,
      unusable: null,
    };
    this.folders.set(folder, known);
    return known;
  }

  private opened(key: StorageKey): Watched {
    const folder = this.folders.get(key.folder);
    // [LAW:no-silent-failure] A watch is only ever asked for a key this owner
    // handed out.
    if (folder === undefined) {
      throw new Error(`plugin storage: no key was asked for ${key.folder}`);
    }
    const unusable =
      key.generation === folder.generation ? folder.unusable : null;
    const identity =
      unusable === null
        ? statIdentity(this.watchers.filesystem, key.folder)
        : "gone";
    if (key.generation === folder.generation) {
      folder.identity = identity === "gone" ? null : identity;
    }
    if (unusable !== null) folder.lost = true;
    const watched: Watched = {
      key,
      folder,
      identity,
      holders: 0,
      // [LAW:single-enforcer] The only acquirer of this registry key, so the
      // slot's one callback is this generation's own.
      handle: this.watchers.acquire(
        `plugin-storage:${keyString(key)}`,
        { dirs: [{ path: key.folder }] },
        (invalidation) => this.invalidated(watched, invalidation),
      ),
      stopSweep: this.clock.every(
        STORAGE_SWEEP_EVERY_MS,
        () => void this.sweep(key),
        { unref: true },
      ),
      health:
        unusable === null
          ? { kind: "watching" }
          : { kind: "unusable", reason: unusable },
      deafness: null,
      statFailure: null,
      reported: null,
    };
    this.watched.set(keyString(key), watched);
    // A refusal at acquire is on the handle now.
    this.heard(watched);
    void this.sweep(key);
    return watched;
  }

  private closed(watched: Watched): void {
    const id = keyString(watched.key);
    this.watched.delete(id);
    watched.health = { kind: "closed" };
    watched.stopSweep();
    watched.handle.release();
  }

  // [LAW:dataflow-not-control-flow] Routing by what the window named: the
  // held files it names re-read; the folder's own name, an unnamed event or
  // an error is judged against the disk, re-reading every held file in the
  // folder still there. An `unknown` window may hold the folder's own event
  // (an unnamed one, or a named one the window folded), and a `failed` one
  // may have missed it. The OS reports a change to the watched folder itself
  // under the folder's own name, as though it were a child, so that path is
  // the folder joined with its own name. Every window then hears the handle's
  // deafness, since the registry tells one on every move of it.
  private invalidated(watched: Watched, invalidation: Invalidation): void {
    const { key } = watched;
    const inFolder = (f: SessionFile) => sameKey(f.storage, key);
    const own = path.join(key.folder, path.basename(key.folder));
    if (invalidation.kind === "changed" && !invalidation.paths.has(own)) {
      const { paths } = invalidation;
      this.sessions.changed((f) => inFolder(f) && paths.has(fileOf(f)));
    } else {
      this.judged(watched, () => this.sessions.changed(inFolder));
    }
    this.heard(watched);
  }

  // [LAW:no-ambient-temporal-coupling] The handle's deafness, compared only
  // when a window closes and at the watch's opening, never on a period: the
  // registry's period reopen and this owner's period judgment are two
  // listeners to one notice in an order nothing owns, and a handle that errors
  // after every reopen listens for an instant between them.
  private heard(watched: Watched): void {
    watched.deafness = watched.handle.deaf[0] ?? null;
    this.reported(watched);
  }

  // [LAW:one-source-of-truth] Whether the folder is gone is the disk's to
  // say: a chmod, a utimes or an xattr reports the folder's own name exactly
  // as a removal does. Lost only if the path is gone or holds another folder;
  // otherwise `present` runs. A lost folder's held files are re-read from the
  // path, so no draw shows a value from a folder no longer there while the
  // config's reload opens the next generation. A generation already ended has
  // nothing left to judge. A stat that fails is this judgment's answer, the
  // fault until a judgment's stat succeeds.
  private judged(watched: Watched, present: () => void): void {
    const { health } = watched;
    if (health.kind !== "watching") return;
    const { key, folder } = watched;
    const stat = this.statOf(key.folder);
    watched.statFailure = "failed" in stat ? stat.failed : null;
    this.reported(watched);
    if ("failed" in stat) return;
    const { now } = stat;
    const opened = watched.identity;
    if (now !== "gone" && opened !== "gone" && sameIdentity(now, opened)) {
      present();
      return;
    }
    watched.health = { kind: "lost" };
    // An older generation's folder has already moved on: its loss was the
    // current generation's to count.
    if (key.generation !== folder.generation) return;
    folder.lost = true;
    this.lost++;
    this.logger(
      "info",
      `plugin storage lost folder=${valueOf(key.folder)} generation=${key.generation} now=${now === "gone" ? "gone" : "replaced"}`,
    );
    this.sessions.changed((f) => sameKey(f.storage, key));
  }

  // The disk's answer for the folder, or why it gave none.
  private statOf(
    folder: string,
  ): { readonly now: FolderIdentity | "gone" } | { readonly failed: string } {
    try {
      return { now: statIdentity(this.watchers.filesystem, folder) };
    } catch (e) {
      return { failed: `stat failed: ${(e as Error).message}` };
    }
  }

  // [LAW:no-silent-failure] A generation's fault is a standing failure of
  // every source read from it, for as long as the OS or the disk gives that
  // answer: the registry's period reopens a deaf watch, and the owner's period
  // judges the folder again. [LAW:nothing-unseen] Each start, change of
  // reason, or clear is logged once and re-reads the folder's held files; a
  // start or change counts under its cause. The same fault again is no
  // change: every period asks again, and repeating it would bury the events
  // around it.
  private reported(watched: Watched): void {
    const { key } = watched;
    const was = watched.reported;
    const now = faultOf(watched.health, watched.deafness, watched.statFailure);
    watched.reported = now;
    const at = `folder=${valueOf(key.folder)} generation=${key.generation}`;
    if (
      now !== null &&
      (was === null || was.cause !== now.cause || was.reason !== now.reason)
    ) {
      this.faultCounts[now.cause]++;
      this.logger(
        "warn",
        `plugin storage fault ${at} cause=${now.cause} reason=${JSON.stringify(now.reason)}`,
      );
    } else if (now === null && was !== null) {
      this.logger(
        "info",
        `plugin storage fault cleared ${at} cause=${was.cause}`,
      );
    } else return;
    this.sessions.changed((f) => sameKey(f.storage, key));
  }

  // [LAW:one-source-of-truth] What the delivery owner says reaches every
  // folder. Each period judges every folder against the disk: the event naming
  // a removed folder and the follower's event that reloads its config ride one
  // stream, which can drop both at once without a stall. Every change of
  // delivery and every catch-up re-reads every held file, so no lane keeps a
  // stall after delivery moves on, and a file written during a span lands.
  private noticed(notice: DeliveryNotice): void {
    switch (notice.kind) {
      case "period":
        for (const watched of [...this.watched.values()])
          this.judged(watched, () => {});
        return;
      case "moved":
      case "caught-up":
        this.sessions.changed(() => true);
        return;
    }
  }

  // The generation's standing failure, which every source in it reads first:
  // its fault, with the deafness read live from the handle, then a stall. A
  // lost generation reads them too: its held files are refreshed only through
  // its watch, so while the watch is deaf or file events are stalled a file
  // read once from the path would freeze there unreported. While delivery is
  // unmeasured its files read as usual: the bar's row already says it cannot
  // be checked. A generation no render state watches has none: its files read
  // the path.
  private standing(storage: StorageKey): string | null {
    const watched = this.watched.get(keyString(storage));
    if (watched === undefined) return null;
    const fault = faultOf(
      watched.health,
      watched.handle.deaf[0] ?? null,
      watched.statFailure,
    );
    // Only a folder that could not be made waits on a reload; the rest clear
    // when the OS or the disk answers otherwise.
    if (fault?.cause === "unusable")
      return `cannot refresh: ${storage.folder} ${fault.reason}; reload the config or restart the daemon`;
    const reason = fault?.reason ?? stallReason(this.fileEvents.delivery());
    return reason === null
      ? null
      : `cannot refresh: ${storage.folder}: ${reason}`;
  }

  private async read(f: SessionFile): Promise<Outcome<JsonValue>> {
    const fault = this.standing(f.storage);
    if (fault !== null) return failed(fault, "read");
    const file = fileOf(f);
    let text: string;
    try {
      text = await this.watchers.filesystem.readFile(file);
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      return err.code === "ENOENT"
        ? ABSENT
        : failed(`${file}: ${err.message}`, "read");
    }
    // A program writes the file whole, by rename, so blank text is a program
    // that has nothing to say, never a torn write.
    if (text.trim() === "") return ABSENT;
    const parsed = jsonParser(text);
    return parsed.kind === "failed"
      ? failed(`${file}: ${parsed.reason}`, parsed.failedAt)
      : parsed;
  }

  // Removes every `*.json` file nobody has written for 30 days, unless a
  // session holds it now. One event per sweep.
  private async sweep(key: StorageKey): Promise<void> {
    const startedAt = this.clock.monotonic();
    const cutoff = this.clock.now() - STORAGE_FILE_MAX_AGE_MS;
    let scanned = 0;
    let removed = 0;
    const event = () =>
      `plugin storage sweep folder=${valueOf(key.folder)} scanned=${scanned} removed=${removed} took=${elapsedMs(this.clock, startedAt)}ms`;
    try {
      const entries = await this.watchers.filesystem.readdir(key.folder);
      for (const entry of entries) {
        if (entry.kind !== "file" || !entry.name.endsWith(".json")) continue;
        scanned++;
        const file = path.join(key.folder, entry.name);
        try {
          const { mtimeMs } = await this.watchers.filesystem.stat(file);
          const held = this.sessions.isHeld(
            (f) =>
              f.storage.folder === key.folder &&
              fileName(f.sessionId) === entry.name,
          );
          if (mtimeMs >= cutoff || held) continue;
          await this.watchers.filesystem.unlink(file);
          removed++;
        } catch (e) {
          // Gone already: another generation's sweep of the folder got there
          // first. Any other fault ends the sweep, loud.
          if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        }
      }
      this.logger("info", event());
    } catch (e) {
      this.logger(
        "warn",
        `${event()} outcome=failed reason=${JSON.stringify((e as Error).message)}`,
      );
    }
  }
}
