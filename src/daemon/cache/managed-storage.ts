import fs from "node:fs";
import path from "node:path";
import type { SessionId } from "../session-id";
import type { WatcherHandle, WatcherRegistry, Invalidation } from "./watchers";
import type { Holds, Release } from "../../utils/holds";
import {
  KeyedSource,
  type KeyedSourceStats,
  type Resume,
} from "../../utils/keyed-source";
import type { Lane } from "../../utils/reading";
import { ABSENT, failed, type Outcome } from "../../utils/outcome";
import type { DaemonLogger } from "../../utils/logger";
import { valueOf } from "../../utils/logfmt";
import { jsonParser } from "../../var-system/parse";
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

// What tells one folder from another across a delete and a create: device and
// inode name a folder that exists now, and birth time is there because ext4
// reuses a freed inode number. `gone`: nothing is at the path.
export interface FolderIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly birthtimeNs: bigint;
}
export type IdentityRead = (folder: string) => FolderIdentity | "gone";

// [LAW:effects-at-boundaries] The disk's answer. A stat that fails for any
// reason but a missing path throws: the folder cannot be judged.
export const statIdentity: IdentityRead = (folder) => {
  try {
    const st = fs.statSync(folder, { bigint: true });
    return { dev: st.dev, ino: st.ino, birthtimeNs: st.birthtimeNs };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return "gone";
    throw e;
  }
};

const sameIdentity = (a: FolderIdentity, b: FolderIdentity): boolean =>
  a.dev === b.dev && a.ino === b.ino && a.birthtimeNs === b.birthtimeNs;

// The faults a folder's watch can stand in, by cause: the OS refused to open
// it, or it reported an error after it opened on a folder still there.
export type FaultCause = "refused" | "error";

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
const fileName = (sessionId: SessionId): string => `${sessionId}.json`;
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
}

// One generation's watch, held by the render states that declare the folder.
interface Watched {
  readonly key: StorageKey;
  readonly folder: Folder;
  // The folder the watch opened on.
  readonly identity: FolderIdentity | "gone";
  holders: number;
  readonly handle: WatcherHandle;
  readonly sweep: NodeJS.Timeout;
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
export class ManagedStorage {
  private readonly sessions: KeyedSource<SessionFile, JsonValue>;
  private readonly folders = new Map<string, Folder>();
  private readonly watched = new Map<string, Watched>();
  // A faulted generation's standing failure, read by every source in it.
  private readonly faults = new Map<string, string>();
  private readonly faultCounts: Record<FaultCause, number> = {
    refused: 0,
    error: 0,
  };
  private lost = 0;
  private readonly watchers: WatcherRegistry;
  private readonly logger: DaemonLogger;
  private readonly identityOf: IdentityRead;

  constructor(opts: {
    readonly watchers: WatcherRegistry;
    readonly logger: DaemonLogger;
    readonly identityOf?: IdentityRead;
  }) {
    this.watchers = opts.watchers;
    this.logger = opts.logger;
    this.identityOf = opts.identityOf ?? statIdentity;
    this.sessions = new KeyedSource({
      name: "plugin storage",
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
    });
  }

  // The key a render state's build holds for a folder its config declares.
  // Creates the folder, so its program has somewhere to write before any
  // session reads it, and stats it. The generation moves when the folder was
  // marked lost or is no longer the folder its watch opened on; so whichever
  // of a removal's events comes first, a recreated folder is a new key.
  // Throws when the folder cannot be created or judged: the build fails loud.
  keyFor(folder: string): StorageKey {
    fs.mkdirSync(folder, { recursive: true });
    const now = this.identityOf(folder);
    const known = this.folders.get(folder) ?? this.recorded(folder);
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
    this.sessions.close();
    for (const watched of [...this.watched.values()]) this.closed(watched);
  }

  private recorded(folder: string): Folder {
    const known: Folder = { generation: 0, identity: null, lost: false };
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
    const identity = this.identityOf(key.folder);
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
        { files: [], dirs: [{ path: key.folder }] },
        (invalidation) => this.invalidated(watched, invalidation),
      ),
      sweep: setInterval(() => void this.sweep(key), STORAGE_SWEEP_EVERY_MS),
    };
    watched.sweep.unref();
    this.watched.set(keyString(key), watched);
    for (const refusal of watched.handle.refused) {
      this.faulted(watched, "refused", refusal.reason);
    }
    void this.sweep(key);
    return watched;
  }

  private closed(watched: Watched): void {
    const id = keyString(watched.key);
    this.watched.delete(id);
    this.faults.delete(id);
    clearInterval(watched.sweep);
    watched.handle.release();
  }

  // [LAW:dataflow-not-control-flow] Routing by what the window named: the
  // held files it names re-read; an unnamed event re-reads every held file in
  // the folder; the folder's own name or an error is judged against the disk.
  private invalidated(watched: Watched, invalidation: Invalidation): void {
    const { key } = watched;
    const inFolder = (f: SessionFile) => sameKey(f.storage, key);
    switch (invalidation.kind) {
      case "unknown":
        this.sessions.changed(inFolder);
        return;
      case "changed": {
        const { names } = invalidation;
        if (names.has(path.basename(key.folder))) {
          this.judged(watched, () => this.sessions.changed(inFolder));
        } else {
          this.sessions.changed(
            (f) => inFolder(f) && names.has(fileName(f.sessionId)),
          );
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
  // otherwise `present` runs.
  private judged(watched: Watched, present: () => void): void {
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
    // An older generation's watch has nothing left to judge: its folder has
    // already moved on.
    if (key.generation !== folder.generation) return;
    folder.lost = true;
    this.lost++;
    this.logger(
      "info",
      `plugin storage lost folder=${valueOf(key.folder)} generation=${key.generation} now=${now === "gone" ? "gone" : "replaced"}`,
    );
  }

  // [LAW:no-silent-failure] A watch the OS refused, or one that errored on a
  // folder still there, is a standing fault: every source read from the
  // generation reads it, and the folder is marked lost, so the next config
  // load opens a fresh generation. No retry here: the OS refusing a watch
  // (limits, permissions) refuses an immediate retry the same way.
  private faulted(watched: Watched, cause: FaultCause, reason: string): void {
    const { key, folder } = watched;
    this.faults.set(
      keyString(key),
      `cannot refresh: ${key.folder} ${reason}; reload the config or restart the daemon`,
    );
    this.faultCounts[cause]++;
    if (key.generation === folder.generation) folder.lost = true;
    this.logger(
      "warn",
      `plugin storage fault folder=${valueOf(key.folder)} generation=${key.generation} cause=${cause} reason=${JSON.stringify(reason)}`,
    );
    this.sessions.changed((f) => sameKey(f.storage, key));
  }

  private async read(f: SessionFile): Promise<Outcome<JsonValue>> {
    const fault = this.faults.get(keyString(f.storage));
    if (fault !== undefined) return failed(fault);
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
        const { mtimeMs } = await fs.promises.stat(file);
        const held = this.sessions.isHeld(
          (f) =>
            f.storage.folder === key.folder &&
            fileName(f.sessionId) === entry.name,
        );
        if (mtimeMs >= cutoff || held) continue;
        await fs.promises.unlink(file);
        removed++;
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
