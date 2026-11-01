import fs from "node:fs";
import path from "node:path";
import type { SessionId } from "../session-id";
import type { WatcherHandle, WatcherRegistry, Invalidation } from "./watchers";
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
import {
  KeyedSource,
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
// the OS refused to open its watch, or the watch reported an error after it
// opened on a folder still there.
export type FaultCause = "unusable" | "refused" | "error";

export interface ManagedStorageStats extends KeyedSourceStats {
  // Folders watched now.
  readonly folders: number;
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
  // Gone, replaced, or its watch faulted: the next key request moves the
  // generation.
  lost: boolean;
  // Why the last key request could not create or read the folder, or null:
  // its generation's standing fault, set when the watch opens.
  unusable: string | null;
}

// [LAW:types-are-the-program] What has become of one generation's folder,
// which its sources' reads derive their failure from first. `watching`: its
// folder is the one its watch opened on. `lost`: its folder is gone or
// replaced. `faulted`: its folder could not be made or its watch failed.
// `closed`: its last holder released it. `lost`, `faulted` and `closed` end
// the generation: nothing moves it on, so each is counted once.
type Health =
  | { readonly kind: "watching" }
  | { readonly kind: "lost" }
  | { readonly kind: "faulted"; readonly reason: string }
  | { readonly kind: "closed" };

// One generation's watch, held by the render states that declare the folder.
interface Watched {
  readonly key: StorageKey;
  readonly folder: Folder;
  // The folder the watch opened on.
  readonly identity: FolderIdentity | "gone";
  holders: number;
  readonly handle: WatcherHandle;
  readonly sweep: NodeJS.Timeout;
  health: Health;
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
// a watch: a folder gone or replaced is marked lost, and the next key request
// (a config load) moves its generation.
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
  private readonly identityOf: IdentityRead;
  private readonly fileEvents: FileEvents;
  private readonly unsubscribe: Release;

  constructor(opts: {
    readonly watchers: WatcherRegistry;
    readonly logger: DaemonLogger;
    readonly fileEvents: FileEvents;
    readonly identityOf?: IdentityRead;
    readonly ledger?: RefreshLedger;
  }) {
    this.watchers = opts.watchers;
    this.logger = opts.logger;
    this.identityOf = opts.identityOf ?? statIdentity;
    this.fileEvents = opts.fileEvents;
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
      every: null,
      maxEntries: MAX_ENTRIES,
      logger: opts.logger,
      ledger: opts.ledger ?? new RefreshLedger(opts.logger),
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
      fs.mkdirSync(folder, { recursive: true });
      now = this.identityOf(folder);
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
    const identity = unusable === null ? this.identityOf(key.folder) : "gone";
    if (key.generation === folder.generation) {
      folder.identity = identity === "gone" ? null : identity;
    }
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
      sweep: setInterval(() => void this.sweep(key), STORAGE_SWEEP_EVERY_MS),
      health: { kind: "watching" },
    };
    watched.sweep.unref();
    this.watched.set(keyString(key), watched);
    // First, so its reason is the one the sources read: a folder that could
    // not be made refuses its watch too.
    if (unusable !== null) this.faulted(watched, "unusable", unusable);
    for (const refusal of watched.handle.deaf) {
      this.faulted(watched, "refused", refusal.reason);
    }
    void this.sweep(key);
    return watched;
  }

  private closed(watched: Watched): void {
    const id = keyString(watched.key);
    this.watched.delete(id);
    watched.health = { kind: "closed" };
    clearInterval(watched.sweep);
    watched.handle.release();
  }

  // [LAW:dataflow-not-control-flow] Routing by what the window named: the
  // held files it names re-read; the folder's own name or an error is judged
  // against the disk. An `unknown` window may hold the folder's own event (an
  // unnamed one, or a named one the window folded), so it is judged as the
  // folder's own name is, re-reading every held file in the folder still
  // there. The OS reports a change to the watched folder itself under the
  // folder's own name, as though it were a child, so that path is the folder
  // joined with its own name.
  private invalidated(watched: Watched, invalidation: Invalidation): void {
    const { key } = watched;
    const inFolder = (f: SessionFile) => sameKey(f.storage, key);
    switch (invalidation.kind) {
      case "unknown":
        this.judged(watched, () => this.sessions.changed(inFolder));
        return;
      case "changed": {
        const { paths } = invalidation;
        if (paths.has(path.join(key.folder, path.basename(key.folder)))) {
          this.judged(watched, () => this.sessions.changed(inFolder));
        } else {
          this.sessions.changed((f) => inFolder(f) && paths.has(fileOf(f)));
        }
        return;
      }
      case "failed":
        this.judged(watched, () =>
          this.faulted(watched, "error", invalidation.reason),
        );
        return;
    }
  }

  // [LAW:one-source-of-truth] Whether the folder is gone is the disk's to
  // say: a chmod, a utimes or an xattr reports the folder's own name exactly
  // as a removal does. Lost only if the path is gone or holds another folder;
  // otherwise `present` runs. A lost folder's held files are re-read from the
  // path, so no draw shows a value from a folder no longer there while the
  // config's reload opens the next generation. A generation already ended has
  // nothing left to judge.
  private judged(watched: Watched, present: () => void): void {
    const { health } = watched;
    if (health.kind !== "watching") return;
    const { key, folder } = watched;
    let now: FolderIdentity | "gone";
    try {
      now = this.identityOf(key.folder);
    } catch (e) {
      this.faulted(watched, "error", `stat failed: ${(e as Error).message}`);
      return;
    }
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

  // [LAW:no-silent-failure] A watch the OS refused, or one that errored on a
  // folder still there, is a standing fault: every source read from the
  // generation reads it, and the folder is marked lost, so the next config
  // load opens a fresh generation. No retry here: the OS refusing a watch
  // (limits, permissions) refuses an immediate retry the same way.
  private faulted(watched: Watched, cause: FaultCause, reason: string): void {
    const { key, folder } = watched;
    if (watched.health.kind !== "watching") return;
    watched.health = { kind: "faulted", reason };
    this.faultCounts[cause]++;
    if (key.generation === folder.generation) folder.lost = true;
    this.logger(
      "warn",
      `plugin storage fault folder=${valueOf(key.folder)} generation=${key.generation} cause=${cause} reason=${JSON.stringify(reason)}`,
    );
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

  // The generation's standing failure, which every source in it reads first.
  // A generation no render state watches has none: its files read the path.
  private standing(storage: StorageKey): string | null {
    const watched = this.watched.get(keyString(storage));
    if (watched === undefined) return null;
    const { health } = watched;
    switch (health.kind) {
      case "faulted":
        return `cannot refresh: ${storage.folder} ${health.reason}; reload the config or restart the daemon`;
      // A lost folder's watch is still open, and the reload that would move
      // it on rides the same file events, so while they are stalled its
      // sources read the stall, never a file read once from the path and then
      // left unrefreshed. While delivery is unmeasured its files read as
      // usual: the bar's row already says it cannot be checked.
      case "watching":
      case "lost": {
        const stall = stallReason(this.fileEvents.delivery());
        return stall === null
          ? null
          : `cannot refresh: ${storage.folder}: ${stall}`;
      }
      case "closed":
        return null;
    }
  }

  private async read(f: SessionFile): Promise<Outcome<JsonValue>> {
    const fault = this.standing(f.storage);
    if (fault !== null) return failed(fault);
    const file = fileOf(f);
    let text: string;
    try {
      text = await fs.promises.readFile(file, "utf8");
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      return err.code === "ENOENT" ? ABSENT : failed(`${file}: ${err.message}`);
    }
    // A program writes the file whole, by rename, so blank text is a program
    // that has nothing to say, never a torn write.
    if (text.trim() === "") return ABSENT;
    const parsed = jsonParser(text);
    return parsed.kind === "failed"
      ? failed(`${file}: ${parsed.reason}`)
      : parsed;
  }

  // Removes every `*.json` file nobody has written for 30 days, unless a
  // session holds it now. One event per sweep.
  private async sweep(key: StorageKey): Promise<void> {
    const startedAt = Date.now();
    const cutoff = startedAt - STORAGE_FILE_MAX_AGE_MS;
    let scanned = 0;
    let removed = 0;
    const event = () =>
      `plugin storage sweep folder=${valueOf(key.folder)} scanned=${scanned} removed=${removed} took=${Date.now() - startedAt}ms`;
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
              f.storage.folder === key.folder &&
              fileName(f.sessionId) === entry.name,
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
