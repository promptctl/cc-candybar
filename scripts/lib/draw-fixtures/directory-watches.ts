import path from "node:path";
import { EventEmitter } from "node:events";
import {
  WatcherRegistry,
  type WatchDirectory,
} from "../../../src/daemon/cache/watchers";

export function manualDirectoryWatches(refused = new Set<string>()) {
  const opened: Array<{
    path: string;
    recursive: boolean;
    changed: (name: string | null) => void;
    emitter: EventEmitter;
    closed: boolean;
  }> = [];
  const open: WatchDirectory = (path, recursive, changed) => {
    if (refused.has(path)) {
      throw Object.assign(
        new Error(`EMFILE: too many open files, watch '${path}'`),
        { code: "EMFILE" },
      );
    }
    const record = {
      path,
      recursive,
      changed,
      emitter: new EventEmitter(),
      closed: false,
    };
    opened.push(record);
    return Object.assign(record.emitter, {
      close: () => {
        record.closed = true;
      },
    });
  };
  return {
    open,
    opened,
    refused,
    opensOf: (directory: string) =>
      opened.filter((record) => record.path === directory),
    change(directory: string, name: string | null) {
      const listeners = opened.filter(
        (record) => !record.closed && record.path === directory,
      );
      if (!listeners.length) throw new Error(`No watch on ${directory}`);
      for (const listener of listeners) {
        if (name === null || listener.recursive || path.basename(name) === name)
          listener.changed(name);
      }
    },
  };
}

export function manualWatcherRegistry(
  clock: ConstructorParameters<typeof WatcherRegistry>[0]["clock"],
  events = manualDirectoryWatches(),
): WatcherRegistry {
  return new WatcherRegistry({ clock, watchDirectory: events.open });
}
