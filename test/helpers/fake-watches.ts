import { EventEmitter } from "node:events";
import type { WatchDirectory } from "../../src/daemon/cache/watchers";

export function manualDirectoryWatches(refused = new Set<string>()) {
  const opened: Array<{
    path: string;
    changed: (name: string | null) => void;
    emitter: EventEmitter;
    closed: boolean;
  }> = [];
  const open: WatchDirectory = (path, _recursive, changed) => {
    if (refused.has(path)) {
      throw Object.assign(
        new Error(`EMFILE: too many open files, watch '${path}'`),
        { code: "EMFILE" },
      );
    }
    const record = {
      path,
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
    change(directory: string, name: string | null) {
      const listeners = opened.filter(
        (record) => !record.closed && record.path === directory,
      );
      if (!listeners.length) throw new Error(`No watch on ${directory}`);
      for (const listener of listeners) listener.changed(name);
    },
  };
}
