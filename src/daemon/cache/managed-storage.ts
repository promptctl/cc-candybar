import fs from "node:fs";
import path from "node:path";
import type { SessionId } from "../foundations/session-id";
import { elapsedMs, type Timekeeper } from "../../time";
import type { WatcherRegistry } from "./watchers";
import type { WatcherHandle, Invalidation } from "../foundations/watch-targets";
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

// [LAW:types-are-the-program] What the owner knows of one folder a hold
// names, each state carrying only what is true of it. `unmade`: it could not
// be made, so there is no folder to watch. `unreadable`: a folder is there,
// with no identity to watch it by. `lost`: the folder its generation watched
// is gone or replaced, and its owner makes it again at the next period.
// `watching`: a generation. A generation that ends leaves this state, so no
// fault outlives the folder it was about.
type Folder =
  | { readonly kind: "unmade"; readonly reason: string }
  | { readonly kind: "unreadable"; readonly reason: string }
  | { readonly kind: "lost" }
  | Watching;

interface Watching {
  readonly kind: "watching";
  readonly key: StorageKey;
  // The folder the watch opened on.
  readonly identity: FolderIdentity;
  readonly handle: WatcherHandle;
  readonly stopSweep: () => void;
  // Why its identity could not be read when last asked, or null. The watch
  // stays: a stat that fails says nothing of whether the folder moved.
  unread: string | null;
}

// [LAW:types-are-the-program] What a read of a folder's path found.
type Read =
  | { readonly kind: "found"; readonly identity: FolderIdentity }
  | { readonly kind: "gone" }
  | { readonly kind: "unreadable"; readonly reason: string };

// [LAW:one-source-of-truth] Each answer a folder can stand faulted on, each
// started, changed and cleared on its own: the make, the identity's read, and
// the watch, which is the registry's own fact (a handle's `deaf`, live).
interface Fault {
  readonly cause: FaultCause;
  readonly reason: string;
}
interface Faults {
  readonly make: Fault | null;
  readonly read: Fault | null;
  readonly watch: Fault | null;
}
const NO_FAULTS: Faults = { make: null, read: null, watch: null };
const SOURCES = ["make", "read", "watch"] as const;

const faultsOf = (folder: Folder | undefined): Faults => {
  switch (folder?.kind) {
    case undefined:
    case "lost":
      return NO_FAULTS;
    case "unmade":
      return {
        ...NO_FAULTS,
        make: { cause: "unusable", reason: folder.reason },
      };
    case "unreadable":
      return {
        ...NO_FAULTS,
        read: { cause: "unreadable", reason: folder.reason },
      };
    case "watching": {
      const [deaf] = folder.handle.deaf;
      return {
        make: null,
        read:
          folder.unread === null
            ? null
            : { cause: "unreadable", reason: folder.unread },
        watch:
          deaf === undefined
            ? null
            : {
                cause: deaf.kind === "refused" ? "refused" : "error",
                reason: deaf.reason,
              },
      };
    }
  }
};

const sameFault = (a: Fault | null, b: Fault | null): boolean =>
  a === b || (a?.cause === b?.cause && a?.reason === b?.reason);

const watchKey = (key: StorageKey): string =>
  `plugin-storage:${keyString(key)}`;
const targetsOf = (folder: string) => ({
  dirs: [{ path: folder }],
  polled: [],
});

// The triggers that ask again for a held folder: a load's hold, the delivery
// owner's period, and its catch-up.
type Trigger = "hold" | "period" | "caught-up";

// [LAW:single-enforcer] The one owner of every plugin's managed storage, for
// the whole daemon (design-docs/PLUGIN-API.md, "Managed storage"). A plugin's
// program writes `<storage>/<session id>.json` whole, by rename; this owner
// creates the folder, watches it once per generation, reads only the files of
// sessions something holds, and removes files nobody has written for 30 days.
//
// [LAW:no-ambient-temporal-coupling] A folder's watch lives as long as a
// render state declaring it holds it (`hold` to `release`), never as long as a
// view: opening or closing a directory watch leaks on macOS. A folder gone or
// replaced ends its generation. Every hold, period and catch-up asks again of
// every held folder (`asked`), so a fault stands only while the OS or the disk
// keeps giving its answer. A lost folder is made again at the next period, not
// at once, so a plugin folder being removed is gone, and its hold released,
// before the folder is made in it again.
//
// [LAW:one-source-of-truth] Whether the OS is delivering file events is the
// daemon's one fact, not a folder's (file-events.ts): a stall is every
// folder's, read from that owner.
export class ManagedStorage {
  private readonly sessions: KeyedSource<SessionFile, JsonValue>;
  // [LAW:one-source-of-truth] By folder: what the owner knows of each folder
  // a hold names.
  private readonly folders = new Map<string, Folder>();
  // By folder: the faults last logged and counted, so each is told once as it
  // starts, changes and clears.
  private readonly told = new Map<string, Faults>();
  // The folders each render state's latest load named.
  private readonly holds = new Map<StorageHoldId, readonly string[]>();
  private readonly faultCounts: Record<FaultCause, number> = {
    unusable: 0,
    unreadable: 0,
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
  // load replaces the list or its `release`. Each named folder is asked again
  // before any unheld one closes, so a folder two states name is never closed
  // between them.
  hold(id: StorageHoldId, folders: readonly string[]): void {
    this.holds.set(id, folders);
    for (const folder of new Set(folders)) this.asked(folder, "hold");
    this.closeUnheld();
  }

  // [LAW:single-enforcer] The one way a trigger asks again of a held folder.
  // A generation's folder is read, never made: a stat that fails keeps the
  // generation, and the registry judges its watch again, as it does for an
  // acquire joining the slot, so a deaf watch reopens on the owner's own
  // triggers. A folder found gone or replaced is lost, except at a hold, which
  // makes it again at once. Any other state is made and read again, and a
  // folder made opens its next generation's watch before any old one closes.
  private asked(folder: string, trigger: Trigger): void {
    const was = this.folders.get(folder);
    if (was?.kind === "watching") {
      const read = this.readAt(folder);
      if (read.kind === "unreadable" || this.present(was, read)) {
        was.unread = read.kind === "unreadable" ? read.reason : null;
        // [LAW:single-enforcer] The registry's judge, reached through an
        // acquire that joins the slot; its handle goes at once, so no watch
        // opens or closes but one the judge reopens.
        this.watchers
          .acquire(watchKey(was.key), targetsOf(folder), () => {})
          .release();
        this.settle(folder);
        return;
      }
      if (trigger !== "hold") {
        this.lostAt(was, read);
        return;
      }
    }
    this.moved(folder, this.made(folder));
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
      folders: this.folders.size,
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

  // What a folder's path holds once made: the storage folder is made first,
  // so its program has somewhere to write before any session reads it.
  // [LAW:no-silent-failure] A folder that cannot be made or read is a standing
  // fault of every source in it, never a throw: one plugin's folder fails only
  // that plugin's sources, not the build.
  private made(folder: string): Folder {
    try {
      madeOnce(folder);
    } catch (e) {
      return {
        kind: "unmade",
        reason: `could not be created: ${(e as Error).message}`,
      };
    }
    const read = this.readAt(folder);
    switch (read.kind) {
      case "unreadable":
        return read;
      // Removed as it was made.
      case "gone":
        return { kind: "lost" };
      case "found":
        return this.opened(folder, read.identity);
    }
  }

  private readAt(folder: string): Read {
    try {
      const identity = this.identityOf(folder);
      return identity === "gone"
        ? { kind: "gone" }
        : { kind: "found", identity };
    } catch (e) {
      return {
        kind: "unreadable",
        reason: `could not be read: ${(e as Error).message}`,
      };
    }
  }

  // Whether a read found the folder a generation's watch opened on.
  private present(was: Watching, read: Read): boolean {
    return read.kind === "found" && sameIdentity(read.identity, was.identity);
  }

  // Closes every folder no hold names.
  private closeUnheld(): void {
    const named = new Set([...this.holds.values()].flat());
    for (const folder of [...this.folders.keys()])
      if (!named.has(folder)) this.moved(folder, undefined);
  }

  // Opens a folder's next generation on the folder a read found.
  private opened(folder: string, identity: FolderIdentity): Watching {
    const key: StorageKey = { folder, generation: this.generations++ };
    const watching: Watching = {
      kind: "watching",
      key,
      identity,
      // [LAW:single-enforcer] The only holder of this registry key past an
      // acquire, so the slot's one lasting callback is this generation's own.
      handle: this.watchers.acquire(
        watchKey(key),
        targetsOf(folder),
        (invalidation) => this.invalidated(watching, invalidation),
      ),
      stopSweep: this.clock.every(
        STORAGE_SWEEP_EVERY_MS,
        () => void this.sweep(key),
        { unref: true },
      ),
      unread: null,
    };
    void this.sweep(key);
    return watching;
  }

  // A folder's state moves: a generation it ends closes, after any next one
  // opened, and its held files are re-read, since what they read before came
  // from another folder or from the path unwatched. `undefined`: no hold
  // names it now.
  private moved(folder: string, now: Folder | undefined): void {
    const was = this.folders.get(folder);
    if (now === undefined) this.folders.delete(folder);
    else this.folders.set(folder, now);
    if (now?.kind === "watching" && now !== was && was !== undefined)
      this.logger(
        "info",
        `plugin storage generation folder=${valueOf(folder)} generation=${now.key.generation}`,
      );
    if (was?.kind === "watching" && was !== now) {
      was.stopSweep();
      was.handle.release();
    }
    this.settle(folder);
    if (was !== now) this.sessions.changed((f) => f.folder === folder);
  }

  // [LAW:no-silent-failure] Each fault a folder stands on is logged and
  // counted as it starts and as its reason changes, and logged as it clears,
  // once each; a source whose fault moved re-reads its files, which read the
  // faults standing now.
  private settle(folder: string): void {
    const was = this.told.get(folder) ?? NO_FAULTS;
    const now = faultsOf(this.folders.get(folder));
    let moved = false;
    for (const source of SOURCES) {
      const before = was[source];
      const after = now[source];
      if (sameFault(before, after)) continue;
      moved = true;
      if (after === null) {
        this.logger(
          "info",
          `plugin storage fault cleared folder=${valueOf(folder)} cause=${before!.cause}`,
        );
        continue;
      }
      this.faultCounts[after.cause]++;
      this.logger(
        "warn",
        `plugin storage fault folder=${valueOf(folder)} cause=${after.cause} reason=${JSON.stringify(after.reason)}`,
      );
    }
    if (SOURCES.every((source) => now[source] === null))
      this.told.delete(folder);
    else this.told.set(folder, now);
    if (moved) this.sessions.changed((f) => f.folder === folder);
  }

  // [LAW:dataflow-not-control-flow] Routing by what the window named: the
  // held files it names re-read; the folder's own name or an error is judged
  // against the disk. An `unknown` window may hold the folder's own event (an
  // unnamed one, or a named one the window folded), so it is judged as the
  // folder's own name is, re-reading every held file in the folder still
  // there. The OS reports a change to the watched folder itself under the
  // folder's own name, as though it were a child, so that path is the folder
  // joined with its own name. A generation no longer the folder's state has
  // nothing left to hear.
  private invalidated(watching: Watching, invalidation: Invalidation): void {
    const { folder } = watching.key;
    if (this.folders.get(folder) !== watching) return;
    const inFolder = (f: SessionFile) => f.folder === folder;
    switch (invalidation.kind) {
      case "unknown":
        if (this.judged(watching)) this.sessions.changed(inFolder);
        return;
      case "changed": {
        const { paths } = invalidation;
        if (paths.includes(path.join(folder, path.basename(folder)))) {
          if (this.judged(watching)) this.sessions.changed(inFolder);
        } else {
          this.sessions.changed(
            (f) => inFolder(f) && paths.includes(fileOf(f)),
          );
        }
        return;
      }
      // The watch's fault is the handle's to say (`faultsOf`).
      case "failed":
        this.judged(watching);
        return;
    }
  }

  // [LAW:one-source-of-truth] Whether the folder is gone is the disk's to
  // say: a chmod, a utimes or an xattr reports the folder's own name exactly
  // as a removal does. Lost only if the path is gone or holds another folder;
  // a stat that fails keeps the generation. True while it still watches.
  private judged(watching: Watching): boolean {
    const read = this.readAt(watching.key.folder);
    if (read.kind === "unreadable" || this.present(watching, read)) {
      watching.unread = read.kind === "unreadable" ? read.reason : null;
      this.settle(watching.key.folder);
      return true;
    }
    this.lostAt(watching, read);
    return false;
  }

  // A generation's folder found gone or replaced: the generation ends, and
  // its held files are re-read from the path, so no draw shows a value from a
  // folder no longer there while the next period makes it again.
  private lostAt(watching: Watching, read: Read): void {
    const { key } = watching;
    this.lost++;
    this.logger(
      "info",
      `plugin storage lost folder=${valueOf(key.folder)} generation=${key.generation} now=${read.kind === "gone" ? "gone" : "replaced"}`,
    );
    this.moved(key.folder, { kind: "lost" });
  }

  // [LAW:one-source-of-truth] What the delivery owner says reaches every
  // folder. Each period and each catch-up asks again of every held folder:
  // the event naming a removed folder can drop without a stall, and a fault
  // stands only while its answer does. Every change of delivery and every
  // catch-up re-reads every held file, so no lane keeps a stall after
  // delivery moves on, and a file written during a span lands.
  private noticed(notice: DeliveryNotice): void {
    switch (notice.kind) {
      case "period":
      case "caught-up":
        for (const folder of [...this.folders.keys()])
          this.asked(folder, notice.kind);
        if (notice.kind === "caught-up") this.sessions.changed(() => true);
        return;
      case "moved":
        this.sessions.changed(() => true);
        return;
    }
  }

  // The folder's standing failure, which every source in it reads first:
  // every fault standing, else the stall. A folder no hold names has none:
  // its files read the path.
  private standing(folder: string): string | null {
    const state = this.folders.get(folder);
    if (state === undefined) return null;
    const faults = faultsOf(state);
    const reasons = SOURCES.flatMap((source) => {
      const fault = faults[source];
      return fault === null ? [] : [fault.reason];
    });
    if (reasons.length > 0)
      return `cannot refresh: ${folder} ${reasons.join("; ")}; retried at the next config load or file-event check`;
    // While file events are stalled a folder's sources read the stall, never
    // a file read once from the path and then left unrefreshed. While
    // delivery is unmeasured its files read as usual: the bar's row already
    // says it cannot be checked.
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
