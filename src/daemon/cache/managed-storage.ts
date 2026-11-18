import fs from "node:fs";
import path from "node:path";
import type { SessionId } from "../foundations/session-id";
import { elapsedMs, type Timekeeper } from "../../time";
import type { WatcherRegistry } from "./watchers";
import {
  deafnessLine,
  type Deafness,
  type WatcherHandle,
  type Invalidation,
} from "../foundations/watch-targets";
import {
  stallReason,
  type DeliveryNotice,
  type FileEvents,
} from "./file-events";
import {
  sameIdentity,
  statIdentity,
  type FolderIdentity,
  type IdentityRead,
} from "../../utils/folder-identity";
import type { Holds, Release } from "../../utils/holds";
import { KeyedSource, NO_WATCH, type Resume } from "../../utils/keyed-source";
import type { Lane } from "../../utils/reading";
import { ABSENT, failed, type Outcome } from "../../utils/outcome";
import type { DaemonLogger } from "../../utils/logger";
import { RefreshLedger, REFRESH_TRIGGERS } from "../../utils/refresh-ledger";
import { valueOf } from "../../utils/logfmt";
import { jsonParser } from "../../var-system/parse";
import { sessionFileName } from "../../config/loader/plugins";
import type { JsonValue } from "../../var-system/types";
import type { StorageHoldId } from "../../renderer-interface/adapter";
import type {
  ManagedStorageStats,
  FaultCause,
} from "../foundations/stats-snapshot";

const DAY_MS = 24 * 60 * 60 * 1000;
// A file its program has not written for this long belongs to a session that
// is gone.
export const STORAGE_FILE_MAX_AGE_MS = 30 * DAY_MS;
export const STORAGE_SWEEP_EVERY_MS = DAY_MS;
// Entries nobody holds that are kept, so a session back from idle draws its
// last value while it is re-read.
const MAX_ENTRIES = 256;

// One generation of a folder: what tells one watch on a path from every other.
interface StorageKey {
  readonly folder: string;
  readonly generation: number;
}

// One session's file: the storage folder and the session it is for. Keyed by
// folder, not generation: a generation is this owner's own fact, and a
// session's lane carries across one, re-read when it moves.
interface SessionFile {
  readonly folder: string;
  readonly sessionId: SessionId;
}

// [LAW:types-are-the-program] A `SessionId` is a safe file name, so the path
// needs no check of its own.
const fileName = (sessionId: SessionId): string => sessionFileName(sessionId);
const fileOf = (f: SessionFile): string =>
  path.join(f.folder, fileName(f.sessionId));
const keyString = (key: StorageKey): string =>
  JSON.stringify([key.folder, key.generation]);

// Makes the storage folder if nothing is at its path, never its plugin's
// folder: a load can name the folder of a plugin since removed, and making the
// parent would bring the plugin back as an empty folder. A mkdir that fails is
// judged by what is at the path: it answers EEXIST for a file as for a folder,
// a read-only volume can refuse an existing folder before saying it exists,
// and a program can make the folder first. Nothing there is mkdir's own fault.
function madeOnce(folder: string): void {
  try {
    fs.mkdirSync(folder);
  } catch (e) {
    let st: fs.Stats;
    try {
      st = fs.statSync(folder);
    } catch {
      throw e;
    }
    if (!st.isDirectory()) throw new Error(`${folder} is not a folder`);
  }
}

// [LAW:types-are-the-program] What a hold found at a folder's path: the
// folder there or nothing (removed as it was made), or why it could not be
// made or read.
type Found =
  | { readonly kind: "found"; readonly identity: FolderIdentity | "gone" }
  | { readonly kind: "unusable"; readonly reason: string };

// [LAW:types-are-the-program] What has become of one generation's folder.
// `watching`: its folder is the one its watch opened on. `lost`: its folder is
// gone or replaced. `unusable`: its folder could not be made, which only the
// next generation's mkdir retries. `closed`: its folder's last hold released
// it, or its next generation opened. `lost`, `unusable` and `closed` end the
// generation: nothing moves it on, so each is counted once. A watch the OS is
// not listening to, or a folder a judgment could not stat, ends nothing: the
// registry's period and the next judgment ask again.
type Health =
  | { readonly kind: "watching" }
  | { readonly kind: "lost" }
  | { readonly kind: "unusable"; readonly reason: string }
  | { readonly kind: "closed" };

// The fault a generation's sources read first, and the cause it is counted
// under.
interface Fault {
  readonly cause: FaultCause;
  readonly text: string;
}

// A folder's current generation's watch, open while some hold names it.
interface Watched {
  readonly key: StorageKey;
  // The folder the watch opened on.
  readonly identity: FolderIdentity | "gone";
  readonly handle: WatcherHandle;
  readonly stopSweep: () => void;
  health: Health;
  // [LAW:no-ambient-temporal-coupling] The handle's first deafness as of the
  // last window or the open, the moments the registry tells a move of it: a
  // period can land between a reopen and its handle's next error, and reading
  // the handle there would report a recovery that never held.
  deafness: Deafness | null;
  // Why the last judgment could not stat the folder, until the next one can.
  statFailure: string | null;
}

// [LAW:one-source-of-truth] A generation's one fault, in the order its
// sources read it: a folder that could not be made, a watch the OS is not
// listening to, a folder that could not be stat'd.
function faultOf(watched: Watched): Fault | null {
  const { health, deafness, statFailure, key } = watched;
  if (health.kind === "unusable")
    return {
      cause: "unusable",
      text: `${key.folder} ${health.reason}; retried when the config next loads or file events catch up`,
    };
  if (deafness !== null)
    return {
      cause: deafness.kind === "refused" ? "refused" : "error",
      text: deafnessLine(deafness),
    };
  if (statFailure !== null)
    return { cause: "error", text: `${key.folder} ${statFailure}` };
  return null;
}

// Whether a folder's watch still serves what its hold found: its generation
// has not ended and the folder at the path is the one it opened on. So
// whichever of a removal's events comes first, a recreated folder is a new
// generation.
const current = (was: Watched, found: Found): boolean =>
  was.health.kind === "watching" &&
  found.kind === "found" &&
  found.identity !== "gone" &&
  was.identity !== "gone" &&
  sameIdentity(found.identity, was.identity);

// [LAW:single-enforcer] The one owner of every plugin's managed storage, for
// the whole daemon (design-docs/PLUGIN-API.md, "Managed storage"). A plugin's
// program writes `<storage>/<session id>.json` whole, by rename; this owner
// creates the folder, watches it once per generation, reads only the files of
// sessions something holds, and removes files nobody has written for 30 days.
//
// [LAW:no-ambient-temporal-coupling] A folder's watch lives as long as a
// render state declaring it holds it (`hold` to `release`), never as long as a
// view: opening or closing a directory watch leaks on macOS. A folder gone or
// replaced, or one that could not be made, ends its generation. While a hold
// still names the folder its owner opens the next: for one lost, at the next
// period, so a plugin folder being removed is gone, and its hold released,
// before the folder is made in it again; and for every ended one when file
// events catch up. A watch the OS is not listening to ends nothing: the
// registry's period reopens it, and the window it tells clears the fault.
//
// [LAW:one-source-of-truth] Whether the OS is delivering file events is the
// daemon's one fact, not a folder's (file-events.ts): a stall is every
// folder's, read from that owner.
export class ManagedStorage {
  private readonly sessions: KeyedSource<SessionFile, JsonValue>;
  // [LAW:one-source-of-truth] By folder: each folder's current generation's
  // watch, the one record of what the owner knows of the folder.
  private readonly watched = new Map<string, Watched>();
  // The folders each render state's latest load named.
  private readonly holds = new Map<StorageHoldId, readonly string[]>();
  private readonly faultCounts: Record<FaultCause, number> = {
    unusable: 0,
    refused: 0,
    error: 0,
  };
  private lost = 0;
  // [LAW:single-enforcer] Generations are numbered across every folder, so no
  // two watches, a folder's closed one and its next included, share a key.
  private generations = 0;
  private readonly watchers: WatcherRegistry;
  private readonly logger: DaemonLogger;
  private readonly identityOf: IdentityRead;
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
    readonly identityOf?: IdentityRead;
    readonly ledger?: RefreshLedger;
  }) {
    this.watchers = opts.watchers;
    this.logger = opts.logger;
    this.identityOf = opts.identityOf ?? statIdentity;
    this.fileEvents = opts.fileEvents;
    this.clock = opts.clock;
    this.unsubscribe = opts.fileEvents.subscribe((notice) =>
      this.noticed(notice),
    );
    this.sessions = new KeyedSource({
      name: "plugin storage",
      scope: "session",
      keyOf: (f) => JSON.stringify([f.folder, f.sessionId]),
      fields: (f) => `file=${valueOf(fileOf(f))}`,
      read: (f) => this.read(f),
      // [LAW:types-are-the-program] A plugin source has no period: its watch
      // is its trigger, and a hold's return re-reads a kept entry.
      every: () => null,
      watch: NO_WATCH,
      maxEntries: MAX_ENTRIES,
      lines: REFRESH_TRIGGERS,
      logger: opts.logger,
      ledger: opts.ledger ?? new RefreshLedger(opts.logger),
      clock: opts.clock,
    });
  }

  // A render state's load names its folders: held under its id until the next
  // load replaces the list or its `release`. Each named folder is kept
  // current (`kept`), so a folder two states name is never closed between
  // them.
  hold(id: StorageHoldId, folders: readonly string[]): void {
    this.holds.set(id, folders);
    for (const folder of new Set(folders)) this.kept(folder);
    this.closeUnheld();
  }

  // [LAW:single-enforcer] The one way a held folder's generation moves on:
  // one not yet watched, or whose generation ended, or whose path holds
  // another folder now, opens its new generation's watch before any old one
  // closes, and its held files are re-read, since what they read before came
  // from the path unwatched.
  private kept(folder: string): void {
    const was = this.watched.get(folder);
    const found = this.found(folder);
    if (was !== undefined && current(was, found)) return;
    const generation = this.generations++;
    if (was !== undefined)
      this.logger(
        "info",
        `plugin storage generation folder=${valueOf(folder)} generation=${generation}`,
      );
    this.opened({ folder, generation }, found);
    if (was !== undefined) this.closed(was);
    this.sessions.changed((f) => f.folder === folder);
  }

  // A render state reclaimed: the folders only it named close.
  release(id: StorageHoldId): void {
    this.holds.delete(id);
    this.closeUnheld();
  }

  // A session's declaration of one session's file: held at (folder, session
  // id) until the session's next declaration takes it no more. A folder no
  // hold names has no standing failure: its file reads the path.
  declare(holds: Holds, folder: string, sessionId: SessionId): Lane<JsonValue> {
    return this.sessions.declare(holds, { folder, sessionId });
  }

  // [LAW:one-source-of-truth] The keyed source's one supersede: a program run
  // for the session is about to write this file.
  supersede(folder: string, sessionId: SessionId): Resume {
    return this.sessions.supersede({ folder, sessionId });
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
    this.holds.clear();
    this.closeUnheld();
  }

  // What a hold finds at a folder's path. Creates the storage folder, so its
  // program has somewhere to write before any session reads it.
  // [LAW:no-silent-failure] A folder that cannot be created or read is its
  // generation's standing fault, read by every source in it, never a throw:
  // one plugin's folder fails only that plugin's sources, not the build.
  private found(folder: string): Found {
    try {
      madeOnce(folder);
      return { kind: "found", identity: this.identityOf(folder) };
    } catch (e) {
      return {
        kind: "unusable",
        reason: `could not be created or read: ${(e as Error).message}`,
      };
    }
  }

  // Closes every folder no hold names.
  private closeUnheld(): void {
    const named = new Set([...this.holds.values()].flat());
    for (const [folder, watched] of [...this.watched])
      if (!named.has(folder)) this.closed(watched);
  }

  // Opens a folder's next generation, on what its hold found, as the folder's
  // current watch.
  private opened(key: StorageKey, found: Found): Watched {
    const identity = found.kind === "found" ? found.identity : "gone";
    const watched: Watched = {
      key,
      identity,
      // [LAW:single-enforcer] The only acquirer of this registry key, so the
      // slot's one callback is this generation's own.
      handle: this.watchers.acquire(
        `plugin-storage:${keyString(key)}`,
        { dirs: [{ path: key.folder }], polled: [] },
        (invalidation) => this.invalidated(watched, invalidation),
      ),
      stopSweep: this.clock.every(
        STORAGE_SWEEP_EVERY_MS,
        () => void this.sweep(key),
        { unref: true },
      ),
      health: { kind: "watching" },
      deafness: null,
      statFailure: null,
    };
    this.watched.set(key.folder, watched);
    // What the open found is the generation's first fault: a folder that
    // could not be made, or a refusal at acquire, the handle's at once.
    this.restated(watched, () => {
      if (found.kind === "unusable")
        watched.health = { kind: "unusable", reason: found.reason };
      watched.deafness = watched.handle.deaf[0] ?? null;
    });
    void this.sweep(key);
    return watched;
  }

  // Closes a generation's watch. The folder's entry goes only if it is still
  // this one: a hold that moved the generation has already put its successor
  // there.
  private closed(watched: Watched): void {
    if (this.watched.get(watched.key.folder) === watched)
      this.watched.delete(watched.key.folder);
    watched.health = { kind: "closed" };
    watched.stopSweep();
    watched.handle.release();
  }

  // [LAW:dataflow-not-control-flow] Routing by what the window named: the
  // held files it names re-read; the folder's own name, an error or a
  // recovery is judged against the disk. An `unknown` window may hold the
  // folder's own event (an unnamed one, or a named one the window folded), so
  // it is judged as the folder's own name is, re-reading every held file in
  // the folder still there. The OS reports a change to the watched folder
  // itself under the folder's own name, as though it were a child, so that
  // path is the folder joined with its own name. Every window first takes the
  // handle's deafness as it stands, since the registry tells one on each move
  // of it.
  private invalidated(watched: Watched, invalidation: Invalidation): void {
    const { key } = watched;
    const inFolder = (f: SessionFile) => f.folder === key.folder;
    this.restated(watched, () => {
      watched.deafness = watched.handle.deaf[0] ?? null;
    });
    switch (invalidation.kind) {
      case "unknown":
      case "failed":
        this.judged(watched, () => this.sessions.changed(inFolder));
        return;
      case "changed": {
        const { paths } = invalidation;
        if (paths.includes(path.join(key.folder, path.basename(key.folder)))) {
          this.judged(watched, () => this.sessions.changed(inFolder));
        } else {
          this.sessions.changed(
            (f) => inFolder(f) && paths.includes(fileOf(f)),
          );
        }
        return;
      }
    }
  }

  // [LAW:one-source-of-truth] Whether the folder is gone is the disk's to
  // say: a chmod, a utimes or an xattr reports the folder's own name exactly
  // as a removal does. Lost only if the path is gone or holds another folder;
  // otherwise `present` runs. A lost folder's held files are re-read from the
  // path, so no draw shows a value from a folder no longer there while the
  // next period opens the next generation. A generation already ended has
  // nothing left to judge. A stat that fails is the generation's fault until
  // a judgment's stat succeeds.
  private judged(watched: Watched, present: () => void): void {
    const { health } = watched;
    if (health.kind !== "watching") return;
    const { key } = watched;
    let now: FolderIdentity | "gone";
    try {
      now = this.identityOf(key.folder);
    } catch (e) {
      this.restated(watched, () => {
        watched.statFailure = `stat failed: ${(e as Error).message}`;
      });
      return;
    }
    this.restated(watched, () => {
      watched.statFailure = null;
    });
    const opened = watched.identity;
    if (now !== "gone" && opened !== "gone" && sameIdentity(now, opened)) {
      present();
      return;
    }
    watched.health = { kind: "lost" };
    this.lost++;
    this.logger(
      "info",
      `plugin storage lost folder=${valueOf(key.folder)} generation=${key.generation} now=${now === "gone" ? "gone" : "replaced"}`,
    );
    this.sessions.changed((f) => f.folder === key.folder);
  }

  // [LAW:no-silent-failure] [LAW:nothing-unseen] What `update` moves of a
  // generation's fault: a start or a change of it is counted and logged once,
  // a clear is logged, and either re-reads the folder's held files, so every
  // source reads the fault as it stands. A fault that stays as it was tells
  // nothing, as the registry's refusal repeated does not: it would bury the
  // events around it.
  private restated(watched: Watched, update: () => void): void {
    const was = faultOf(watched);
    update();
    const now = faultOf(watched);
    if (was?.cause === now?.cause && was?.text === now?.text) return;
    const { key } = watched;
    const at = `folder=${valueOf(key.folder)} generation=${key.generation}`;
    if (now === null)
      this.logger(
        "info",
        `plugin storage fault cleared ${at} cause=${was!.cause}`,
      );
    else {
      this.faultCounts[now.cause]++;
      this.logger(
        "warn",
        `plugin storage fault ${at} cause=${now.cause} reason=${JSON.stringify(now.text)}`,
      );
    }
    this.sessions.changed((f) => f.folder === key.folder);
  }

  // [LAW:one-source-of-truth] What the delivery owner says reaches every
  // folder. Each period opens the next generation of every folder lost before
  // it, and judges every watched one against the disk: the event naming a
  // removed folder can drop without a stall. Every change of delivery and
  // every catch-up re-reads every held file, so no lane keeps a stall after
  // delivery moves on, and a file written during a span lands; a catch-up
  // also opens the next generation of every held folder whose generation
  // ended, as the span may have held what ended it.
  private noticed(notice: DeliveryNotice): void {
    switch (notice.kind) {
      case "period":
        for (const watched of [...this.watched.values()])
          if (watched.health.kind === "lost") this.kept(watched.key.folder);
          else this.judged(watched, () => {});
        return;
      case "caught-up":
        for (const watched of [...this.watched.values()])
          if (watched.health.kind !== "watching") this.kept(watched.key.folder);
        this.sessions.changed(() => true);
        return;
      case "moved":
        this.sessions.changed(() => true);
        return;
    }
  }

  // The folder's current generation's standing failure, which every source
  // in it reads first: its fault, then a stall. A folder no hold names has
  // none: its files read the path. A lost generation reads its watch's fault
  // too, since its held files are refreshed only through that watch.
  // While file events are stalled a folder's sources read the stall, never a
  // file read once from the path and then left unrefreshed. While delivery is
  // unmeasured its files read as usual: the bar's row already says it cannot
  // be checked.
  private standing(folder: string): string | null {
    const watched = this.watched.get(folder);
    if (watched === undefined || watched.health.kind === "closed") return null;
    const fault = faultOf(watched);
    if (fault !== null) return `cannot refresh: ${fault.text}`;
    const stall = stallReason(this.fileEvents.delivery());
    return stall === null ? null : `cannot refresh: ${folder}: ${stall}`;
  }

  private async read(f: SessionFile): Promise<Outcome<JsonValue>> {
    const fault = this.standing(f.folder);
    if (fault !== null) return failed(fault, "read");
    const file = fileOf(f);
    let text: string;
    try {
      text = await fs.promises.readFile(file, "utf8");
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
      const entries = await fs.promises.readdir(key.folder, {
        withFileTypes: true,
      });
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        scanned++;
        const file = path.join(key.folder, entry.name);
        try {
          const { mtimeMs } = await fs.promises.stat(file);
          const held = this.sessions.isHeld(
            (f) =>
              f.folder === key.folder && fileName(f.sessionId) === entry.name,
          );
          if (mtimeMs >= cutoff || held) continue;
          await fs.promises.unlink(file);
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
